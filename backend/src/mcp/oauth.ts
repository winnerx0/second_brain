import crypto from 'node:crypto';
import { db } from '../db/client.js';
import { connections } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { auth, discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { reinitializeMcpServer } from './mcp.js';

// Types for OAuth tokens and client info
export type OAuthTokens = {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
};

export type OAuthClientInformation = {
  client_id: string;
  client_secret?: string;
};

// In-memory storage for pending OAuth states (code verifiers, discovery state)
// Maps state param to stored context
const pendingOAuthStates = new Map<string, {
  connectionName: string;
  serverUrl: string;
  codeVerifier: string;
  discoveryState?: {
    authorizationServerUrl: string;
    resourceMetadataUrl?: string;
    resourceMetadata?: unknown;
    authorizationServerMetadata?: unknown;
  };
  expiresAt: number;
}>();

// Clean up expired states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingOAuthStates.entries()) {
    if (entry.expiresAt < now) pendingOAuthStates.delete(key);
  }
}, 5 * 60 * 1000);

// Global redirect URL configuration
const getRedirectUrl = () => {
  const base = process.env.OAUTH_REDIRECT_BASE_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/+$/, '')}/oauth/callback`;
};

/**
 * Database-backed OAuth provider for MCP connections.
 * Implements the OAuthClientProvider interface for the MCP SDK.
 */
export class DatabaseOAuthProvider implements OAuthClientProvider {
  private connectionName: string;
  private serverUrl: string;
  private redirectUrlStr: string;
  private clientMetadataObj: OAuthClientMetadata;

  constructor(config: {
    connectionName: string;
    serverUrl: string;
    redirectUrl?: string;
    clientMetadata: OAuthClientMetadata;
  }) {
    this.connectionName = config.connectionName;
    this.serverUrl = config.serverUrl;
    this.redirectUrlStr = config.redirectUrl ?? getRedirectUrl();
    this.clientMetadataObj = config.clientMetadata;
  }

  get redirectUrl() {
    return this.redirectUrlStr;
  }

  get clientMetadata() {
    return this.clientMetadataObj;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const [conn] = await db
      .select({
        accessToken: connections.accessToken,
        refreshToken: connections.refreshToken,
        tokenExpiry: connections.tokenExpiry,
        oauthConnected: connections.oauthConnected,
      })
      .from(connections)
      .where(eq(connections.name, this.connectionName))
      .limit(1);

    if (!conn?.oauthConnected || !conn.accessToken) {
      return undefined;
    }

    return {
      token_type: 'bearer',
      access_token: conn.accessToken,
      refresh_token: conn.refreshToken ?? undefined,
      expires_in: conn.tokenExpiry
        ? Math.floor((conn.tokenExpiry.getTime() - Date.now()) / 1000)
        : undefined,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const tokenExpiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    await db
      .update(connections)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenExpiry,
        oauthConnected: true,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(connections.name, this.connectionName));

    logger.info(`[mcp-oauth] Tokens saved for ${this.connectionName}`);
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const [conn] = await db
      .select({
        clientId: connections.clientId,
        clientSecret: connections.clientSecret,
      })
      .from(connections)
      .where(eq(connections.name, this.connectionName))
      .limit(1);

    if (conn?.clientId) {
      return {
        client_id: conn.clientId,
        client_secret: conn.clientSecret ?? undefined,
      };
    }

    return undefined;
  }

  async saveClientInformation(clientInfo: OAuthClientInformation): Promise<void> {
    await db
      .update(connections)
      .set({
        clientId: clientInfo.client_id,
        clientSecret: clientInfo.client_secret ?? null,
        updatedAt: new Date(),
      })
      .where(eq(connections.name, this.connectionName));

    logger.info(`[mcp-oauth] Client credentials saved for ${this.connectionName}`);
  }

  // State management for the OAuth flow
  async saveCodeVerifier(verifier: string): Promise<void> {
    // This is handled in startMcpOAuthFlow by storing in pendingOAuthStates
    logger.debug(`[mcp-oauth] Code verifier saved for ${this.connectionName}`);
  }

  codeVerifier(): string {
    // Retrieve from pendingOAuthStates based on current state param
    for (const [, entry] of pendingOAuthStates) {
      if (entry.connectionName === this.connectionName) {
        return entry.codeVerifier;
      }
    }
    return '';
  }

  async clearCodeVerifier(): Promise<void> {
    // Clean up pending states for this connection
    for (const [key, entry] of pendingOAuthStates.entries()) {
      if (entry.connectionName === this.connectionName) {
        pendingOAuthStates.delete(key);
      }
    }
  }

  async state(): Promise<string | undefined> {
    // Generate and return state, will be stored in pendingOAuthStates
    return crypto.randomBytes(32).toString('base64url');
  }

  async saveDiscoveryState(state: {
    authorizationServerUrl: string;
    resourceMetadataUrl?: string;
    resourceMetadata?: unknown;
    authorizationServerMetadata?: unknown;
  }): Promise<void> {
    for (const [, entry] of pendingOAuthStates) {
      if (entry.connectionName === this.connectionName) {
        entry.discoveryState = state;
        break;
      }
    }
    logger.debug(`[mcp-oauth] Discovery state saved for ${this.connectionName}`);
  }

  async discoveryState(): Promise<
    | {
        authorizationServerUrl: string;
        resourceMetadataUrl?: string;
        resourceMetadata?: unknown;
        authorizationServerMetadata?: unknown;
      }
    | undefined
  > {
    for (const [, entry] of pendingOAuthStates) {
      if (entry.connectionName === this.connectionName) {
        return entry.discoveryState;
      }
    }
    return undefined;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // In server context, we just log - the actual redirect is handled by the frontend
    logger.info(`[mcp-oauth] Authorization required: ${authorizationUrl.toString()}`);
  }

  // Invalidate credentials on auth errors
  async invalidateCredentials(type: 'tokens' | 'all'): Promise<void> {
    if (type === 'all') {
      await db
        .update(connections)
        .set({
          accessToken: null,
          refreshToken: null,
          tokenExpiry: null,
          clientId: null,
          clientSecret: null,
          oauthConnected: false,
          updatedAt: new Date(),
        })
        .where(eq(connections.name, this.connectionName));
    } else {
      await db
        .update(connections)
        .set({
          accessToken: null,
          refreshToken: null,
          tokenExpiry: null,
          oauthConnected: false,
          updatedAt: new Date(),
        })
        .where(eq(connections.name, this.connectionName));
    }
    logger.info(`[mcp-oauth] Credentials invalidated for ${this.connectionName}`);
  }
}

// MCP server URLs
const MCP_SERVER_URLS: Record<string, string> = {
  notion: 'https://mcp.notion.com/mcp',
};

/**
 * Start the MCP OAuth flow for a connection.
 * Returns the authorization URL for the frontend to redirect to.
 */
export async function startMcpOAuthFlow(
  connectionName: string,
): Promise<{ url: string; state: string } | { error: string }> {
  const serverUrl = MCP_SERVER_URLS[connectionName];
  if (!serverUrl) {
    return { error: `No MCP server URL configured for "${connectionName}"` };
  }

  const [conn] = await db
    .select({ id: connections.id, oauthConnected: connections.oauthConnected })
    .from(connections)
    .where(eq(connections.name, connectionName))
    .limit(1);

  if (!conn) {
    return { error: `Connection "${connectionName}" not found` };
  }

  try {
    // Create provider for this connection
    const provider = new DatabaseOAuthProvider({
      connectionName,
      serverUrl,
      clientMetadata: {
        client_name: 'aira',
        client_uri: process.env.APP_URL ?? 'http://localhost:3001',
        redirect_uris: [getRedirectUrl()],
      },
    });

    // Run discovery to get authorization server info
    const serverInfo = await discoverOAuthServerInfo(serverUrl);
    if (!serverInfo.authorizationServerMetadata) {
      return { error: 'Failed to discover OAuth server metadata' };
    }

    // Generate state and PKCE
    const state = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // Build authorization URL
    const authEndpoint = serverInfo.authorizationServerMetadata.authorization_endpoint;
    if (!authEndpoint) {
      return { error: 'Authorization server does not have an authorization endpoint' };
    }

    const authorizationUrl = new URL(authEndpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', (await provider.clientInformation())?.client_id ?? 'aira');
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('redirect_uri', getRedirectUrl());
    authorizationUrl.searchParams.set('state', state);

    // Store pending state
    pendingOAuthStates.set(state, {
      connectionName,
      serverUrl,
      codeVerifier,
      discoveryState: {
        authorizationServerUrl: serverInfo.authorizationServerUrl,
        resourceMetadataUrl: undefined,
        resourceMetadata: serverInfo.resourceMetadata,
        authorizationServerMetadata: serverInfo.authorizationServerMetadata,
      },
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    logger.info(`[mcp-oauth] Started OAuth flow for ${connectionName}`);
    return { url: authorizationUrl.toString(), state };
  } catch (err) {
    logger.error(`[mcp-oauth] Failed to start OAuth flow for ${connectionName}`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Complete the MCP OAuth flow with an authorization code.
 * This uses the MCP SDK's auth function to exchange the code and save tokens.
 */
export async function completeMcpOAuthFlow(
  code: string,
  state: string,
): Promise<{ connectionName: string } | { error: string }> {
  const pendingState = pendingOAuthStates.get(state);
  if (!pendingState) {
    return { error: 'Invalid or expired OAuth state' };
  }

  if (pendingState.expiresAt < Date.now()) {
    pendingOAuthStates.delete(state);
    return { error: 'OAuth state expired - please try again' };
  }

  const { connectionName, serverUrl, discoveryState } = pendingState;

  try {
    // Create provider with the stored discovery state
    const provider = new DatabaseOAuthProvider({
      connectionName,
      serverUrl,
      clientMetadata: {
        client_name: 'aira',
        client_uri: process.env.APP_URL ?? 'http://localhost:3001',
        redirect_uris: [getRedirectUrl()],
      },
    });

    // Restore discovery state to provider
    if (discoveryState) {
      await provider.saveDiscoveryState(discoveryState);
    }

    // Use the MCP SDK's auth function to complete the flow
    const result = await auth(provider, {
      serverUrl,
      authorizationCode: code,
    });

    if (result === 'AUTHORIZED') {
      logger.info(`[mcp-oauth] Successfully authorized ${connectionName}`);
      pendingOAuthStates.delete(state);

      // Reinitialize the MCP client so tools are available immediately
      try {
        await reinitializeMcpServer(connectionName);
        logger.info(`[mcp-oauth] MCP client reinitialized for ${connectionName}`);
      } catch (reinitErr) {
        logger.warn(
          `[mcp-oauth] Failed to reinitialize MCP client for ${connectionName}:`,
          reinitErr,
        );
        // Don't fail the OAuth flow if reinitialization fails - tools will be
        // available on next request
      }

      return { connectionName };
    } else {
      return { error: 'Authorization did not complete' };
    }
  } catch (err) {
    logger.error(`[mcp-oauth] Failed to complete OAuth flow for ${connectionName}`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check if a connection uses MCP OAuth (vs traditional OAuth)
 */
export function usesMcpOAuth(connectionName: string): boolean {
  return connectionName in MCP_SERVER_URLS;
}

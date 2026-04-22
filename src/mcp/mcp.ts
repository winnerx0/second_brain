import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { logger } from '../logger.ts';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { DatabaseOAuthProvider } from './oauth.ts';

const redirectUrl = process.env.OAUTH_REDIRECT_BASE_URL
  ? `${process.env.OAUTH_REDIRECT_BASE_URL.replace(/\/$/, '')}/oauth/callback`
  : 'http://localhost:3000/oauth/callback';

// MCP server configurations
const MCP_SERVERS: Record<
  string,
  { url: string; transport: 'http' | 'stdio' }
> = {
  notion: {
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
  },
};

// Track initialization state per server
const serverInitialized = new Map<string, boolean>();
let mcpClient: MultiServerMCPClient | null = null;

/**
 * Create the MCP client configuration for all supported servers
 */
function createMcpClientConfig(): Record<
  string,
  { transport: 'http' | 'stdio'; url: string; authProvider: OAuthClientProvider }
> {
  const config: Record<
    string,
    { transport: 'http' | 'stdio'; url: string; authProvider: OAuthClientProvider }
  > = {};

  for (const [name, serverConfig] of Object.entries(MCP_SERVERS)) {
    config[name] = {
      ...serverConfig,
      authProvider: new DatabaseOAuthProvider({
        connectionName: name,
        serverUrl: serverConfig.url,
        redirectUrl,
        clientMetadata: {
          client_name: 'aira',
          client_uri: process.env.APP_URL ?? 'http://localhost:3001',
          redirect_uris: [redirectUrl],
        },
      }),
    };
  }

  return config;
}

/**
 * Get or create the MCP client instance
 */
function getMcpClient(): MultiServerMCPClient {
  if (!mcpClient) {
    mcpClient = new MultiServerMCPClient(createMcpClientConfig());
  }
  return mcpClient;
}

/**
 * Get tools from the Notion MCP server.
 * Initializes the connection if not already done.
 */
export async function getNotionMcpTools() {
  const client = getMcpClient();
  const serverName = 'notion';

  if (!serverInitialized.get(serverName)) {
    await client.initializeConnections();
    serverInitialized.set(serverName, true);
    logger.info('[mcp] Notion MCP server connected');
  }

  const tools = await client.getTools(serverName);
  logger.info(`[mcp] Got ${tools.length} tools from Notion`);
  return tools;
}

/**
 * Reinitialize a specific MCP server connection.
 * Call this after OAuth credentials are updated.
 */
export async function reinitializeMcpServer(serverName: string): Promise<void> {
  if (!MCP_SERVERS[serverName]) {
    logger.warn(`[mcp] Unknown server: ${serverName}`);
    return;
  }

  const client = getMcpClient();

  // Mark server as not initialized
  serverInitialized.set(serverName, false);

  try {
    // Try to get the client for this server to check connection
    const serverClient = await client.getClient(serverName);
    if (serverClient) {
      // Close this specific connection if possible
      logger.info(`[mcp] Closing existing connection for ${serverName}`);
    }

    // Re-initialize connections - the SDK will use the new credentials from the provider
    await client.initializeConnections();
    serverInitialized.set(serverName, true);

    // Verify we can get tools
    const tools = await client.getTools(serverName);
    logger.info(
      `[mcp] ${serverName} reinitialized successfully with ${tools.length} tools`,
    );
  } catch (err) {
    logger.error(`[mcp] Failed to reinitialize ${serverName}:`, err);
    throw err;
  }
}

/**
 * Reinitialize all MCP servers.
 * Call this after OAuth credentials are updated for any connection.
 */
export async function reinitializeAllMcpServers(): Promise<void> {
  for (const serverName of Object.keys(MCP_SERVERS)) {
    try {
      await reinitializeMcpServer(serverName);
    } catch (err) {
      logger.error(`[mcp] Failed to reinitialize ${serverName}:`, err);
      // Continue with other servers
    }
  }
}

/**
 * Close the MCP client and clean up resources
 */
export async function closeMcpClient() {
  if (mcpClient) {
    await mcpClient.close();
    mcpClient = null;
    serverInitialized.clear();
    logger.info('[mcp] MCP client closed');
  }
}

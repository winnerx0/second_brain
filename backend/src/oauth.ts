import crypto from 'node:crypto';
import { db } from './db/client.js';
import { connections } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from './logger.js';

type OAuthConfig = {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  extra?: Record<string, string>;
  basicAuth?: boolean;
  pkce?: boolean;
};

export const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'user'],
    clientIdEnv: 'GITHUB_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GITHUB_OAUTH_CLIENT_SECRET',
  },
  gmail: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  google_calendar: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar'],
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  google_docs: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive',
    ],
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  notion: {
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    clientIdEnv: 'NOTION_OAUTH_CLIENT_ID',
    clientSecretEnv: 'NOTION_OAUTH_CLIENT_SECRET',
    basicAuth: true,
  },
  spotify: {
    authUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    scopes: [
      'user-read-playback-state',
      'user-modify-playback-state',
      'playlist-read-private',
      'user-library-read',
      'user-read-recently-played',
    ],
    clientIdEnv: 'SPOTIFY_OAUTH_CLIENT_ID',
    clientSecretEnv: 'SPOTIFY_OAUTH_CLIENT_SECRET',
  },
  twitter: {
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    clientIdEnv: 'TWITTER_OAUTH_CLIENT_ID',
    clientSecretEnv: 'TWITTER_OAUTH_CLIENT_SECRET',
    pkce: true,
  },
  anilist: {
    authUrl: 'https://anilist.co/api/v2/oauth/authorize',
    tokenUrl: 'https://anilist.co/api/v2/oauth/token',
    scopes: [],
    clientIdEnv: 'ANILIST_OAUTH_CLIENT_ID',
    clientSecretEnv: 'ANILIST_OAUTH_CLIENT_SECRET',
  },
  todoist: {
    authUrl: 'https://todoist.com/oauth/authorize',
    tokenUrl: 'https://todoist.com/oauth/access_token',
    scopes: ['data:read_write'],
    clientIdEnv: 'TODOIST_OAUTH_CLIENT_ID',
    clientSecretEnv: 'TODOIST_OAUTH_CLIENT_SECRET',
  },
};

type StateEntry = {
  connectionName: string;
  codeVerifier?: string;
  expiresAt: number;
};

const pendingStates = new Map<string, StateEntry>();

// check and delete unused states every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of pendingStates.entries()) {
      if (entry.expiresAt < now) pendingStates.delete(key);
    }
  },
  5 * 60 * 1000,
);

export function getRedirectUri(): string {
  const base = process.env.OAUTH_REDIRECT_BASE_URL ?? 'http://localhost:80';
  return `${base.replace(/\/$/, '')}/oauth/callback`;
}

export function getAppUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

export function buildAuthUrl(
  connectionName: string,
): { url: string } | { error: string } {
  const cfg = OAUTH_CONFIGS[connectionName];
  if (!cfg) return { error: `No OAuth config for "${connectionName}"` };

  const clientId = process.env[cfg.clientIdEnv];
  if (!clientId) return { error: `${cfg.clientIdEnv} is not configured` };

  const state = crypto.randomBytes(16).toString('hex');
  const entry: StateEntry = {
    connectionName,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    state,
  });

  if (cfg.scopes.length > 0) params.set('scope', cfg.scopes.join(' '));
  if (cfg.extra) {
    for (const [k, v] of Object.entries(cfg.extra)) params.set(k, v);
  }

  if (cfg.pkce) {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
    entry.codeVerifier = codeVerifier;
  }

  pendingStates.set(state, entry);
  return { url: `${cfg.authUrl}?${params.toString()}` };
}

export async function handleCallback(
  code: string,
  state: string,
): Promise<{ connectionName: string } | { error: string }> {
  const entry = pendingStates.get(state);
  if (!entry) return { error: 'Invalid or expired OAuth state' };
  if (entry.expiresAt < Date.now()) {
    pendingStates.delete(state);
    return { error: 'OAuth state expired — please try again' };
  }
  pendingStates.delete(state);

  const { connectionName, codeVerifier } = entry;
  const cfg = OAUTH_CONFIGS[connectionName];
  if (!cfg) return { error: `No config for "${connectionName}"` };

  const clientId = process.env[cfg.clientIdEnv] ?? '';
  const clientSecret = process.env[cfg.clientSecretEnv] ?? '';

  const body = new URLSearchParams({
    code,
    redirect_uri: getRedirectUri(),
    grant_type: 'authorization_code',
  });

  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (cfg.basicAuth) {
    headers['Authorization'] =
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  try {
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok || data.error) {
      logger.error(`[oauth] token exchange failed for ${connectionName}`, data);
      return {
        error: String(
          data.error_description ?? data.error ?? 'Token exchange failed',
        ),
      };
    }

    const accessToken = String(data.access_token ?? '');
    const refreshToken =
      typeof data.refresh_token === 'string' ? data.refresh_token : null;
    const expiresIn =
      typeof data.expires_in === 'number' ? data.expires_in : null;
    const tokenExpiry = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

    await db
      .update(connections)
      .set({
        accessToken,
        refreshToken,
        tokenExpiry,
        oauthConnected: true,
        enabled: true,
        updatedAt: new Date(),
      })
      .where(eq(connections.name, connectionName));

    logger.info(`[oauth] ${connectionName} connected`);
    return { connectionName };
  } catch (err) {
    logger.error(`[oauth] callback error for ${connectionName}`, err);
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getValidToken(
  connectionName: string,
): Promise<string | null> {
  const [conn] = await db
    .select({
      accessToken: connections.accessToken,
      refreshToken: connections.refreshToken,
      tokenExpiry: connections.tokenExpiry,
    })
    .from(connections)
    .where(eq(connections.name, connectionName));

  if (!conn?.accessToken) return null;

  const needsRefresh =
    conn.refreshToken &&
    conn.tokenExpiry &&
    conn.tokenExpiry.getTime() - Date.now() < 60_000;

  if (!needsRefresh) return conn.accessToken;

  const cfg = OAUTH_CONFIGS[connectionName];
  if (!cfg) return conn.accessToken;

  const clientId = process.env[cfg.clientIdEnv] ?? '';
  const clientSecret = process.env[cfg.clientSecretEnv] ?? '';

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: conn.refreshToken!,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (cfg.basicAuth) {
    headers['Authorization'] = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  try {
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok || data.error) {
      logger.error(`[oauth] token refresh failed for ${connectionName}`, data);
      return conn.accessToken;
    }

    const accessToken = String(data.access_token ?? '');
    const newRefreshToken =
      typeof data.refresh_token === 'string'
        ? data.refresh_token
        : conn.refreshToken;
    const expiresIn =
      typeof data.expires_in === 'number' ? data.expires_in : null;
    const tokenExpiry = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

    await db
      .update(connections)
      .set({ accessToken, refreshToken: newRefreshToken, tokenExpiry, updatedAt: new Date() })
      .where(eq(connections.name, connectionName));

    logger.info(`[oauth] ${connectionName} token refreshed`);
    return accessToken;
  } catch (err) {
    logger.error(`[oauth] refresh error for ${connectionName}`, err);
    return conn.accessToken;
  }
}

export async function getDbRefreshToken(
  connectionName: string,
): Promise<string | null> {
  const [conn] = await db
    .select({ refreshToken: connections.refreshToken })
    .from(connections)
    .where(eq(connections.name, connectionName));
  return conn?.refreshToken ?? null;
}

export async function disconnectOAuth(connectionName: string): Promise<void> {
  await db
    .update(connections)
    .set({
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      oauthConnected: false,
      updatedAt: new Date(),
    })
    .where(eq(connections.name, connectionName));
  logger.info(`[oauth] ${connectionName} disconnected`);
}

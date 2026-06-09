import { google } from 'googleapis';
import { config } from '../config.js';
import { getRedirectUri } from '../oauth.js';

export function createGoogleOAuthClient() {
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID ?? config.GOOGLE_CLIENT_ID;
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? config.GOOGLE_CLIENT_SECRET;

  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

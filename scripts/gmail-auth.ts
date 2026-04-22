/**
 * Run once to get a Gmail refresh token:
 *   npx tsx scripts/gmail-auth.ts
 *
 * Then copy the printed GMAIL_REFRESH_TOKEN into your .env file.
 * The redirect URI must be registered in your Google Cloud Console as:
 *   http://localhost:4242/oauth2callback
 */

import { createServer } from 'http';
import { google } from 'googleapis';
import 'dotenv/config';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:4242/oauth2callback';
const PORT = 4242;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for callback on http://localhost:4242 ...\n');

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`OAuth error: ${error ?? 'no code returned'}`);
    server.close();
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Done! You can close this tab.</h2>');

    console.log('✓ Token received. Add this to your .env:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    if (!tokens.refresh_token) {
      console.warn(
        'Warning: no refresh_token returned. This usually means the account\n' +
          'already has an active grant. Revoke access at https://myaccount.google.com/permissions\n' +
          'and re-run this script to force a new token.\n',
      );
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Token exchange failed: ${err}`);
    console.error('Token exchange failed:', err);
  }

  server.close();
});

server.listen(PORT);

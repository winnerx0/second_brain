/**
 * One-time script to get a Gmail OAuth2 refresh token.
 *
 * Prerequisites:
 *   1. In Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 client,
 *      add "http://localhost" to Authorized redirect URIs and save.
 *   2. Make sure Gmail API is enabled in your project.
 *
 * Run: bun run scripts/gmail-auth.ts
 */

import { google } from "googleapis";
import * as readline from "readline";
import { env } from "bun";

const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, "http://localhost:3000");

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/gmail.modify"],
  prompt: "consent", // forces refresh_token to be returned every time
});

console.log("\n1. Open this URL in your browser:\n");
console.log(authUrl);
console.log(
  "\n2. Authorize the app. Your browser will redirect to http://localhost:3000?code=... " +
  "(it'll show a connection error — that's fine).\n" +
  "3. Copy the full URL from your browser's address bar and paste it here:\n",
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("> ", async (input) => {
  rl.close();
  try {
    let code = input.trim();

    // Accept either full redirect URL or just the code
    if (code.startsWith("http")) {
      const url = new URL(code);
      code = url.searchParams.get("code") ?? code;
    }

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token returned. This usually means the app was already authorized.\n" +
        "Go to https://myaccount.google.com/permissions, revoke access for this app, then run this script again.",
      );
      process.exit(1);
    }

    console.log("\nSuccess! Add this to your .env:\n");
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\nDone.");
  } catch (error) {
    console.error("Failed to exchange code for token:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
});

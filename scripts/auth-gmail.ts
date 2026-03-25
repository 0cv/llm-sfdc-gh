/**
 * One-time script to obtain a Gmail OAuth2 refresh token.
 *
 * Run once locally:
 *   npm run auth-gmail
 *
 * Then store the printed refresh token as:
 *   - GMAIL_REFRESH_TOKEN in .env (local dev)
 *   - Cloud Run secret GMAIL_REFRESH_TOKEN (production)
 *
 * In GCP Console, ensure http://localhost:4242 is listed as an
 * authorized redirect URI on your OAuth2 client.
 */

import "dotenv/config";
import { google } from "googleapis";
import * as http from "node:http";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:4242";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first");
  process.exit(1);
}

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const url = auth.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/gmail.readonly"],
  prompt: "consent",
});

console.log("\nOpening browser for Gmail authorization...");
console.log("If it doesn't open, visit this URL manually:\n");
console.log(url, "\n");

// Open browser automatically
const { exec } = await import("node:child_process");
exec(`open "${url}"`);

// Wait for OAuth callback on localhost:4242
const code = await new Promise<string>((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const params = new URL(req.url!, "http://localhost:4242").searchParams;
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      res.end(`<h2>Error: ${error}</h2><p>You can close this tab.</p>`);
      server.close();
      reject(new Error(`OAuth error: ${error}`));
      return;
    }

    if (code) {
      res.end("<h2>✅ Authorized!</h2><p>You can close this tab and return to the terminal.</p>");
      server.close();
      resolve(code);
    }
  });

  server.listen(4242, () => {
    console.log("Waiting for authorization callback on http://localhost:4242 ...\n");
  });

  server.on("error", reject);
});

const { tokens } = await auth.getToken(code);

console.log("✅ Add this to your .env and Cloud Run secrets:\n");
console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);

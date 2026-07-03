// One-time helper to capture a Google OAuth refresh token for the
// Business Profile API (scope: business.manage).
//
// Run it locally (NOT in CI), signed in as the account that OWNS the
// business listing:
//
//   GOOGLE_OAUTH_CLIENT_ID="...apps.googleusercontent.com" \
//   GOOGLE_OAUTH_CLIENT_SECRET="..." \
//   node scripts/get-refresh-token.mjs
//
// It opens a consent page in your browser. Approve as the OWNER account.
// The script then prints a refresh_token — store that as a secret (Vercel
// env / GitHub secret). You only need to do this once.

import http from "node:http";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/business.manage";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars first."
  );
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force a fresh refresh token every run
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    res.end(`Authorization failed: ${err}. You can close this tab.`);
    console.error("Authorization error:", err);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.end("Waiting for authorization…");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();

    res.end("Done! Refresh token captured. You can close this tab and return to the terminal.");
    server.close();

    if (!data.refresh_token) {
      console.error("\nNo refresh_token returned. Full response:", data);
      console.error(
        "\nTip: revoke prior access at https://myaccount.google.com/permissions and rerun."
      );
      process.exit(1);
    }

    console.log("\n========================================");
    console.log("REFRESH TOKEN (store this as a secret):\n");
    console.log(data.refresh_token);
    console.log("\n========================================");
    process.exit(0);
  } catch (e) {
    res.end("Token exchange failed. Check the terminal.");
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nOpen this URL in your browser (signed in as the OWNER account):\n`);
  console.log(authUrl + "\n");
  // Best-effort auto-open on macOS.
  exec(`open "${authUrl}"`, () => {});
});

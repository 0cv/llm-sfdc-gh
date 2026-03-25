import { env } from "node:process";

export const config = {
  port: parseInt(env.PORT || "3000"),

  // Gmail OAuth2 (Cloud Run / production)
  // Obtain credentials from GCP Console → APIs & Services → Credentials
  // Run: npm run auth-gmail  to get the refresh token
  gmailClientId: env.GMAIL_CLIENT_ID || "",
  gmailClientSecret: env.GMAIL_CLIENT_SECRET || "",
  gmailRefreshToken: env.GMAIL_REFRESH_TOKEN || "",
  // Format: projects/<gcp-project-id>/topics/sf-errors
  gmailPubsubTopic: env.GMAIL_PUBSUB_TOPIC || "",

  // Admin endpoints (e.g. /admin/renew-watch called by Cloud Scheduler)
  adminSecret: env.ADMIN_SECRET || "",

  // GitHub PAT — needs contents + pull-requests write on all repos in routing.json
  githubToken: env.GITHUB_TOKEN || "",

  dedupTtlHours: parseInt(env.DEDUP_TTL_HOURS || "24"),
} as const;

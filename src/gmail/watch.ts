/**
 * Gmail watch() renewal — shared between the admin endpoint and the local script.
 */

import { google } from "googleapis";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export async function renewGmailWatch(): Promise<{ historyId: string; expiration: string }> {
  if (!config.gmailPubsubTopic) {
    throw new Error("GMAIL_PUBSUB_TOPIC is not configured");
  }

  const auth = new google.auth.OAuth2(config.gmailClientId, config.gmailClientSecret);
  auth.setCredentials({ refresh_token: config.gmailRefreshToken });

  const gmail = google.gmail({ version: "v1", auth });

  const result = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: config.gmailPubsubTopic,
      labelIds: ["INBOX"],
    },
  });

  const historyId = String(result.data.historyId);
  const expiration = new Date(Number(result.data.expiration)).toISOString();

  logger.info({ historyId, expiration }, "Gmail watch renewed");

  return { historyId, expiration };
}

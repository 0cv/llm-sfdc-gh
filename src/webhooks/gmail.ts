/**
 * Gmail Pub/Sub webhook handler.
 *
 * Gmail pushes a notification when new mail arrives.
 * The notification only contains a historyId — we fetch the actual email via Gmail API.
 * Recipient headers are used to route the error to the correct GitHub repo.
 */

import type { Request, Response } from "express";
import { google } from "googleapis";
import { readFile } from "node:fs/promises";
import { parseSalesforceExceptionEmail } from "../email/parser.js";
import { isDuplicate } from "../dedup/index.js";
import { triageError } from "../triage/classifier.js";
import { dispatchSalesforceError } from "../github/dispatch.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

// Track history and message IDs while this Cloud Run worker is warm.
let lastHistoryId: string | null = null;
const processedMessageIds = new Map<string, number>();
const MESSAGE_TTL_MS = config.dedupTtlHours * 60 * 60 * 1000;

// Routing table: +tag → GitHub repo (e.g. "dropbox" → "0cv/dropbox-dev")
let routing: Record<string, string> = {};
readFile(new URL("../../routing.json", import.meta.url), "utf-8")
  .then((raw) => {
    routing = JSON.parse(raw);
  })
  .catch(() => logger.warn("routing.json not found — all emails will be skipped"));

/**
 * POST /webhooks/gmail
 * Receives Pub/Sub push notifications from Gmail.
 */
export async function gmailWebhookHandler(req: Request, res: Response): Promise<void> {
  try {
    const pubsubMessage = req.body?.message;
    if (!pubsubMessage?.data) {
      res.status(400).send("No Pub/Sub message");
      return;
    }

    const data = JSON.parse(Buffer.from(pubsubMessage.data, "base64").toString());
    const { historyId } = data;

    logger.info({ historyId }, "Gmail Pub/Sub notification received");

    const previousHistoryId = lastHistoryId;
    lastHistoryId = String(historyId);

    if (previousHistoryId) {
      const processed = await fetchAndRoute(previousHistoryId);
      if (processed === 0) {
        logger.warn(
          { historyId, previousHistoryId },
          "No Gmail history messages found; scanning recent mail"
        );
        await fetchRecentAndRoute();
      }
    } else {
      logger.warn({ historyId }, "No previous Gmail historyId available; scanning recent mail");
      await fetchRecentAndRoute();
    }

    res.status(200).send("OK");
  } catch (err) {
    logger.error(err, "Gmail webhook error");
    if (!res.headersSent) {
      res.status(200).send("OK"); // Always ack to prevent retry storms
    }
  }
}

async function fetchAndRoute(startHistoryId: string): Promise<number> {
  const auth = getGmailAuth();
  const gmail = google.gmail({ version: "v1", auth });

  let history;
  try {
    history = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
    });
  } catch (err) {
    logger.warn({ err, startHistoryId }, "Failed to fetch Gmail history; scanning recent mail");
    return 0;
  }

  const messageIds =
    history.data.history?.flatMap(
      (h) => h.messagesAdded?.map((m) => m.message?.id).filter(Boolean) ?? []
    ) ?? [];

  let processed = 0;
  for (const msgId of messageIds) {
    if (!msgId) continue;
    await fetchAndRouteMessage(gmail, msgId);
    processed++;
  }

  return processed;
}

async function fetchRecentAndRoute(): Promise<void> {
  const auth = getGmailAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const newerThanDays = Math.max(1, config.gmailFallbackLookbackDays);
  const maxResults = Math.max(1, config.gmailFallbackMaxMessages);

  const messages = await gmail.users.messages.list({
    userId: "me",
    includeSpamTrash: true,
    maxResults,
    q: `newer_than:${newerThanDays}d`,
  });

  const messageIds = messages.data.messages?.map((message) => message.id).filter(Boolean) ?? [];
  logger.info(
    { count: messageIds.length, newerThanDays, maxResults },
    "Scanning recent Gmail messages"
  );

  for (const msgId of messageIds) {
    if (!msgId) continue;
    await fetchAndRouteMessage(gmail, msgId);
  }
}

async function fetchAndRouteMessage(
  gmail: ReturnType<typeof google.gmail>,
  msgId: string
): Promise<void> {
  if (isProcessedMessage(msgId)) {
    logger.info({ msgId }, "Gmail message already processed in this worker, skipping");
    return;
  }

  const msg = await gmail.users.messages.get({
    userId: "me",
    id: msgId,
    format: "full",
  });

  const headers = msg.data.payload?.headers ?? [];
  const subject = headerValue(headers, "subject");
  const recipients = recipientHeaders(headers);
  const body = decodeMessageBody(msg.data.payload ?? {});

  // Resolve target repo from +tag in recipient headers
  const targetRepo = resolveRepo(recipients);
  if (!targetRepo) {
    logger.warn({ msgId, recipients }, "No routing match for recipient address, skipping");
    return;
  }

  const sfError = parseSalesforceExceptionEmail(subject, body);
  if (!sfError) {
    logger.info({ msgId, subject }, "Email is not a supported Salesforce error, skipping");
    return;
  }

  logger.info({ exceptionType: sfError.exceptionType, targetRepo }, "SF exception detected");

  if (isDuplicate(sfError.fingerprint)) {
    logger.info({ fingerprint: sfError.fingerprint }, "Duplicate, skipping");
    return;
  }

  // Triage: skip operational noise (governor limits, lock contention, timeouts)
  const triage = await triageError(sfError);
  if (!triage.isCodeBug) {
    logger.info(
      { reason: triage.reason, fingerprint: sfError.fingerprint },
      "Operational error, skipping dispatch"
    );
    return;
  }

  try {
    await dispatchSalesforceError(sfError, targetRepo);
  } catch (err) {
    logger.error(err, "Dispatch failed");
  }
}

function isProcessedMessage(msgId: string): boolean {
  const now = Date.now();
  for (const [key, ts] of processedMessageIds) {
    if (now - ts > MESSAGE_TTL_MS) processedMessageIds.delete(key);
  }

  if (processedMessageIds.has(msgId)) return true;
  processedMessageIds.set(msgId, now);
  return false;
}

/**
 * Extract +tag from To: address and look up in routing table.
 * e.g. "salesforceerrors+dropbox@gmail.com" → "0cv/dropbox-dev"
 */
function resolveRepo(recipients: string): string | null {
  const match = recipients.match(/\+([^@>\s]+)@/);
  const tag = match?.[1]?.toLowerCase();
  if (!tag) return null;
  return routing[tag] ?? null;
}

interface GmailPayload {
  mimeType?: string | null;
  body?: { data?: string | null };
  parts?: GmailPayload[];
}

function decodeMessageBody(payload: GmailPayload): string {
  const plain = findMessagePart(payload, "text/plain");
  if (plain) return decodeBodyData(plain);

  const html = findMessagePart(payload, "text/html");
  if (html) return stripHtml(decodeBodyData(html));

  if (payload?.body?.data) {
    return decodeBodyData(payload.body.data);
  }

  return "";
}

function findMessagePart(payload: GmailPayload, mimeType: string): string | null {
  if (payload.mimeType === mimeType && payload.body?.data) {
    return payload.body.data;
  }

  const parts = payload.parts ?? [];
  for (const part of parts) {
    const data = findMessagePart(part, mimeType);
    if (data) return data;
  }

  return null;
}

function decodeBodyData(data: string): string {
  return Buffer.from(data, "base64url").toString();
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string
): string {
  return headers.find((h) => h.name?.toLowerCase() === name)?.value ?? "";
}

function recipientHeaders(headers: Array<{ name?: string | null; value?: string | null }>): string {
  return ["to", "cc", "delivered-to", "x-original-to"]
    .map((name) => headerValue(headers, name))
    .filter(Boolean)
    .join(", ");
}

function getGmailAuth() {
  const auth = new google.auth.OAuth2(config.gmailClientId, config.gmailClientSecret);
  auth.setCredentials({ refresh_token: config.gmailRefreshToken });
  return auth;
}

/**
 * Gmail Pub/Sub webhook handler.
 *
 * Gmail pushes a notification when new mail arrives.
 * The notification only contains a historyId — we fetch the actual email via Gmail API.
 * The To: header is used to route the error to the correct GitHub repo.
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

// Track the last processed historyId across requests (in-memory, sufficient for Cloud Run)
let lastHistoryId: string | null = null;

// Routing table: +tag → GitHub repo (e.g. "dropbox" → "0cv/dropbox-dev")
let routing: Record<string, string> = {};
readFile(new URL("../../../routing.json", import.meta.url), "utf-8")
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

    // Ack immediately — Pub/Sub will retry if we don't respond within 10s
    res.status(200).send("OK");

    if (lastHistoryId) {
      await fetchAndRoute(lastHistoryId);
    }
    lastHistoryId = String(historyId);
  } catch (err) {
    logger.error(err, "Gmail webhook error");
    res.status(200).send("OK"); // Always ack to prevent retry storms
  }
}

async function fetchAndRoute(startHistoryId: string): Promise<void> {
  const auth = getGmailAuth();
  const gmail = google.gmail({ version: "v1", auth });

  const history = await gmail.users.history.list({
    userId: "me",
    startHistoryId,
    historyTypes: ["messageAdded"],
  });

  const messageIds =
    history.data.history?.flatMap(
      (h) => h.messagesAdded?.map((m) => m.message?.id).filter(Boolean) ?? []
    ) ?? [];

  for (const msgId of messageIds) {
    if (!msgId) continue;

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "full",
    });

    const headers = msg.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
    const to = headers.find((h) => h.name?.toLowerCase() === "to")?.value ?? "";
    const body = decodeMessageBody(msg.data.payload ?? {});

    // Resolve target repo from +tag in To: address
    const targetRepo = resolveRepo(to);
    if (!targetRepo) {
      logger.warn({ to }, "No routing match for To: address, skipping");
      continue;
    }

    const sfError = parseSalesforceExceptionEmail(subject, body);
    if (!sfError) continue;

    logger.info({ exceptionType: sfError.exceptionType, targetRepo }, "SF exception detected");

    if (isDuplicate(sfError.fingerprint)) {
      logger.info({ fingerprint: sfError.fingerprint }, "Duplicate, skipping");
      continue;
    }

    // Triage: skip operational noise (governor limits, lock contention, timeouts)
    const triage = await triageError(sfError);
    if (!triage.isCodeBug) {
      logger.info(
        { reason: triage.reason, fingerprint: sfError.fingerprint },
        "Operational error, skipping dispatch"
      );
      continue;
    }

    dispatchSalesforceError(sfError, targetRepo).catch((err) =>
      logger.error(err, "Dispatch failed")
    );
  }
}

/**
 * Extract +tag from To: address and look up in routing table.
 * e.g. "salesforceerrors+dropbox@gmail.com" → "0cv/dropbox-dev"
 */
function resolveRepo(toAddress: string): string | null {
  const match = toAddress.match(/\+([^@]+)@/);
  const tag = match?.[1]?.toLowerCase();
  if (!tag) return null;
  return routing[tag] ?? null;
}

interface GmailPayload {
  body?: { data?: string | null };
  parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } }>;
}

function decodeMessageBody(payload: GmailPayload): string {
  if (payload?.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString();
  }
  const parts = payload?.parts ?? [];
  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString();
    }
  }
  return "";
}

function getGmailAuth() {
  const auth = new google.auth.OAuth2(config.gmailClientId, config.gmailClientSecret);
  auth.setCredentials({ refresh_token: config.gmailRefreshToken });
  return auth;
}

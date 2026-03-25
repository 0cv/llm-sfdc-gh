/**
 * Dispatches a repository_dispatch event to GitHub, triggering a workflow.
 */

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SalesforceError } from "../email/parser.js";

export async function dispatchSalesforceError(
  error: SalesforceError,
  targetRepo: string
): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${targetRepo}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "salesforce-error",
      client_payload: {
        exceptionType: error.exceptionType,
        errorMessage: error.message,
        apexClass: error.apexClass ?? "",
        lineNumber: String(error.lineNumber ?? ""),
        stackTrace: error.stackTrace,
        rawBody: error.rawBody,
        fingerprint: error.fingerprint,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${body}`);
  }

  logger.info({ targetRepo, exceptionType: error.exceptionType }, "Dispatched to GitHub Actions");
}

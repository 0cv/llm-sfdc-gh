/**
 * Dispatches a repository_dispatch event to GitHub, triggering a workflow.
 */

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SalesforceError } from "../email/parser.js";
import { findOpenPullRequestByTitle } from "./pulls.js";

export function fixPullRequestTitle(error: SalesforceError): string {
  return `fix: ${error.exceptionType} in ${error.apexClass ?? error.triggerName ?? "Unknown"}`;
}

export async function dispatchSalesforceError(
  error: SalesforceError,
  targetRepo: string
): Promise<void> {
  const prTitle = fixPullRequestTitle(error);
  const existingPr = await findOpenPullRequestByTitle(targetRepo, prTitle);
  if (existingPr) {
    logger.info(
      { targetRepo, title: prTitle, pr: existingPr.url },
      "Open PR already exists for this error, skipping dispatch"
    );
    return;
  }

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
        subject: error.subject,
        orgName: error.orgName,
        exceptionType: error.exceptionType,
        errorMessage: error.message,
        apexClass: error.apexClass ?? "",
        triggerName: error.triggerName ?? "",
        triggerOperation: error.triggerOperation ?? "",
        lineNumber: String(error.lineNumber ?? ""),
        stackTrace: error.stackTrace,
        rawBody: error.rawBody,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${body}`);
  }

  logger.info(
    { targetRepo, exceptionType: error.exceptionType, prTitle },
    "Dispatched to GitHub Actions"
  );
}

/**
 * Runner script executed by the iterate-from-review GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { waitForPullRequestValidation, type PullRequestValidation } from "../github/checks.js";
import { buildPrContext } from "../github/context.js";
import { actionsRunUrl, postIssueComment } from "../github/issues.js";
import { getPullRequestBody, updatePullRequestBody } from "../github/pulls.js";
import {
  isAutomationAuthoredComment,
  PR_ITERATION_COMMENT_MARKER,
  PR_ITERATION_HISTORY_MARKER,
} from "../github/automation.js";
import { logger } from "../utils/logger.js";
import { requireEnv } from "./base.js";

requireEnv("PR_NUMBER", "GITHUB_REPOSITORY");

const {
  PR_NUMBER = "",
  PR_TITLE = "",
  COMMENT_BODY = "",
  COMMENT_AUTHOR = "",
  GITHUB_REPOSITORY = "",
} = process.env;

if (isAutomationAuthoredComment(COMMENT_BODY)) {
  logger.info({ pr: PR_NUMBER, author: COMMENT_AUTHOR }, "Ignoring automated PR update comment");
  process.exit(0);
}

// Build full PR context: linked issue → PR description → review history → conversation
const prContext = await buildPrContext(GITHUB_REPOSITORY, PR_NUMBER);

// COMMENT_BODY is the triggering event (may be empty if review had no summary text).
// The inline comments are already captured in prContext via the reviews API.
// We only fail if there is genuinely no feedback at all.
if (!COMMENT_BODY && !prContext.trim()) {
  logger.error("No review feedback found");
  process.exit(1);
}

const model = await pickModel(
  `PR review feedback:\n${COMMENT_BODY}\n\n${prContext.slice(0, 1000)}`
);

const result = await runClaudeSession(
  "iterate-review",
  {
    PR_NUMBER,
    PR_TITLE,
    REPO_FULL_NAME: GITHUB_REPOSITORY,
    COMMENT_AUTHOR,
    COMMENT_BODY: COMMENT_BODY || "(see inline comments in history below)",
    PR_CONTEXT: prContext,
    SF_TARGET_ORG: "pipeline-org",
  },
  model,
  {
    summaryMaxChars: 8000,
  }
);

function extractIterationSummary(summary: string): string {
  const match = summary.match(/ITERATION_SUMMARY:\s*([\s\S]+)/i);
  const text = (match?.[1] ?? summary).trim();
  return text || "Addressed feedback and pushed updates.";
}

function summarizeFeedback(feedback: string): string {
  const normalized = feedback.replace(/\s+/g, " ").trim();
  if (!normalized) return "(see PR history)";
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function appendIterationHistory(body: string, entry: string): string {
  const marker = PR_ITERATION_HISTORY_MARKER;
  const header = "## Iteration History";
  const markedHeader = `${marker}\n${header}`;
  const markerIndex = body.indexOf(marker);
  const index = markerIndex === -1 ? body.indexOf(header) : markerIndex;

  if (index === -1) {
    const prefix = body.trimEnd();
    return `${prefix ? `${prefix}\n\n` : ""}${markedHeader}\n\n${entry}\n`;
  }

  if (markerIndex === -1) {
    const insertAt = index + header.length;
    return `${body.slice(0, index)}${markedHeader}\n\n${entry}${body.slice(insertAt)}`;
  }

  const headerIndex = body.indexOf(header, markerIndex);
  const insertAt = headerIndex === -1 ? markerIndex + marker.length : headerIndex + header.length;
  return `${body.slice(0, insertAt)}\n\n${entry}${body.slice(insertAt)}`;
}

function formatCheckLink(check: PullRequestValidation["blockingChecks"][number]): string {
  return check.url ? `[${check.name}](${check.url})` : check.name;
}

function formatValidationNote(validation: PullRequestValidation): string {
  const shortSha = validation.headSha === "unknown" ? "unknown" : validation.headSha.slice(0, 7);

  if (validation.state === "success") {
    return `Validation: passed for \`${shortSha}\` (${validation.message}).`;
  }

  if (validation.state === "failure") {
    const links = validation.blockingChecks.map(formatCheckLink).join(", ");
    const suffix = links ? ` Failed check(s): ${links}.` : "";
    return `Validation: failed for \`${shortSha}\` after ${validation.waitedSeconds}s. ${validation.message}.${suffix}`;
  }

  return `Validation: not confirmed for \`${shortSha}\` after ${validation.waitedSeconds}s. ${validation.message}.`;
}

async function safeWaitForPullRequestValidation(): Promise<PullRequestValidation> {
  try {
    return await waitForPullRequestValidation(GITHUB_REPOSITORY, PR_NUMBER);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, pr: PR_NUMBER }, "Failed to read PR validation status");
    return {
      state: "pending",
      headSha: "unknown",
      pullRequestUrl: "",
      observedValidationCheck: false,
      message: `Validation status could not be read: ${message}`,
      blockingChecks: [],
      pendingChecks: [],
      validationChecks: [],
      waitedSeconds: 0,
    };
  }
}

if (result.success) {
  const summary = extractIterationSummary(result.summary);
  const validation = await safeWaitForPullRequestValidation();
  const validationNote = formatValidationNote(validation);
  const summaryWithValidation = `${summary}\n\n${validationNote}`;
  const runUrl = actionsRunUrl();
  const runLine = runUrl ? `\n- Run: [Actions run](${runUrl})` : "";
  const timestamp = new Date().toISOString();
  const author = COMMENT_AUTHOR ? `@${COMMENT_AUTHOR}` : "review feedback";
  const entry = `### ${timestamp}\n- Feedback: ${author}: ${summarizeFeedback(COMMENT_BODY)}\n- Update: ${summaryWithValidation}${runLine}`;

  const currentBody = await getPullRequestBody(GITHUB_REPOSITORY, PR_NUMBER);
  if (currentBody !== null) {
    await updatePullRequestBody(
      GITHUB_REPOSITORY,
      PR_NUMBER,
      appendIterationHistory(currentBody, entry)
    );
  }

  await postIssueComment(
    GITHUB_REPOSITORY,
    PR_NUMBER,
    `${PR_ITERATION_COMMENT_MARKER}\nAutomated update after feedback from ${author}.\n\n${summaryWithValidation}${runUrl ? `\n\nRun: ${runUrl}` : ""}`
  );

  if (validation.state !== "success") {
    logger.error(
      { pr: PR_NUMBER, validation },
      "PR updated with review feedback but validation did not pass"
    );
    process.exit(1);
  }

  logger.info({ pr: PR_NUMBER, validation }, "PR updated with review feedback");
  process.exit(0);
} else {
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}

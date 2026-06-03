/**
 * Runner script executed by the iterate-from-review GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { buildPrContext } from "../github/context.js";
import { actionsRunUrl, postIssueComment } from "../github/issues.js";
import { getPullRequestBody, updatePullRequestBody } from "../github/pulls.js";
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

// Build full PR context: linked issue → PR description → review history → conversation
const prContext = buildPrContext(GITHUB_REPOSITORY, PR_NUMBER);

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
  model
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
  const header = "## Iteration History";
  const index = body.indexOf(header);

  if (index === -1) {
    const prefix = body.trimEnd();
    return `${prefix ? `${prefix}\n\n` : ""}${header}\n\n${entry}\n`;
  }

  const insertAt = index + header.length;
  return `${body.slice(0, insertAt)}\n\n${entry}${body.slice(insertAt)}`;
}

if (result.success) {
  const summary = extractIterationSummary(result.summary);
  const runUrl = actionsRunUrl();
  const runLine = runUrl ? `\n- Run: [Actions run](${runUrl})` : "";
  const timestamp = new Date().toISOString();
  const author = COMMENT_AUTHOR ? `@${COMMENT_AUTHOR}` : "review feedback";
  const entry = `### ${timestamp}\n- Feedback: ${author}: ${summarizeFeedback(COMMENT_BODY)}\n- Update: ${summary}${runLine}`;

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
    `Updated this PR after feedback from ${author}.\n\n${summary}${runUrl ? `\n\nRun: ${runUrl}` : ""}`
  );

  logger.info({ pr: PR_NUMBER }, "PR updated with review feedback");
  process.exit(0);
} else {
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}

/**
 * Runner script executed by the plan-from-issue GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import {
  type IssueComment,
  listIssueComments,
  postIssueComment,
  updateIssueComment,
} from "../github/issues.js";
import { requireEnv } from "./base.js";
import { logger } from "../utils/logger.js";

requireEnv("ISSUE_NUMBER", "ISSUE_TITLE", "ISSUE_AUTHOR", "GITHUB_REPOSITORY");

const {
  ISSUE_NUMBER = "",
  ISSUE_TITLE = "",
  ISSUE_BODY = "",
  ISSUE_AUTHOR = "",
  GITHUB_REPOSITORY = "",
  COMMENT_BODY = "",
  COMMENT_AUTHOR = "",
} = process.env;

const PLAN_MARKER = "<!-- claude-plan -->";
const MAX_DISCUSSION_COMMENTS = 25;
const MAX_COMMENT_CHARS = 3000;
const MAX_DISCUSSION_CHARS = 16000;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function stripPlanMarker(body: string): string {
  return body.replace(/^<!--\s*claude-plan\s*-->\s*/i, "").trim();
}

function normalizePlan(body: string): string {
  let text = stripPlanMarker(body.trim());
  const fenced = text.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();

  return text.startsWith("## Plan") ? text : `## Plan\n\n${text}`;
}

function isPlanComment(comment: IssueComment): boolean {
  const body = comment.body.trim();
  const isBot = comment.user.type === "Bot";

  return (
    body.includes(PLAN_MARKER) ||
    (isBot && (body.startsWith("## Plan") || body.startsWith("### Understanding")))
  );
}

function findPlanComment(comments: IssueComment[]): IssueComment | null {
  const planComments = comments.filter(isPlanComment);
  if (planComments.length === 0) return null;

  const [latestPlanComment] = planComments.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );

  return latestPlanComment ?? null;
}

function isStatusNoise(comment: IssueComment): boolean {
  if (comment.user.type !== "Bot") return false;

  const body = comment.body.trim();
  return (
    body.startsWith("Planning workflow is in progress:") ||
    body.startsWith("Plan update workflow is in progress:") ||
    body.startsWith("Planning workflow failed:") ||
    body.startsWith("Planning failed.") ||
    body.startsWith("Fix workflow is in progress:") ||
    body.startsWith("Fix workflow failed:")
  );
}

function formatIssueDiscussion(comments: IssueComment[], planCommentId: number | null): string {
  const relevantComments = comments
    .filter((comment) => comment.id !== planCommentId)
    .filter((comment) => !isStatusNoise(comment))
    .slice(-MAX_DISCUSSION_COMMENTS);

  if (relevantComments.length === 0) return "No issue comments yet.";

  const discussion = relevantComments
    .map((comment) => {
      const createdAt = comment.createdAt || "unknown time";
      const body = truncate(comment.body.trim() || "(empty comment)", MAX_COMMENT_CHARS);
      return `### @${comment.user.login} on ${createdAt}\n\n${body}`;
    })
    .join("\n\n---\n\n");

  return truncate(discussion, MAX_DISCUSSION_CHARS);
}

const isIteration = COMMENT_BODY.trim().length > 0;
const issueComments = await listIssueComments(GITHUB_REPOSITORY, ISSUE_NUMBER);
const existingPlanComment = findPlanComment(issueComments);
const existingPlan = existingPlanComment
  ? stripPlanMarker(existingPlanComment.body)
  : "No existing plan comment has been posted yet.";
const issueDiscussion = formatIssueDiscussion(issueComments, existingPlanComment?.id ?? null);

const model = await pickModel(
  [
    `Plan GitHub issue: ${ISSUE_TITLE}`,
    ISSUE_BODY,
    isIteration ? `Feedback from @${COMMENT_AUTHOR}:\n${COMMENT_BODY}` : "",
    existingPlanComment ? `Existing plan:\n${existingPlan}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
);

const result = await runClaudeSession(
  "plan-issue",
  {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    ISSUE_BODY,
    ISSUE_AUTHOR,
    REPO_FULL_NAME: GITHUB_REPOSITORY,
    SF_TARGET_ORG: process.env.SF_TARGET_ORG || "pipeline-org",
    PLAN_MODE: isIteration ? "iteration" : "initial",
    COMMENT_BODY: COMMENT_BODY.trim() || "No new feedback comment was provided.",
    COMMENT_AUTHOR: COMMENT_AUTHOR || "n/a",
    EXISTING_PLAN: existingPlan,
    ISSUE_COMMENTS: issueDiscussion,
  },
  model,
  {
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    maxTurns: parseInt(process.env.MAX_PLAN_TURNS || "15"),
    summaryMaxChars: 12000,
  }
);

if (result.success) {
  const planBody = `${PLAN_MARKER}\n${normalizePlan(result.summary)}`;

  if (existingPlanComment) {
    const updated = await updateIssueComment(GITHUB_REPOSITORY, existingPlanComment.id, planBody);
    if (updated) {
      logger.info(
        { issue: ISSUE_NUMBER, commentId: existingPlanComment.id },
        "Plan comment updated on issue"
      );
      process.exit(0);
    }
  }

  await postIssueComment(GITHUB_REPOSITORY, ISSUE_NUMBER, planBody);
  logger.info({ issue: ISSUE_NUMBER }, "Plan posted on issue");
  process.exit(0);
}

await postIssueComment(
  GITHUB_REPOSITORY,
  ISSUE_NUMBER,
  `Planning failed.\n\n${result.summary.slice(0, 1000)}`
);
logger.error({ summary: result.summary }, "Plan session failed");
process.exit(1);

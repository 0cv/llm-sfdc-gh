/**
 * Builds a full PR context string to give Claude historical awareness:
 * linked issue -> PR description -> review history -> conversation comments.
 */

import { logger } from "../utils/logger.js";
import {
  isAutomationAuthoredComment,
  stripAutomationSectionsFromPullRequestBody,
} from "./automation.js";
import { githubTokenForRepo } from "./token.js";

const API_VERSION = "2022-11-28";

interface GhUser {
  login: string;
}

interface GhPr {
  title: string;
  body: string | null;
}

interface GhIssue {
  title: string;
  body: string | null;
}

interface GhReview {
  id: number;
  user: GhUser;
  body: string | null;
  state: string;
  submitted_at: string;
}

interface GhReviewComment {
  pull_request_review_id: number;
  user: GhUser;
  path: string;
  line?: number;
  original_line?: number;
  body: string;
}

interface GhComment {
  user: GhUser;
  body: string;
  created_at: string;
}

async function ghApi<T>(repo: string, endpoint: string): Promise<T> {
  const token = githubTokenForRepo(repo);
  if (!token) throw new Error(`No GitHub token configured for ${repo}`);

  const url = new URL(`https://api.github.com/${endpoint}`);
  if (!url.searchParams.has("per_page")) {
    url.searchParams.set("per_page", "100");
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "llm-sfdc-gh",
      "x-github-api-version": API_VERSION,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed: ${response.status} ${body}`);
  }

  return (await response.json()) as T;
}

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err }, `Failed to fetch ${label}`);
    return null;
  }
}

export async function buildPrContext(repo: string, prNumber: string): Promise<string> {
  const sections: string[] = [];

  const pr = await safe("PR", () => ghApi<GhPr>(repo, `repos/${repo}/pulls/${prNumber}`));
  const issueMatch = pr?.body?.match(/(?:fixes|closes|resolves|refs?)\s+#(\d+)/i);
  if (issueMatch) {
    const issueNumber = issueMatch[1];
    const issue = await safe("linked issue", () =>
      ghApi<GhIssue>(repo, `repos/${repo}/issues/${issueNumber}`)
    );
    const issueComments = await safe("linked issue comments", () =>
      ghApi<GhComment[]>(repo, `repos/${repo}/issues/${issueNumber}/comments`)
    );

    if (issue) {
      const parts = [`# Linked Issue #${issueNumber}: ${issue.title}`];
      if (issue.body) parts.push(issue.body);
      for (const comment of (issueComments ?? []).filter(
        (issueComment) => !isAutomationAuthoredComment(issueComment.body)
      )) {
        parts.push(`**${comment.user.login}** (${comment.created_at}):\n${comment.body}`);
      }
      sections.push(parts.join("\n\n"));
    }
  }

  const prBody = pr?.body ? stripAutomationSectionsFromPullRequestBody(pr.body) : "";
  if (prBody) {
    sections.push(`# PR Description\n\n${prBody}`);
  }

  const reviews = await safe("reviews", () =>
    ghApi<GhReview[]>(repo, `repos/${repo}/pulls/${prNumber}/reviews`)
  );
  const inlineComments = await safe("review comments", () =>
    ghApi<GhReviewComment[]>(repo, `repos/${repo}/pulls/${prNumber}/comments`)
  );

  if (reviews && reviews.length > 0) {
    const byReview = new Map<number, GhReviewComment[]>();
    for (const comment of inlineComments ?? []) {
      const list = byReview.get(comment.pull_request_review_id) ?? [];
      list.push(comment);
      byReview.set(comment.pull_request_review_id, list);
    }

    const reviewBlocks = reviews.map((review) => {
      const lines = [`**${review.user.login}** - ${review.state} (${review.submitted_at})`];
      if (review.body) lines.push(review.body);
      const inlines = byReview.get(review.id) ?? [];
      if (inlines.length > 0) {
        lines.push("Inline comments:");
        for (const comment of inlines) {
          const lineNum = comment.line ?? comment.original_line;
          lines.push(`- \`${comment.path}\`${lineNum ? ` line ${lineNum}` : ""}: ${comment.body}`);
        }
      }
      return lines.join("\n");
    });

    sections.push(`# Review History\n\n${reviewBlocks.join("\n\n---\n\n")}`);
  }

  const conversation = await safe("PR conversation", () =>
    ghApi<GhComment[]>(repo, `repos/${repo}/issues/${prNumber}/comments`)
  );
  const relevantConversation =
    conversation?.filter((comment) => !isAutomationAuthoredComment(comment.body)) ?? [];
  if (relevantConversation.length > 0) {
    const blocks = relevantConversation.map(
      (comment) => `**${comment.user.login}** (${comment.created_at}):\n${comment.body}`
    );
    sections.push(`# PR Conversation\n\n${blocks.join("\n\n---\n\n")}`);
  }

  return sections.join("\n\n---\n\n");
}

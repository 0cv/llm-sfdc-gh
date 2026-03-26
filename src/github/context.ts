/**
 * Builds a full PR context string to give Claude historical awareness:
 * linked issue → PR description → review history → conversation comments.
 */

import { execSync } from "node:child_process";
import { logger } from "../utils/logger.js";

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

function ghApi<T>(endpoint: string): T {
  const url = endpoint.includes("?") ? `${endpoint}&per_page=100` : `${endpoint}?per_page=100`;
  return JSON.parse(execSync(`gh api '${url}'`, { encoding: "utf-8" })) as T;
}

function safe<T>(label: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    logger.warn({ err }, `Failed to fetch ${label}`);
    return null;
  }
}

export function buildPrContext(repo: string, prNumber: string): string {
  const sections: string[] = [];

  // ── Linked issue (background on the original bug) ─────────────────────────
  const pr = safe("PR", () => ghApi<GhPr>(`repos/${repo}/pulls/${prNumber}`));
  const issueMatch = pr?.body?.match(/(?:fixes|closes|resolves|refs?)\s+#(\d+)/i);
  if (issueMatch) {
    const issueNumber = issueMatch[1];
    const issue = safe("linked issue", () => ghApi<GhIssue>(`repos/${repo}/issues/${issueNumber}`));
    const issueComments = safe(
      "linked issue comments",
      () => ghApi<GhComment[]>(`repos/${repo}/issues/${issueNumber}/comments`)
    );

    if (issue) {
      const parts = [`# Linked Issue #${issueNumber}: ${issue.title}`];
      if (issue.body) parts.push(issue.body);
      for (const c of issueComments ?? []) {
        parts.push(`**${c.user.login}** (${c.created_at}):\n${c.body}`);
      }
      sections.push(parts.join("\n\n"));
    }
  }

  // ── PR description ─────────────────────────────────────────────────────────
  if (pr?.body) {
    sections.push(`# PR Description\n\n${pr.body}`);
  }

  // ── Review history (submitted reviews + their inline comments) ─────────────
  const reviews = safe("reviews", () => ghApi<GhReview[]>(`repos/${repo}/pulls/${prNumber}/reviews`));
  const inlineComments = safe(
    "review comments",
    () => ghApi<GhReviewComment[]>(`repos/${repo}/pulls/${prNumber}/comments`)
  );

  if (reviews && reviews.length > 0) {
    // Group inline comments by review ID
    const byReview = new Map<number, GhReviewComment[]>();
    for (const c of inlineComments ?? []) {
      const list = byReview.get(c.pull_request_review_id) ?? [];
      list.push(c);
      byReview.set(c.pull_request_review_id, list);
    }

    const reviewBlocks = reviews.map((r) => {
      const lines = [`**${r.user.login}** — ${r.state} (${r.submitted_at})`];
      if (r.body) lines.push(r.body);
      const inlines = byReview.get(r.id) ?? [];
      if (inlines.length > 0) {
        lines.push("Inline comments:");
        for (const c of inlines) {
          const lineNum = c.line ?? c.original_line;
          lines.push(`- \`${c.path}\`${lineNum ? ` line ${lineNum}` : ""}: ${c.body}`);
        }
      }
      return lines.join("\n");
    });

    sections.push(`# Review History\n\n${reviewBlocks.join("\n\n---\n\n")}`);
  }

  // ── PR conversation comments (Conversation tab) ────────────────────────────
  const conversation = safe(
    "PR conversation",
    () => ghApi<GhComment[]>(`repos/${repo}/issues/${prNumber}/comments`)
  );
  if (conversation && conversation.length > 0) {
    const blocks = conversation.map(
      (c) => `**${c.user.login}** (${c.created_at}):\n${c.body}`
    );
    sections.push(`# PR Conversation\n\n${blocks.join("\n\n---\n\n")}`);
  }

  return sections.join("\n\n---\n\n");
}

import { logger } from "../utils/logger.js";
import { githubTokenForRepo } from "./token.js";

const API_VERSION = "2022-11-28";

export interface IssueComment {
  id: number;
  body: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  user: {
    login: string;
    type: string;
  };
}

interface GitHubIssueComment {
  id: number;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: {
    login?: string;
    type?: string;
  } | null;
}

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  pull_request?: unknown;
}

interface SearchIssuesResponse {
  items?: GitHubIssue[];
}

export interface IssueMatch {
  number: number;
  title: string;
  url: string;
  state: string;
  body?: string;
}

export function actionsRunUrl(): string | null {
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  if (!repo || !runId) return null;
  return `${serverUrl}/${repo}/actions/runs/${runId}`;
}

export async function postIssueComment(
  repo: string,
  issueNumber: string,
  body: string
): Promise<void> {
  const token = githubTokenForRepo(repo);
  if (!repo || !issueNumber || !token) {
    logger.warn({ repo, issueNumber }, "Skipping issue comment; GitHub context is incomplete");
    return;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "llm-sfdc-gh",
        "x-github-api-version": API_VERSION,
      },
      body: JSON.stringify({ body }),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text();
    logger.warn(
      { repo, issueNumber, status: response.status, body: responseBody },
      "Failed to post issue comment"
    );
  }
}

export async function findOpenIssueByTitle(
  repo: string,
  title: string
): Promise<IssueMatch | null> {
  const token = githubTokenForRepo(repo);
  if (!repo || !title || !token) {
    throw new Error("Cannot search issues; GitHub context is incomplete");
  }

  const exactTitle = title.trim();
  const escapedTitle = exactTitle.replace(/"/g, '\\"');
  const params = new URLSearchParams({
    q: `repo:${repo} type:issue state:open in:title "${escapedTitle}"`,
    sort: "updated",
    order: "desc",
    per_page: "20",
  });

  const response = await fetch(`https://api.github.com/search/issues?${params.toString()}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "llm-sfdc-gh",
      "x-github-api-version": API_VERSION,
    },
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logger.warn(
      { repo, title, status: response.status, body: responseBody },
      "Failed to search issues"
    );
    throw new Error(`Failed to search issues: ${response.status} ${responseBody}`);
  }

  const search = (await response.json()) as SearchIssuesResponse;
  const match = (search.items ?? []).find((issue) => issue.title.trim() === exactTitle);
  if (!match) return null;

  return {
    number: match.number,
    title: match.title,
    url: match.html_url,
    state: match.state,
    body: match.body || "",
  };
}

export async function listOpenIssuesByLabel(repo: string, label: string): Promise<IssueMatch[]> {
  const token = githubTokenForRepo(repo);
  if (!repo || !label || !token) {
    throw new Error("Cannot list issues; GitHub context is incomplete");
  }

  const issues: IssueMatch[] = [];
  const maxPages = 5;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      state: "open",
      labels: label,
      per_page: "100",
      page: String(page),
    });
    const response = await fetch(`https://api.github.com/repos/${repo}/issues?${params}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "llm-sfdc-gh",
        "x-github-api-version": API_VERSION,
      },
    });

    if (!response.ok) {
      const responseBody = await response.text();
      logger.warn(
        { repo, label, status: response.status, body: responseBody },
        "Failed to list issues"
      );
      throw new Error(`Failed to list issues: ${response.status} ${responseBody}`);
    }

    const pageIssues = (await response.json()) as GitHubIssue[];
    for (const issue of pageIssues) {
      if (issue.pull_request) continue;
      issues.push({
        number: issue.number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        body: issue.body || "",
      });
    }

    if (pageIssues.length < 100) break;
  }

  return issues;
}

export async function createIssue(
  repo: string,
  title: string,
  body: string
): Promise<IssueMatch | null> {
  const token = githubTokenForRepo(repo);
  if (!repo || !title || !token) {
    logger.warn({ repo, title }, "Skipping issue creation; GitHub context is incomplete");
    return null;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "llm-sfdc-gh",
      "x-github-api-version": API_VERSION,
    },
    body: JSON.stringify({ title, body }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logger.warn(
      { repo, title, status: response.status, body: responseBody },
      "Failed to create issue"
    );
    return null;
  }

  const issue = (await response.json()) as GitHubIssue;
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
  };
}

export async function updateIssueBody(
  repo: string,
  issueNumber: string,
  body: string
): Promise<boolean> {
  const token = githubTokenForRepo(repo);
  if (!repo || !issueNumber || !token) {
    logger.warn({ repo, issueNumber }, "Skipping issue update; GitHub context is incomplete");
    return false;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "llm-sfdc-gh",
      "x-github-api-version": API_VERSION,
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logger.warn(
      { repo, issueNumber, status: response.status, body: responseBody },
      "Failed to update issue"
    );
    return false;
  }

  return true;
}

export async function closeIssue(
  repo: string,
  issueNumber: string,
  stateReason: "completed" | "not_planned" | "duplicate" = "completed"
): Promise<boolean> {
  const token = githubTokenForRepo(repo);
  if (!repo || !issueNumber || !token) {
    logger.warn({ repo, issueNumber }, "Skipping issue close; GitHub context is incomplete");
    return false;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "llm-sfdc-gh",
      "x-github-api-version": API_VERSION,
    },
    body: JSON.stringify({ state: "closed", state_reason: stateReason }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logger.warn(
      { repo, issueNumber, status: response.status, body: responseBody },
      "Failed to close issue"
    );
    return false;
  }

  return true;
}

export async function listIssueComments(
  repo: string,
  issueNumber: string
): Promise<IssueComment[]> {
  const token = githubTokenForRepo(repo);
  if (!repo || !issueNumber || !token) {
    logger.warn(
      { repo, issueNumber },
      "Skipping issue comment listing; GitHub context is incomplete"
    );
    return [];
  }

  const comments: IssueComment[] = [];
  const maxPages = 3;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "llm-sfdc-gh",
          "x-github-api-version": API_VERSION,
        },
      }
    );

    if (!response.ok) {
      const responseBody = await response.text();
      logger.warn(
        { repo, issueNumber, status: response.status, body: responseBody },
        "Failed to list issue comments"
      );
      return comments;
    }

    const pageComments = (await response.json()) as GitHubIssueComment[];
    comments.push(
      ...pageComments.map((comment) => ({
        id: comment.id,
        body: comment.body || "",
        htmlUrl: comment.html_url || "",
        createdAt: comment.created_at || "",
        updatedAt: comment.updated_at || "",
        user: {
          login: comment.user?.login || "unknown",
          type: comment.user?.type || "unknown",
        },
      }))
    );

    if (pageComments.length < 100) break;
  }

  return comments;
}

export async function updateIssueComment(
  repo: string,
  commentId: number,
  body: string
): Promise<boolean> {
  const token = githubTokenForRepo(repo);
  if (!repo || !commentId || !token) {
    logger.warn({ repo, commentId }, "Skipping issue comment update; GitHub context is incomplete");
    return false;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "llm-sfdc-gh",
        "x-github-api-version": API_VERSION,
      },
      body: JSON.stringify({ body }),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text();
    logger.warn(
      { repo, commentId, status: response.status, body: responseBody },
      "Failed to update issue comment"
    );
    return false;
  }

  return true;
}

export async function addIssueLabels(
  repo: string,
  issueNumber: string,
  labels: string[]
): Promise<void> {
  const token = githubTokenForRepo(repo);
  if (!repo || !issueNumber || labels.length === 0 || !token) {
    logger.warn(
      { repo, issueNumber, labels },
      "Skipping issue labels; GitHub context is incomplete"
    );
    return;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "llm-sfdc-gh",
        "x-github-api-version": API_VERSION,
      },
      body: JSON.stringify({ labels }),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text();
    logger.warn(
      { repo, issueNumber, labels, status: response.status, body: responseBody },
      "Failed to add issue labels"
    );
  }
}

export async function removeIssueLabel(
  repo: string,
  issueNumber: string,
  label: string
): Promise<void> {
  const token = githubTokenForRepo(repo);
  if (!repo || !issueNumber || !label || !token) {
    logger.warn(
      { repo, issueNumber, label },
      "Skipping issue label removal; GitHub context is incomplete"
    );
    return;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "llm-sfdc-gh",
        "x-github-api-version": API_VERSION,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    const responseBody = await response.text();
    logger.warn(
      { repo, issueNumber, label, status: response.status, body: responseBody },
      "Failed to remove issue label"
    );
  }
}

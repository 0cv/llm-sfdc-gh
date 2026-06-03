import { logger } from "../utils/logger.js";

const API_VERSION = "2022-11-28";

function githubToken(): string | undefined {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
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
  const token = githubToken();
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

export async function addIssueLabels(
  repo: string,
  issueNumber: string,
  labels: string[]
): Promise<void> {
  const token = githubToken();
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
  const token = githubToken();
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

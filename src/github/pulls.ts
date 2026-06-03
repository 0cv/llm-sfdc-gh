import { logger } from "../utils/logger.js";

const API_VERSION = "2022-11-28";

interface PullRequest {
  body: string | null;
}

function githubToken(): string | undefined {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
}

export async function getPullRequestBody(repo: string, prNumber: string): Promise<string | null> {
  const token = githubToken();
  if (!repo || !prNumber || !token) {
    logger.warn({ repo, prNumber }, "Skipping PR fetch; GitHub context is incomplete");
    return null;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "llm-sfdc-gh",
      "x-github-api-version": API_VERSION,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    logger.warn({ repo, prNumber, status: response.status, body }, "Failed to fetch PR");
    return null;
  }

  const pr = (await response.json()) as PullRequest;
  return pr.body ?? "";
}

export async function updatePullRequestBody(
  repo: string,
  prNumber: string,
  body: string
): Promise<void> {
  const token = githubToken();
  if (!repo || !prNumber || !token) {
    logger.warn({ repo, prNumber }, "Skipping PR update; GitHub context is incomplete");
    return;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
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
      { repo, prNumber, status: response.status, body: responseBody },
      "Failed to update PR body"
    );
  }
}

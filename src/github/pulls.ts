import { logger } from "../utils/logger.js";
import { githubTokenForRepo } from "./token.js";

const API_VERSION = "2022-11-28";

interface PullRequest {
  body: string | null;
}

interface PullRequestListItem {
  number: number;
  title: string;
  html_url: string;
}

export interface OpenPullRequestMatch {
  number: number;
  title: string;
  url: string;
}

export async function findOpenPullRequestByTitle(
  repo: string,
  title: string
): Promise<OpenPullRequestMatch | null> {
  const token = githubTokenForRepo(repo);
  if (!repo || !title || !token) {
    throw new Error("Cannot list open PRs; GitHub context is incomplete");
  }

  const response = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "llm-sfdc-gh",
        "x-github-api-version": API_VERSION,
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    logger.warn({ repo, title, status: response.status, body }, "Failed to list open PRs");
    throw new Error(`Failed to list open PRs: ${response.status} ${body}`);
  }

  const pulls = (await response.json()) as PullRequestListItem[];
  const match = pulls.find((pull) => pull.title.trim() === title.trim());
  if (!match) return null;

  return {
    number: match.number,
    title: match.title,
    url: match.html_url,
  };
}

export async function getPullRequestBody(repo: string, prNumber: string): Promise<string | null> {
  const token = githubTokenForRepo(repo);
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
  const token = githubTokenForRepo(repo);
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

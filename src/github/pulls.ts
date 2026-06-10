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

interface PullRequestDetails {
  number: number;
  title: string;
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base?: {
    ref?: string;
  };
}

interface SearchIssueItem {
  number: number;
  title: string;
  html_url: string;
}

interface SearchIssuesResponse {
  items?: SearchIssueItem[];
}

interface CompareResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  html_url: string;
  merge_base_commit?: {
    sha?: string;
  };
}

export interface OpenPullRequestMatch {
  number: number;
  title: string;
  url: string;
}

export interface MergedPullRequestMatch {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  mergeCommitSha: string;
  baseBranch: string;
}

export interface BranchContainment {
  branch: string;
  contains: boolean;
  status: string;
  aheadBy: number;
  behindBy: number;
  compareUrl: string;
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

export async function findLatestMergedPullRequestByTitle(
  repo: string,
  title: string
): Promise<MergedPullRequestMatch | null> {
  const token = githubTokenForRepo(repo);
  if (!repo || !title || !token) {
    throw new Error("Cannot search merged PRs; GitHub context is incomplete");
  }

  const exactTitle = title.trim();
  const escapedTitle = exactTitle.replace(/"/g, '\\"');
  const params = new URLSearchParams({
    q: `repo:${repo} type:pr is:merged in:title "${escapedTitle}"`,
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
    const body = await response.text();
    logger.warn({ repo, title, status: response.status, body }, "Failed to search merged PRs");
    throw new Error(`Failed to search merged PRs: ${response.status} ${body}`);
  }

  const search = (await response.json()) as SearchIssuesResponse;
  const matches: MergedPullRequestMatch[] = [];

  for (const item of search.items ?? []) {
    if (item.title.trim() !== exactTitle) continue;

    const details = await getPullRequestDetails(repo, String(item.number));
    if (!details?.merged || !details.merged_at || !details.merge_commit_sha) continue;
    if (details.title.trim() !== exactTitle) continue;

    matches.push({
      number: details.number,
      title: details.title,
      url: details.html_url,
      mergedAt: details.merged_at,
      mergeCommitSha: details.merge_commit_sha,
      baseBranch: details.base?.ref || "",
    });
  }

  if (matches.length === 0) {
    matches.push(...(await findRecentClosedMergedPullRequestsByTitle(repo, exactTitle)));
  }

  matches.sort((left, right) => Date.parse(right.mergedAt) - Date.parse(left.mergedAt));
  return matches[0] ?? null;
}

async function findRecentClosedMergedPullRequestsByTitle(
  repo: string,
  exactTitle: string
): Promise<MergedPullRequestMatch[]> {
  const token = githubTokenForRepo(repo);
  if (!repo || !exactTitle || !token) {
    throw new Error("Cannot list closed PRs; GitHub context is incomplete");
  }

  const matches: MergedPullRequestMatch[] = [];
  const maxPages = 3;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
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
      logger.warn({ repo, exactTitle, status: response.status, body }, "Failed to list closed PRs");
      throw new Error(`Failed to list closed PRs: ${response.status} ${body}`);
    }

    const pulls = (await response.json()) as PullRequestListItem[];
    for (const pull of pulls) {
      if (pull.title.trim() !== exactTitle) continue;

      const details = await getPullRequestDetails(repo, String(pull.number));
      if (!details?.merged || !details.merged_at || !details.merge_commit_sha) continue;
      matches.push({
        number: details.number,
        title: details.title,
        url: details.html_url,
        mergedAt: details.merged_at,
        mergeCommitSha: details.merge_commit_sha,
        baseBranch: details.base?.ref || "",
      });
    }

    if (pulls.length < 100) break;
  }

  return matches;
}

export async function compareCommitToBranch(
  repo: string,
  commitSha: string,
  branch: string
): Promise<BranchContainment> {
  const token = githubTokenForRepo(repo);
  if (!repo || !commitSha || !branch || !token) {
    throw new Error("Cannot compare commit to branch; GitHub context is incomplete");
  }

  const base = encodeURIComponent(commitSha);
  const head = encodeURIComponent(branch);
  const response = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "llm-sfdc-gh",
      "x-github-api-version": API_VERSION,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    logger.warn(
      { repo, commitSha, branch, status: response.status, body },
      "Failed to compare commit to branch"
    );
    throw new Error(`Failed to compare commit to branch: ${response.status} ${body}`);
  }

  const compare = (await response.json()) as CompareResponse;
  const contains =
    compare.status === "identical" ||
    (compare.status === "ahead" &&
      compare.behind_by === 0 &&
      compare.merge_base_commit?.sha === commitSha);

  return {
    branch,
    contains,
    status: compare.status,
    aheadBy: compare.ahead_by,
    behindBy: compare.behind_by,
    compareUrl: compare.html_url,
  };
}

async function getPullRequestDetails(
  repo: string,
  prNumber: string
): Promise<PullRequestDetails | null> {
  const token = githubTokenForRepo(repo);
  if (!repo || !prNumber || !token) {
    throw new Error("Cannot fetch PR details; GitHub context is incomplete");
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
    logger.warn({ repo, prNumber, status: response.status, body }, "Failed to fetch PR details");
    throw new Error(`Failed to fetch PR details: ${response.status} ${body}`);
  }

  return (await response.json()) as PullRequestDetails;
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

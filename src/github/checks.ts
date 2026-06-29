import { logger } from "../utils/logger.js";
import { githubChecksTokenForRepo } from "./token.js";

const API_VERSION = "2022-11-28";
const DEFAULT_VALIDATION_CHECK_PATTERN = "Validate Delta Package";

type CheckState = "success" | "failure" | "pending" | "skipped";

interface GitHubPullRequest {
  html_url: string;
  head?: {
    sha?: string;
  };
}

interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  details_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface GitHubCheckRunsResponse {
  check_runs?: GitHubCheckRun[];
}

interface GitHubCommitStatus {
  context: string;
  state: string;
  target_url?: string | null;
}

interface GitHubCombinedStatusResponse {
  statuses?: GitHubCommitStatus[];
}

export interface PullRequestCheck {
  name: string;
  state: CheckState;
  detail: string;
  url: string | null;
}

export interface PullRequestValidation {
  state: "success" | "failure" | "pending";
  headSha: string;
  pullRequestUrl: string;
  observedValidationCheck: boolean;
  message: string;
  blockingChecks: PullRequestCheck[];
  pendingChecks: PullRequestCheck[];
  validationChecks: PullRequestCheck[];
  waitedSeconds: number;
}

async function ghApi<T>(repo: string, endpoint: string): Promise<T> {
  const token = githubChecksTokenForRepo(repo);
  if (!token) throw new Error(`No GitHub token configured for ${repo}`);

  const response = await fetch(`https://api.github.com/${endpoint}`, {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseValidationPattern(): RegExp {
  const raw = process.env.PR_VALIDATION_CHECK_REGEX || DEFAULT_VALIDATION_CHECK_PATTERN;

  try {
    return new RegExp(raw, "i");
  } catch (err) {
    logger.warn({ err, raw }, "Invalid PR validation check regex; using default");
    return new RegExp(DEFAULT_VALIDATION_CHECK_PATTERN, "i");
  }
}

function checkRunState(run: GitHubCheckRun): CheckState {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success" || run.conclusion === "neutral") return "success";
  if (run.conclusion === "skipped") return "skipped";
  return "failure";
}

function commitStatusState(status: GitHubCommitStatus): CheckState {
  if (status.state === "success") return "success";
  if (status.state === "pending") return "pending";
  return "failure";
}

function checkRunToCheck(run: GitHubCheckRun): PullRequestCheck {
  const state = checkRunState(run);
  return {
    name: run.name,
    state,
    detail: run.conclusion || run.status,
    url: run.html_url || run.details_url || null,
  };
}

function checkRunSortMs(run: GitHubCheckRun): number {
  return Date.parse(run.completed_at || run.started_at || "") || run.id || 0;
}

function latestCheckRunsByName(runs: GitHubCheckRun[]): GitHubCheckRun[] {
  const latest = new Map<string, GitHubCheckRun>();

  for (const run of runs) {
    const existing = latest.get(run.name);
    if (!existing || checkRunSortMs(run) >= checkRunSortMs(existing)) {
      latest.set(run.name, run);
    }
  }

  return [...latest.values()];
}

function commitStatusToCheck(status: GitHubCommitStatus): PullRequestCheck {
  const state = commitStatusState(status);
  return {
    name: status.context,
    state,
    detail: status.state,
    url: status.target_url || null,
  };
}

function isBlocking(check: PullRequestCheck): boolean {
  return check.state === "failure";
}

function isPending(check: PullRequestCheck): boolean {
  return check.state === "pending";
}

function formatCheckList(checks: PullRequestCheck[]): string {
  return checks
    .slice(0, 3)
    .map((check) => `${check.name} (${check.detail})`)
    .join(", ");
}

async function getPullRequestHead(
  repo: string,
  prNumber: string
): Promise<{
  headSha: string;
  pullRequestUrl: string;
}> {
  const pr = await ghApi<GitHubPullRequest>(repo, `repos/${repo}/pulls/${prNumber}`);
  const headSha = pr.head?.sha;
  if (!headSha) throw new Error(`Could not determine PR #${prNumber} head SHA`);

  return {
    headSha,
    pullRequestUrl: pr.html_url,
  };
}

async function listChecksForSha(repo: string, sha: string): Promise<PullRequestCheck[]> {
  const [checkRuns, combinedStatus] = await Promise.all([
    ghApi<GitHubCheckRunsResponse>(repo, `repos/${repo}/commits/${sha}/check-runs?per_page=100`),
    ghApi<GitHubCombinedStatusResponse>(repo, `repos/${repo}/commits/${sha}/status`),
  ]);

  return [
    ...latestCheckRunsByName(checkRuns.check_runs ?? []).map(checkRunToCheck),
    ...(combinedStatus.statuses ?? []).map(commitStatusToCheck),
  ];
}

function evaluateValidation(
  headSha: string,
  pullRequestUrl: string,
  checks: PullRequestCheck[],
  validationPattern: RegExp,
  waitedSeconds: number
): PullRequestValidation {
  const validationChecks = checks.filter((check) => validationPattern.test(check.name));
  const blockingChecks = checks.filter(isBlocking);
  const pendingChecks = checks.filter(isPending);

  if (validationChecks.some(isBlocking) || (validationChecks.length > 0 && blockingChecks.length)) {
    return {
      state: "failure",
      headSha,
      pullRequestUrl,
      observedValidationCheck: validationChecks.length > 0,
      message: `Failed checks: ${formatCheckList(blockingChecks)}`,
      blockingChecks,
      pendingChecks,
      validationChecks,
      waitedSeconds,
    };
  }

  if (validationChecks.length === 0) {
    return {
      state: "pending",
      headSha,
      pullRequestUrl,
      observedValidationCheck: false,
      message: `No check matching /${validationPattern.source}/ has appeared yet`,
      blockingChecks,
      pendingChecks,
      validationChecks,
      waitedSeconds,
    };
  }

  if (validationChecks.some(isPending)) {
    return {
      state: "pending",
      headSha,
      pullRequestUrl,
      observedValidationCheck: true,
      message: `Validation is still running: ${formatCheckList(validationChecks.filter(isPending))}`,
      blockingChecks,
      pendingChecks,
      validationChecks,
      waitedSeconds,
    };
  }

  if (validationChecks.some((check) => check.state === "success")) {
    return {
      state: "success",
      headSha,
      pullRequestUrl,
      observedValidationCheck: true,
      message: `Validation passed: ${formatCheckList(validationChecks)}`,
      blockingChecks,
      pendingChecks,
      validationChecks,
      waitedSeconds,
    };
  }

  return {
    state: "failure",
    headSha,
    pullRequestUrl,
    observedValidationCheck: true,
    message: `Validation did not complete successfully: ${formatCheckList(validationChecks)}`,
    blockingChecks: validationChecks,
    pendingChecks,
    validationChecks,
    waitedSeconds,
  };
}

export async function waitForPullRequestValidation(
  repo: string,
  prNumber: string
): Promise<PullRequestValidation> {
  const timeoutSeconds = Number(process.env.PR_VALIDATION_WAIT_SECONDS || "900");
  const intervalSeconds = Number(process.env.PR_VALIDATION_POLL_SECONDS || "15");
  const timeoutMs = Math.max(timeoutSeconds, 0) * 1000;
  const intervalMs = Math.max(intervalSeconds, 5) * 1000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const validationPattern = parseValidationPattern();
  let lastValidation: PullRequestValidation | null = null;

  do {
    const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
    const { headSha, pullRequestUrl } = await getPullRequestHead(repo, prNumber);
    const checks = await listChecksForSha(repo, headSha);
    lastValidation = evaluateValidation(
      headSha,
      pullRequestUrl,
      checks,
      validationPattern,
      waitedSeconds
    );

    if (lastValidation.state !== "pending") {
      return lastValidation;
    }

    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)));
  } while (Date.now() <= deadline);

  return (
    lastValidation ?? {
      state: "pending",
      headSha: "unknown",
      pullRequestUrl: "",
      observedValidationCheck: false,
      message: "Validation status could not be read before the timeout",
      blockingChecks: [],
      pendingChecks: [],
      validationChecks: [],
      waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
    }
  );
}

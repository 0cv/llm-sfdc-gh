# llm-sfdc-gh

Automated Salesforce error fixing pipeline powered by Claude. When a Salesforce org throws an unhandled exception, this system receives the error email, diagnoses the root cause, fixes the code, runs tests, and opens a pull request — with no human involvement until the PR review.

Developers review the PR, leave feedback, and Claude iterates. GitHub Issues labeled `claude-fix` also trigger the same fix pipeline. GitHub Issues labeled `claude-plan` trigger a plan-only workflow that comments an implementation plan without changing code; later human comments on that issue update the plan.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Salesforce Org                                                       │
│  Unhandled exception → sends email to salesforceerrors+tag@gmail.com  │
└────────────────────────────┬──────────────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Gmail + Google Cloud Pub/Sub                                         │
│  Gmail watch() → Pub/Sub topic → push notification                    │
│  Cloud Scheduler → POST /admin/renew-watch (daily, auto-renews watch) │
└────────────────────────────┬──────────────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Cloud Run service  (this repo)                                       │
│                                                                       │
│  POST /webhooks/gmail                                                 │
│    → fetch email via Gmail API                                        │
│    → extract +tag from To: header                                     │
│    → routing.json: "dropbox" → "0cv/dropbox-dev"                      │
│    → dedup (skip if same error seen in last 24h)                      │
│    → skip dispatch if an open PR already has the expected fix title   │
│    → skip dispatch if pipeline.json shows the fix is awaiting prod    │
│    → triage via Claude Haiku (skip operational noise)                 │
│    → POST /repos/0cv/dropbox-dev/dispatches  (repository_dispatch)    │
│                                                                       │
│  POST /admin/renew-watch  (bearer token protected)                    │
│    → renews Gmail watch() subscription                                │
└────────────────────────────┬──────────────────────────────────────────┘
                             │
                             ▼
┌───────────────────────────────────────────────────────────────────────┐
│  GitHub Actions  (runs inside the target SF repo)                     │
│                                                                       │
│  fix-from-error.yml  ← triggered by repository_dispatch               │
│    → checkout repo                                                    │
│    → install SF CLI + authenticate SF org (SF_AUTH_URL secret)        │
│    → run Claude Agent SDK session:                                    │
│        • reads Apex class, diagnoses exception                        │
│        • fixes code, writes/updates unit tests                        │
│        • deploys to scratch org + runs tests                          │
│        • git push + gh pr create                                      │
│                                                                       │
│  fix-from-issue.yml  ← triggered natively when "claude-fix" label added│
│    → same fix flow, sourced from issue body instead of email          │
│                                                                       │
│  plan-from-issue.yml ← triggered by "claude-plan" or plan comments    │
│    → installs SF CLI, can read org metadata, updates a plan only      │
│                                                                       │
│  iterate-from-review.yml  ← triggered natively by PR review / comment │
│    → Claude reads feedback, updates code, pushes to same branch       │
│                                                                       │
│  close-awaiting-production.yml ← triggered by production branch push   │
│    → closes awaiting-production issues once the fix reaches prod       │
└───────────────────────────────────────────────────────────────────────┘
```

### Multi-repo routing

Each Salesforce org sends errors to a tagged Gmail address. The `+tag` in the `To:` header determines which GitHub repo gets the `repository_dispatch` event.

**`routing.json`**
```json
{
  "dropbox": "0cv/dropbox-dev",
  "kiniksa": "komodohealth/kiniksa-pjn-patient-journey-navigator"
}
```

To onboard a new org: add a line to `routing.json`, redeploy Cloud Run, and configure that org to send exception emails to `salesforceerrors+yourtag@gmail.com`.

**`pipeline.json`**
```json
{
  "komodohealth/kiniksa-pjn-patient-journey-navigator": {
    "preProductionBranches": ["msmerge-release", "release"],
    "productionBranch": "main"
  }
}
```

For repos with a promotion chain, add their pre-production branches and production branch. When a repeat error matches a merged same-title PR whose merge commit is present on a pre-production branch but not the production branch, Cloud Run suppresses the duplicate fix dispatch and creates or updates an `Awaiting production: ...` tracking issue. The installed `close-awaiting-production.yml` workflow runs on production-branch pushes and closes those tracking issues once the tracked merge commit reaches production.

---

## Repository structure

```
.github/workflows/                      Reusable workflows (called from SF repos)
  fix-from-error.yml       on: workflow_call — error email → Claude fix → PR
  fix-from-issue.yml       on: workflow_call — GitHub issue → Claude fix → PR
  plan-from-issue.yml      on: workflow_call — GitHub issue → Claude plan comment
  iterate-from-review.yml  on: workflow_call — PR feedback → Claude iterates
  close-awaiting-production.yml on: workflow_call — close prod tracking issues

prompts/
  fix-error.md             Claude prompt: diagnose + fix from exception email
  fix-issue.md             Claude prompt: fix from GitHub issue
  plan-issue.md            Claude prompt: plan from GitHub issue without edits
  iterate-review.md        Claude prompt: iterate on PR review feedback
  triage.md                Claude prompt: classify bug vs. operational noise

scripts/
  setup-gcp.sh             One-time GCP infrastructure setup
  auth-gmail.ts            One-time Gmail OAuth flow → get refresh token
  deploy.sh                Deploy Cloud Run + wire Pub/Sub + create Scheduler job
  renew-gmail-watch.ts     Manual Gmail watch renewal (automated in production)
  install-workflows.sh     Install caller workflows into a target SF repo

src/
  index.ts                 Express server entry point (Gmail webhook + admin)
  config.ts                Environment configuration
  webhooks/
    gmail.ts               Gmail Pub/Sub push handler → dedup → triage → dispatch
  gmail/
    watch.ts               Gmail watch() renewal logic (shared)
  email/
    parser.ts              Salesforce exception email parser
  github/
    dispatch.ts            GitHub repository_dispatch API call
  triage/
    classifier.ts          Haiku-based bug vs. operational noise classifier
  dedup/
    index.ts               In-memory error deduplication (24h TTL)
  claude/
    session.ts             Claude Agent SDK session wrapper
  runner/
    fix-from-error.ts      Entry point for fix-from-error workflow (fetched by GA)
    fix-from-issue.ts      Entry point for fix-from-issue workflow (fetched by GA)
    plan-from-issue.ts     Entry point for plan-from-issue workflow (fetched by GA)
    iterate-from-review.ts Entry point for iterate-from-review workflow (fetched by GA)
    close-awaiting-production.ts Entry point for prod tracking issue cleanup

routing.json               +tag → GitHub repo mapping
pipeline.json              repo → promotion branches for duplicate suppression
Dockerfile                 Cloud Run container
```

### Reusable workflow architecture

The workflows in this repo are **reusable** (`on: workflow_call`). Each Salesforce repo contains only a tiny caller workflow that references the logic here. When the logic changes, every repo picks it up automatically — no per-repo PRs needed.

At runtime each workflow fetches the runner script and prompt from `llm-sfdc-gh` via `gh api`, so SF repos don't need `src/` or `prompts/` copied in.

```
llm-sfdc-gh (this repo)
  .github/workflows/fix-from-error.yml     ← logic lives here
  src/runner/fix-from-error.ts             ← fetched at runtime
  prompts/fix-error.md                     ← fetched at runtime

dropbox-dev (SF repo)
  .github/workflows/fix-from-error.yml     ← tiny caller (2 lines)
    uses: 0cv/llm-sfdc-gh/.github/workflows/fix-from-error.yml@main
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}
```

---

## First-time setup

### Prerequisites

- `gcloud` CLI authenticated
- `gh` CLI authenticated
- `node` 24+
- `@salesforce/cli` installed globally

Reusable GitHub Actions workflows pin Node to `24.16.0` and Salesforce CLI to `2.140.6` to avoid runtime drift in hosted runners.

### 1. GCP infrastructure

```bash
./scripts/setup-gcp.sh <gcp-project-id> salesforceerrors@gmail.com
```

Creates the Pub/Sub topic and grants Gmail publish permission. Requires billing to be enabled on the GCP project.

### 2. Gmail OAuth credentials

In GCP Console → APIs & Services → Credentials → Create OAuth 2.0 Client ID (Desktop app).
Add `http://localhost:4242` as an authorized redirect URI.
Copy the client ID and secret into `.env`.

```bash
npm run auth-gmail
```

Paste the printed `GMAIL_REFRESH_TOKEN` into `.env`.

### 3. Generate an admin secret

```bash
openssl rand -hex 32
```

Add the output to `.env` as `ADMIN_SECRET`. This protects the `/admin/renew-watch` endpoint called by Cloud Scheduler.

### 4. Generate a GitHub dispatch token

Cloud Run uses GitHub tokens to call GitHub's `repository_dispatch` API for each target repo in `routing.json`.

Create a fine-grained personal access token at https://github.com/settings/personal-access-tokens/new:

- Resource owner: the GitHub owner that contains the target repos, e.g. `0cv` or `komodohealth`
- Repository access: select every repo for that owner listed in `routing.json`
- Repository permissions:
  - `Contents` → `Read and write`
  - `Pull requests` → `Read-only`
  - `Issues` → `Read and write`

Add the generated token to `.env`. `GITHUB_TOKEN` is the default fallback. Komodo repos use `GITHUB_TOKEN_KOMODO` when present. Other owner-specific tokens can use `GITHUB_TOKEN_<OWNER>` with the owner uppercased and non-alphanumeric characters replaced by underscores.

```bash
GITHUB_TOKEN=github_pat_...
GITHUB_TOKEN_KOMODO=github_pat_...
```

### 5. Deploy Cloud Run

```bash
./scripts/deploy.sh <gcp-project-id>
```

This single command:
- Deploys the Cloud Run service
- Creates or updates the Pub/Sub push subscription pointing to the service
- Creates or updates the Cloud Scheduler job for daily Gmail watch renewal

### 6. Start Gmail watch (once)

```bash
npm run renew-watch
```

This is the only manual step after deployment. Cloud Scheduler handles all subsequent renewals automatically every day at 06:00 UTC.

### 7. Install Claude workflows into each SF repo

```bash
./scripts/install-workflows.sh owner/repo [base-branch]
# For protected repos that require PRs:
./scripts/install-workflows.sh owner/repo [base-branch] --pr
```

Creates (or updates) six workflow files in the target repo's `.github/workflows/`:
- `fix-from-error.yml` — triggers on `repository_dispatch: [salesforce-error]`
- `fix-from-issue.yml` — triggers natively when an issue is labeled `claude-fix`
- `plan-from-issue.yml` — triggers when an issue is labeled `claude-plan`, then retriggers on human comments after the plan is ready; installs SF CLI and authenticates with `SF_AUTH_URL` for org metadata discovery
- `iterate-from-review.yml` — triggers natively on PR review, PR comment, or failed PR validation
- `close-awaiting-production.yml` — triggers on pushes to the configured production branch and manually via `workflow_dispatch`; closes stale `claude-awaiting-production` issues
- `init-repo.yml` — manual workflow to generate `CLAUDE.md`

Each is a thin caller that delegates to the reusable workflows in this repo.
If `base-branch` is omitted, the installer uses the target repo's default branch. For repos with a promotion chain, pass the first integration branch explicitly, for example `msmerge-release`.
For cleanup, the installer reads `productionBranch` from `pipeline.json`; if no pipeline entry exists, it uses the target repo's default branch.
If direct workflow writes are blocked by repository rules, pass `--pr`; the installer writes to `claude-install-workflows-<base-branch>` and opens a PR into the selected base branch.

### 8. Add GitHub Actions secrets to each SF repo

In each repo: Settings → Secrets → Actions

| Secret | Value |
|--------|-------|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token from `claude setup-token` |
| `SF_AUTH_URL` | `force://PlatformCLI::<token>@yourorg.sandbox.my.salesforce.com` |
| `KOMODO_PAT` | Required only for `komodohealth/*` repos; PAT used by GitHub Actions to push branches and open/update PRs without the workflow-approval gate. Automated issue/PR comments use the workflow `github.token` where available so they appear as `github-actions[bot]`. |

The generated caller workflows pass those secrets explicitly to the reusable workflows. For `komodohealth/*` repos, the installer also passes `KOMODO_PAT` as `BOT_GITHUB_TOKEN`.
`CLAUDE_CODE_OAUTH_TOKEN` can be set at the GitHub org level to share it across all repos, as long as the target repo has access to that org secret. Generate it with: `claude setup-token`.
`SF_AUTH_URL` is per-repo — each repo has its own Salesforce org credentials.

---

## Adding a new Salesforce org

1. Add an entry to `routing.json`:
   ```json
   { "newtag": "org/repo-name" }
   ```
2. If the repo has a promotion chain, add an entry to `pipeline.json`.
3. Redeploy: `./scripts/deploy.sh <gcp-project-id>`
4. Configure Salesforce to send exception emails to `salesforceerrors+newtag@gmail.com`
5. Install workflows: `./scripts/install-workflows.sh org/repo-name [base-branch]`
6. Add `SF_AUTH_URL` secret to `org/repo-name` (Settings → Secrets → Actions)

---

## Environment variables

### Cloud Run (set by `deploy.sh` from `.env`)

| Variable | Description |
|----------|-------------|
| `GMAIL_CLIENT_ID` | OAuth2 client ID from GCP Console |
| `GMAIL_CLIENT_SECRET` | OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | Obtained via `npm run auth-gmail` |
| `GMAIL_PUBSUB_TOPIC` | `projects/<project-id>/topics/sf-errors` |
| `GMAIL_FALLBACK_LOOKBACK_DAYS` | Recent Gmail window scanned when history state is missing or stale (default 1) |
| `GMAIL_FALLBACK_MAX_MESSAGES` | Maximum recent Gmail messages scanned during fallback (default 5) |
| `GMAIL_FALLBACK_MAX_AGE_MINUTES` | Maximum message age processed during fallback scans (default 10) |
| `GITHUB_TOKEN` | Default fine-grained PAT with `Contents: Read and write`, `Pull requests: Read-only`, and `Issues: Read and write`; used for `repository_dispatch`, duplicate PR checks, and awaiting-production tracking issues when no owner-specific token is configured |
| `GITHUB_TOKEN_KOMODO` | Optional Komodo-specific fine-grained PAT for `komodohealth/*` repos; same permissions as `GITHUB_TOKEN`; used before `GITHUB_TOKEN` |
| `GITHUB_TOKEN_<OWNER>` | Optional owner-specific PAT convention for other owners; same permissions as `GITHUB_TOKEN`; `deploy.sh` forwards matching variables from `.env` to Cloud Run |
| `ADMIN_SECRET` | Bearer token protecting `/admin/renew-watch` — generate with `openssl rand -hex 32` |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token from `claude setup-token` — used by Cloud Run for triage |

### GitHub Actions secrets (per repo)

| Secret | Description |
|--------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token from `claude setup-token` — also needed on Cloud Run for triage; can be set at org level |
| `SF_AUTH_URL` | SFDX auth URL for this repo's Salesforce org |
| `KOMODO_PAT` | Required only for `komodohealth/*` repos; passed to reusable workflows as `BOT_GITHUB_TOKEN` for checkout, branch pushes, and PR operations |

### Local dev only (`.env`, not deployed)

| Variable | Description |
|----------|-------------|
| `PORT` | Local server port (default 3000) |
| `DEDUP_TTL_HOURS` | Error dedup window (default 24h) |
| `MAX_CLAUDE_TURNS` | Maximum turns for fix/init/iterate Claude sessions (default 40) |
| `MAX_PLAN_TURNS` | Maximum turns for plan-only Claude sessions (default 40) |

---

## Scripts reference

| Script | When to run | Command |
|--------|------------|---------|
| `setup-gcp.sh` | Once, new GCP project | `./scripts/setup-gcp.sh <project-id> <gmail>` |
| `auth-gmail.ts` | Once, or when rotating credentials | `npm run auth-gmail` |
| `deploy.sh` | Every code change or env var update | `./scripts/deploy.sh <project-id>` |
| `renew-gmail-watch.ts` | Once after first deploy (then automated) | `npm run renew-watch` |
| `install-workflows.sh` | Once per new repo (or to update) | `./scripts/install-workflows.sh owner/repo [base-branch] [--pr]` |

---

## How Claude fixes errors

1. **Triage** — a fast Haiku call classifies the error as a code bug vs. operational noise (governor limits, lock contention, timeouts). Operational errors are skipped.

2. **Diagnose** — Claude reads the Apex class named in the exception, understands the root cause.

3. **Fix** — minimal code change. Claude does not refactor unrelated code.

4. **Test** — Claude checks for an existing test class, updates it or creates one. Tests must cover the failure scenario.

5. **Verify** — deploys to the scratch org via SF CLI, runs tests. Retries up to 3 times if tests fail.

6. **PR** — `git push` to a new branch + `gh pr create` with root cause, fix summary, and test coverage description.

7. **Iterate** — when a developer comments on the PR or the PR validation workflow fails, a new Claude session checks out the branch, reads the feedback or failed CI context, updates the code, re-runs tests, pushes, then waits for the PR validation check. If validation fails or is not confirmed, the iteration workflow fails and the PR comment says so.

8. **Plan-only issues** — when a developer labels an issue `claude-plan`, Claude reads relevant repo files and can use the authenticated SF CLI to query or retrieve org metadata for analysis, then posts an implementation plan as an issue comment. After the `claude-plan-ready` label is present, human comments on the issue retrigger the plan workflow and update the existing plan comment. It does not deploy, create a branch, commit, push, or open a PR. Add `claude-fix` later to execute.

Duplicate error emails are suppressed when an open PR already exists with the deterministic title `fix: <ExceptionType> in <ApexClassOrFlow>`. This keeps repeated Salesforce emails from opening multiple PRs for the same active fix.

If a repeat error matches a merged same-title PR that is present in pre-production but not production, Cloud Run creates or updates an `Awaiting production: ...` issue with the `claude-awaiting-production` label. The installed cleanup workflow runs on production-branch pushes and closes those issues once the tracked merge commit is contained in the configured production branch.

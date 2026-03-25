# llm-sfdc-gh

Automated Salesforce error fixing pipeline powered by Claude. When a Salesforce org throws an unhandled exception, this system receives the error email, diagnoses the root cause, fixes the code, runs tests, and opens a pull request — with no human involvement until the PR review.

Developers review the PR, leave feedback, and Claude iterates. GitHub Issues labeled `claude-fix` also trigger the same fix pipeline.

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
│  iterate-from-review.yml  ← triggered natively by PR review / comment │
│    → Claude reads feedback, updates code, pushes to same branch       │
└───────────────────────────────────────────────────────────────────────┘
```

### Multi-repo routing

Each Salesforce org sends errors to a tagged Gmail address. The `+tag` in the `To:` header determines which GitHub repo gets the `repository_dispatch` event.

**`routing.json`**
```json
{
  "dropbox":  "0cv/dropbox-dev",
  "billing":  "0cv/billing-service"
}
```

To onboard a new org: add a line to `routing.json`, redeploy Cloud Run, and configure that org to send exception emails to `salesforceerrors+yourtag@gmail.com`.

---

## Repository structure

```
.github/workflows/                      Reusable workflows (called from SF repos)
  fix-from-error.yml       on: workflow_call — error email → Claude fix → PR
  fix-from-issue.yml       on: workflow_call — GitHub issue → Claude fix → PR
  iterate-from-review.yml  on: workflow_call — PR feedback → Claude iterates

prompts/
  fix-error.md             Claude prompt: diagnose + fix from exception email
  fix-issue.md             Claude prompt: fix from GitHub issue
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
    iterate-from-review.ts Entry point for iterate-from-review workflow (fetched by GA)

routing.json               +tag → GitHub repo mapping
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
    secrets: inherit
```

---

## First-time setup

### Prerequisites

- `gcloud` CLI authenticated
- `gh` CLI authenticated
- `node` 20+
- `@salesforce/cli` installed globally

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

### 4. Deploy Cloud Run

```bash
./scripts/deploy.sh <gcp-project-id>
```

This single command:
- Deploys the Cloud Run service
- Creates or updates the Pub/Sub push subscription pointing to the service
- Creates or updates the Cloud Scheduler job for daily Gmail watch renewal

### 5. Start Gmail watch (once)

```bash
npm run renew-watch
```

This is the only manual step after deployment. Cloud Scheduler handles all subsequent renewals automatically every day at 06:00 UTC.

### 6. Install Claude workflows into each SF repo

```bash
./scripts/install-workflows.sh owner/repo
```

Creates (or updates) three workflow files in the target repo's `.github/workflows/`:
- `fix-from-error.yml` — triggers on `repository_dispatch: [salesforce-error]`
- `fix-from-issue.yml` — triggers natively when an issue is labeled `claude-fix`
- `iterate-from-review.yml` — triggers natively on PR review or PR comment

Each is a thin caller that delegates to the reusable workflows in this repo.

### 7. Add GitHub Actions secrets to each SF repo

In each repo: Settings → Secrets → Actions

| Secret | Value |
|--------|-------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SF_AUTH_URL` | `force://PlatformCLI::<token>@yourorg.sandbox.my.salesforce.com` |

`ANTHROPIC_API_KEY` can be set at the GitHub org level to share it across all repos.
`SF_AUTH_URL` is per-repo — each repo has its own Salesforce org credentials.

---

## Adding a new Salesforce org

1. Add an entry to `routing.json`:
   ```json
   { "newtag": "org/repo-name" }
   ```
2. Redeploy: `./scripts/deploy.sh <gcp-project-id>`
3. Configure Salesforce to send exception emails to `salesforceerrors+newtag@gmail.com`
4. Install workflows: `./scripts/install-workflows.sh org/repo-name`
5. Add `SF_AUTH_URL` secret to `org/repo-name` (Settings → Secrets → Actions)

---

## Environment variables

### Cloud Run (set by `deploy.sh` from `.env`)

| Variable | Description |
|----------|-------------|
| `GMAIL_CLIENT_ID` | OAuth2 client ID from GCP Console |
| `GMAIL_CLIENT_SECRET` | OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | Obtained via `npm run auth-gmail` |
| `GMAIL_PUBSUB_TOPIC` | `projects/<project-id>/topics/sf-errors` |
| `GITHUB_TOKEN` | PAT with `contents` + `pull-requests` write on all repos in `routing.json` |
| `ADMIN_SECRET` | Bearer token protecting `/admin/renew-watch` — generate with `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | Anthropic API key — used by Cloud Run for triage |

### GitHub Actions secrets (per repo)

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key — also set on Cloud Run for triage; can be set at org level |
| `SF_AUTH_URL` | SFDX auth URL for this repo's Salesforce org |

### Local dev only (`.env`, not deployed)

| Variable | Description |
|----------|-------------|
| `PORT` | Local server port (default 3000) |
| `DEDUP_TTL_HOURS` | Error dedup window (default 24h) |

---

## Scripts reference

| Script | When to run | Command |
|--------|------------|---------|
| `setup-gcp.sh` | Once, new GCP project | `./scripts/setup-gcp.sh <project-id> <gmail>` |
| `auth-gmail.ts` | Once, or when rotating credentials | `npm run auth-gmail` |
| `deploy.sh` | Every code change or env var update | `./scripts/deploy.sh <project-id>` |
| `renew-gmail-watch.ts` | Once after first deploy (then automated) | `npm run renew-watch` |
| `install-workflows.sh` | Once per new repo (or to update) | `./scripts/install-workflows.sh owner/repo` |

---

## How Claude fixes errors

1. **Triage** — a fast Haiku call classifies the error as a code bug vs. operational noise (governor limits, lock contention, timeouts). Operational errors are skipped.

2. **Diagnose** — Claude reads the Apex class named in the exception, understands the root cause.

3. **Fix** — minimal code change. Claude does not refactor unrelated code.

4. **Test** — Claude checks for an existing test class, updates it or creates one. Tests must cover the failure scenario.

5. **Verify** — deploys to the scratch org via SF CLI, runs tests. Retries up to 3 times if tests fail.

6. **PR** — `git push` to a new branch + `gh pr create` with root cause, fix summary, and test coverage description.

7. **Iterate** — when a developer comments on the PR, a new Claude session checks out the branch, reads the feedback, updates the code, re-runs tests, and pushes.

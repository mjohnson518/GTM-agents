# Ship loop: product feedback to shipped code

For deployers who turn on the optional Ship module, and for contributors extending it.

The Ship loop turns product feedback into small, reviewed code changes. It groups feedback into themes, scores the themes by demand, writes a specification for the strongest, asks a person to approve it, builds the change in a sandbox, opens a pull request, and tells the people who asked once it is live.

The code lives in `packages/modules/ship` (`@gtm-agents/modules/ship`). It has two sides that meet only in `src/contract.ts`: the planning side (themes, specs, approval, the path policy and the notes, described on this page up to the build section) and the build side (the sandbox, the workflow and the pull request). Two rules hold across both:

- **Raw feedback text never reaches the build side.** Feedback is full taint. The triage model reads it fenced in its user turn; everything after that works from the model's neutral summary, and the coding agent sees only the approved `ShipSpec`.
- **Nothing merges on its own.** A ship task ends at an open pull request. Merging code is permanently human (`merge_code` in `PERMANENT_HUMAN`, [AUTONOMY.md](AUTONOMY.md)).

## How the planning side works

1. Product feedback arrives through the product bridge into `feedback_items` with status `new` ([LIFECYCLE.md](LIFECYCLE.md)).
2. The daily `ship_themes` job triages each item, closes what cannot be acted on, embeds the summary of what can, joins it to the nearest live theme or starts a new one, and rescores every live theme.
3. The daily `ship_specs` job writes a spec for each open theme at or above the score threshold. A spec that is infeasible, high risk or touches a denied path declines its theme on its own.
4. A person approves a spec with `ship-approve-<id> <code>`, bound to the digest of exactly that spec. At an earned level, a low-risk spec approves itself.
5. Approving queues a `ship_tasks` row and calls the build side's `StartShipBuild`. The build side runs the coding agent, applies the path policy to the exact files it would commit, and opens a pull request.
6. Once a production deploy that contains the merge commit succeeds, the build side calls `AnnounceShipped`: the theme is marked shipped, the operator is paged, and the people who asked get a "you asked, it is live" note, drafted for approval or sent at an earned level.

## Turning it on

Everything is off until you turn it on, in this order:

1. `modules: { ship: { enabled: true } }` in `gtm.config.ts`. While it is false the jobs skip, the commands refuse and `AnnounceShipped` changes nothing.
2. Model roles in `gtm.config.ts`: `triage` (with a price), `embedding` (the gateway reports its cost) and `strategist` (with a price). A role with no model is unavailable, and the step that needs it waits.
3. An approved `lifecycle` template with id `ship-live` (or the id you pass as `noteTemplateId`) in your `templates/` folder, validated and uploaded like every other template ([BRAIN-SCHEMA.md](BRAIN-SCHEMA.md)). [The note template](#the-note-template) below shows one. Without it, no note is drafted.
4. The flags, each needing `ship:enabled` as well: `ship:themes_enabled`, then `ship:specs_enabled`, then `ship:notes_enabled` once the build side is wired.
5. Autonomy stays at level 1 for `ship_spec` and `ship_notification` until you raise it with `autonomy-set` ([AUTONOMY.md](AUTONOMY.md)).

## Themes

The `ship_themes` job runs daily at 06:10 UTC. Each run has three phases, each bounded by the job's row ceiling (50 items by default), its daily spend cap (50 cents) and its time (10 minutes):

1. **Triage.** Items with status `new`, oldest first, one schema-bound call each (role `triage`). The feedback goes into the user turn inside a quarantine fence it cannot close; the system prompt holds only fixed instructions. The answer must be exactly `{actionable, category, priority, summary, affected_area}` with values from their enums. The summary is cleaned (links, addresses, control characters, dashes and injection patterns removed, 240 characters at most). An item that cannot be acted on (praise, a question, a billing request, anything unclear) is closed as `declined`; an actionable one becomes `triaged`. An answer that cannot be used counts an attempt, and the third declines the item. A refusal before any call (no model, no price, the budget) stops the phase and counts nothing.
2. **Theming.** Triaged items with no theme have their summaries embedded in one call (role `embedding`). Each joins the nearest live theme whose centroid came from the same embedding model when the cosine similarity is 0.83 or more (`joinThreshold`); otherwise it starts a theme of its own. A theme's centroid is the running mean of its members' vectors, stored in D1 (`themes.centroid`, with `centroid_model` and `member_count`) and moved with a compare-and-set on the member count. Live themes are those not yet shipped, declined or failed, so a request for something already being built still counts toward it, and its requester still hears when it ships.
3. **Scoring.** Every live theme of the repository is rescored from the database:

   `score = (demand + 3 * paying requesters + requester MRR / ARPA) * priority weight`

   Demand counts distinct requesters (a contact, a product user, or an item with neither). Paying requesters are those whose lifecycle state is `paying`, `expanding` or `at_risk`, and requester MRR is their monthly revenue. ARPA is the current MRR over the paying count from `@gtm-agents/core/metrics`; while nobody pays, the MRR term is 0. The weight follows the highest priority among the theme's items: critical 4, high 2.5, normal (medium) 1.5, low 1.

## Specs

The `ship_specs` job runs daily at 06:40 UTC and writes at most 3 specs a run (role `strategist`, $1 a day), for open themes at or above `specThreshold` (6 by default), highest score first.

What the strategist reads, all in its user turn and each block fenced as data: the target repository's engineering contract (from `readEngineeringContract`, capped at 30,000 characters), the theme's demand numbers, and up to 25 neutral summaries. The system prompt holds the fixed instructions and the denied-path globs from configuration. Raw feedback is never sent. Without an engineering contract, no spec is written and the themes wait.

The answer is parsed fail-closed: exactly the `ShipSpec` fields and types, text cleaned and capped, every file a plain repository-relative path (the path policy's path rules), an adoption event that is `null` or a product event name such as `custom.report_exported`, and no text that reads like an instruction to a model. A spec that shares a run of 60 characters with any of the theme's raw feedback is not used either. An unusable answer counts an attempt; after 3 the theme is left for a person.

A usable spec is stored on the theme (`themes.spec`, canonical JSON) with `spec_digest`, the SHA-256 of its exact content and the theme id. Its risk is never lower than its files imply: more than five files is at least medium, and a dependency manifest is high. The theme then declines itself, keeping the spec so you can see why, when the spec is not feasible, is high risk, or names a file that matches a denied glob. Otherwise it becomes `spec_ready` and you are told.

## Approval

`ship-spec-<id>` shows a theme, its demand, its summaries and its spec, with the exact command that approves it: `ship-approve-<id> <code>`, where the code is the first 32 hex characters of the spec's digest. Approving:

- refuses a code that is not the current spec's and shows the current spec again;
- sends a spec edited in the database after it was written back to review: its stored digest is replaced and its new code shown, and nothing is approved;
- in one transaction, creates the `ship_tasks` row (status `queued`, the repository, the base branch and the spec's risk) only while the theme still waits with that digest, and moves the theme to `approved`, so two approvals at once create one task;
- calls `StartShipBuild` with the task id. If the build does not start (a missing binding, `ship:enabled` off), the task stays queued and the same approve command tries again; `StartShipBuild` is idempotent per task;
- records `approved_unchanged` evidence for `ship_spec`.

`ship-decline-<id> [reason]` closes a theme that is open or has a spec waiting, and records `rejected` evidence when a spec was declined.

**Automatic approval.** While `ship_spec` is at level 2 or above (read through the autonomy module's reader, which fails closed to 1), the `ship_specs` job approves the highest-scoring low-risk specs on its own, at most 2 a run whatever the options say. Medium risk always waits for a person. Each records `auto_sent` evidence; at level 2 you are told.

## Path policy

`evaluatePathPolicy(files, config)` in `src/path-policy.ts` is pure and deterministic. The build side runs it on the exact files it is about to commit. It returns `refuse` with every reason, or `allow` with a risk, whether a person reviews before the pull request opens, the reasons, and the file and line counts.

A change is refused when:

- the repository is not on `allowedRepos` (owner/name, compared without case);
- a path is not a plain repository-relative path: empty, absolute (a leading slash, a drive letter, a backslash), a `.` or `..` segment, an empty segment, a leading `-` or `~`, a colon, a control, zero-width or direction character, a character that changes under Unicode normalization, `.git` in any spelling (`.GIT`, `.git.`, `git~1`), `.gitmodules`, a reserved device name, or over 400 characters or 32 segments;
- a path, or a rename's previous path, matches a denied glob, or two paths differ only by case;
- a file is a symlink (`120000`), a submodule (`160000`), or has any mode but `100644` or `100755` (`000000` is accepted for a deletion);
- content contradicts the change, a rename has no previous path, or a line count is not a whole number;
- content looks like a secret: a private key block or a known credential format, in text or in decoded binary content;
- a file is over 512 KiB, or the change is over 2,000 lines, 60 files or 2 MiB.

`DEFAULT_DENIED_PATHS` covers authentication and sessions, middleware, billing and pricing, privacy and legal, security, CI, hooks, build and deploy configuration, keys and environment files, and internal and admin APIs. Matching ignores case, and a glob that matches a directory denies everything under it. The defaults always apply; `config.deniedPaths` (and the factory's `deniedPaths` option) only add to them. `DEFAULT_LIMITS` are the defaults for the thresholds, and the hard caps can only be lowered.

An allowed change is low risk, medium above 120 lines or 5 files, and high for any binary file or dependency manifest or lock file (`package.json`, lock files, `go.mod`, `Cargo.toml`, `requirements*.txt` and the like). It needs review above 400 lines or 15 files, or at high risk.

## When it ships: the notes

`AnnounceShipped(env, taskId, now)` re-reads the task and its theme from the database, takes nothing else from its caller, and never throws:

1. The theme and its feedback items are marked `shipped` (a theme already shipped keeps its first `shipped_at`).
2. With `ship:notes_enabled` on, a note is prepared for each requester who resolves to a contact (the item's contact, or the contact whose product user id it carries) and is a product user, the same condition the send function holds lifecycle mail to. Anyone who cannot be resolved is counted and skipped; erased or suppressed people, people with no usable first name, and anyone the quality gate holds are skipped with the reason. At most 50 notes a theme. One `ship_notes` row per (theme, contact) is the claim, so a second announcement drafts nothing new.
3. You are paged once per theme with what happened.

The note writer never writes copy: it fills the approved template with the requester's first name, the agent's name, the booking URL and the approved spec's title (cleaned, and refused when it is not fit for mail). Notes are plain text and go out only through the shared send function, on path `lifecycle`, with the draft's digest as its approval, which the send function verifies again with every other check. While `ship_notification` is at level 2 or above and a send function is wired, a note is sent at once (a send that definitely did not happen returns it to you as a draft). Otherwise you get the draft with its command: `ship-note-approve-<id> <code>` sends exactly that version after checking the person again (suppression, erasure, still a product user), and `ship-note-decline-<id>` drops it. A note can be approved for 14 days. A note's draft has kind `lifecycle` and action class `ship_notification`, so the dashboard's generic approve does not take it, and only these commands send it.

### The note template

A `lifecycle` template the note writer can fill. It may use `{{first_name}}`, `{{sender_name}}`, `{{booking_url}}` and `{{attributes.shipped_title}}`, which is the approved spec's title; any other variable has no value here and skips every note. Leave out the unsubscribe line and the footer: the send function adds them.

```markdown
---
id: ship-live
kind: lifecycle
status: approved
subject: The change you asked for is live
---
Hi {{first_name}},

A while ago you told us what you wanted from Acme. We built it, and it is live now: {{attributes.shipped_title}}.

Thank you for taking the time to write in. If it does not work the way you hoped, just reply and tell me what is missing.

{{sender_name}}
```

## Operator commands

They run in the operator chat, never reach the model, and refuse while `modules.ship.enabled` or `ship:enabled` is off. An approve command without its code only shows what an approval would cover.

| Command | What it does |
|---|---|
| `ship-themes` | The live themes, highest score first |
| `ship-spec-<id>` | One theme with its demand, summaries and spec, and the command that approves exactly that spec |
| `ship-approve-<id> <code>` | Approve the spec, queue its task and start its build; again, retry a build that did not start |
| `ship-decline-<id> [reason]` | Decline a theme that is open or has a spec waiting |
| `ship-note-approve-<id> <code>` | Send a drafted note, checked again first |
| `ship-note-decline-<id>` | Drop a drafted note |

## Flags

| Flag | Default | Effect |
|---|---|---|
| `ship:enabled` | off | The module's switch. Every step below needs it |
| `ship:themes_enabled` | off | The `ship_themes` job |
| `ship:specs_enabled` | off | The `ship_specs` job, including automatic approval |
| `ship:notes_enabled` | off | Drafting and sending notes, and the note commands |
| `autonomy:ship_spec` | 1 | At 2 or above, low-risk specs approve on their own, 2 a run |
| `autonomy:ship_notification` | 1 | At 2 or above, notes are sent without a person |

A flag that cannot be read is off, and an unreadable level is 1.

## Jobs and ceilings

| Job | Schedule (UTC) | Roles | Rows a run | Spend a day | Time |
|---|---|---|---|---|---|
| `ship_themes` | 06:10 daily | `triage`, `embedding` | 50 items (`maxTriagePerRun`) | 50 cents | 10 minutes |
| `ship_specs` | 06:40 daily | `strategist` | 3 specs (`maxSpecsPerRun`), 2 automatic approvals | $1 | 10 minutes |

Every model call goes through the spend gate first (the job's daily cap, the global limits and the run ceiling, failing closed) and is recorded in the cost ledger after. Each run leaves a run row whose summary says what happened. The factory refuses a schedule that would call a model more than four times an hour or twice within 15 minutes.

## Failure behavior

- **Gates fail closed.** An unreadable flag is off; an unreadable level is 1; an unreadable suppression list holds the note; a budget that cannot be read stops the phase; a missing engineering contract writes no spec.
- **Bookkeeping fails open.** Operator notices, autonomy evidence and cost records that fail are logged and dropped.
- **One item never stops the others.** A triage, theming, spec or note failure is counted in the run summary and retried on the next run.
- **Model output is data.** Answers that are not exactly the schema are not used, and nothing from feedback or a model's answer is ever placed in a system prompt.
- **AnnounceShipped never fails its caller,** and a page that could not be delivered is released so a later announcement can try again.

## Wiring

```ts
import { createShipPlanning } from "@gtm-agents/modules/ship";

const planning = createShipPlanning<Env>({
  config,
  repo: "acme-example/quarantine",      // owner/name the specs and tasks are for
  baseBranch: "main",
  startBuild,                           // from the build side
  readEngineeringContract,              // from the build side: (env) => Promise<string | null>
  model: (env) => modelGateway(env),
  operator: (env) => operatorChannel(env),
  send: (env) => createOutreachSender(senderDepsFromEnv(env, { config, provider: emailProvider(env) })),
  templates,                            // optional: bundled templates; otherwise the approved ones in KV
  options: { specThreshold: 6, deniedPaths: ["migrations/**"] },
});

export default createWorker(config, {
  jobs: [...otherJobs, ...planning.jobs],
  commands: planning.commands,
  // ...
});
```

`planning.announceShipped` is the `AnnounceShipped` the build side calls, and `planning.evaluatePathPolicy` the path policy it runs. `createWorker`'s `commands` option is how any optional module adds operator chat commands: each `ModuleCommand` (`@gtm-agents/core/operator`) is matched after the allowlist, the agent flag and every built-in command, runs once per message, cannot take a built-in name (`/clean`, `/status`, `/help`, `/start`), and adds its help lines to `/help`. A handler that throws is answered with a generic error and leaves a `module_command_failed` audit row.

## Data

Migration `0029_ship_planning.sql` adds to the tables from `0013_ship.sql`:

- `themes.centroid`, `centroid_model` and `member_count`: the running-mean centroid and what it averages;
- `themes.spec_digest` and `spec_attempts`: what an approval binds to, and how many spec answers were unusable;
- `feedback_items.triage_attempts`;
- `ship_notes`: one row per requester of a shipped theme, with the draft it belongs to, its level, status and reason. Erasing a contact deletes their notes.

## The build: sandbox, workflow and pull request

The build side turns an approved spec into an open pull request and then follows that pull request until its change is live. It lives in the same package (`src/build.ts`, `workflow.ts`, `gatekeeper.ts`, `risk.ts` and `webhooks.ts`) and reaches the outside world through two ports with one adapter each ([INTERFACES.md](INTERFACES.md)):

| Port | Adapter | What it does |
|---|---|---|
| `CodeHost` | `code-github` | Reads files, makes one commit per task (in the target repository or in a fork of it), opens the pull request, compares commits, verifies webhooks. It has no way to merge |
| `CodingSandbox` | `sandbox-cloudflare` | Runs the coding agent in a Cloudflare Container that holds no credentials |

It is optional on top of the planning side. Without it, wire `startBuild` to a function that answers `{ started: false, reason }` and approved tasks wait as `queued`. It needs a Cloudflare plan with Containers.

### What runs where

| Piece | Where it runs | Credentials it holds |
|---|---|---|
| The coding agent (`claude` or `opencode`) | A container, one per ship task | None |
| `ShipSandbox`, a Durable Object | The Worker | None. It starts the container and runs each step in it |
| `ShipSandboxEgress`, a Worker entrypoint | The Worker | The git token and the model key, attached to the requests it lets through |
| `ShipBuildWorkflow`, a Workflow | Cloudflare Workflows | Whatever the adapters read from the Worker's secrets |
| The gatekeeper | A step of the Workflow | The code host tokens (`GITHUB_TOKEN`, and `GITHUB_FORK_TOKEN` with a fork), through `code-github` |

### The build, step by step

`StartShipBuild(env, taskId, now)` creates one Workflow instance whose id is the task id, so calling it again for the same task finds the first build instead of starting a second. The Workflow then runs:

1. **Load.** The task must be `queued` or `running`, its theme approved with a feasible spec, and its repository on both the path policy's and the code host's allowlist. The task becomes `running` and the theme `building`.
2. **Clone and install.** A fresh container starts with internet access off. The base branch is cloned (depth 1, read-only, through the Worker), the commit it checked out is recorded as the base, and the install command runs (`npm ci --ignore-scripts` by default, so no dependency's install script runs while the registry and the model route are open; set `options.install` if your repository needs them).
3. **Run the agent.** The approved spec is written to `/workspace/task/spec.json` and the agent starts with a fixed instruction that points at it. The spec is the only description of the request the agent gets: no feedback text, no theme, no requester.
4. **Wait.** Each step runs in the background in the container. The Workflow sleeps and asks for its status (every 60 seconds for the agent), so nothing holds a long call open.
5. **Run the checks.** The checks command runs in the repository (`npm run check` by default). If it fails, the agent gets one repair round, with the checks' output in a file, and the checks run once more. A second failure fails the task.
6. **Collect.** A script in the image stages the work tree and writes every changed file against the recorded base commit. The Worker validates that output (paths, modes, encodings, sizes), stores it in the bucket under a key that carries its SHA-256, and stops the container.
7. **Evaluate.** The files are first normalized against the base commit read from the code host: whether each is added, changed or deleted, whether it is binary, and an upper bound on its changed lines. The container's own counts are never used. Then `EvaluatePathPolicy` runs on those files. A refusal ends the task as `refused`.
8. **Risk approval.** When the result is high risk (from the policy or the spec) or over the review thresholds, the task waits as `proposed` and you are sent `ship-risk-approve-<task> <code>`. The Workflow waits up to 7 days; without an approval the task is `parked`. If the message cannot reach you (no operator channel, or the channel fails), the task is parked at once, since nobody can approve a change they were never shown.
9. **Gatekeeper.** The stored files are read again and checked against their digest, the policy runs again on exactly those files, and only then is one commit made on `ship/<task>` (in the target, or in its fork) and the pull request opened in the target. The task and the theme become `pr_open`.
10. **Announce.** You are told, with the link. Merging is yours.

Every step is a `step.do`, so a retry or a replay after the Workflow sleeps repeats nothing that already happened, and each step is safe to repeat: starting a sandbox step twice starts it once, the commit and the pull request are idempotent per task, and each notice is claimed in the effects ledger first.

### The sandbox

The container is started with `enableInternet: false`. Every HTTP and HTTPS request it makes is routed to `ShipSandboxEgress` in the Worker, which decides it. Specific hosts are registered first and a catch-all that denies is registered last, so nothing unlisted is reachable, on any port.

| Destination | What is let through | Credential |
|---|---|---|
| The git host (`github.com`) | During the clone only: `GET /<repo>.git/info/refs?service=git-upload-pack` and `POST /<repo>.git/git-upload-pack` for the task's repository. Push (`git-receive-pack`), other repositories, archives and every other path are refused. Once the clone is done the host is closed | The Worker attaches `GITHUB_TOKEN`; the clone URL in the container carries none |
| The package registries (`registry.npmjs.org`, or `registryHosts`) | `GET` and `HEAD` of package paths with no query string | None. A private registry is not supported |
| The model API of the active profile | `POST` to the completion endpoint (and token counting) only | The Worker attaches the key and drops what the container sent |
| Everything else | Refused with 403 | |

Before a model request is forwarded, the Worker:

1. checks the gate, and refuses if it is closed or cannot be read: the system halt, `ship:enabled`, `ship:builds_enabled`, the budget (below);
2. counts the request against the task's limit of 80, in the sandbox's own storage, and refuses past it;
3. holds one of the task's two in-flight slots, and refuses with 429 (which the agent retries) while both are taken. The budget is read before a call and its cost recorded after, so calls in flight together can pass the gate on the same reading: this keeps that overshoot to at most two calls of at most 32,000 output tokens each. A slot is freed when the call's usage has been recorded, and on its own after 15 minutes if that never happens;
4. keeps only the request fields it knows (for the Anthropic API: the messages, the system prompt, the output cap, sampling, tools, tool choice, thinking, context management and output settings; for an OpenAI-compatible API, their equivalents) and drops everything else, so a service tier, a router's fallback models or plugins, or a server-side feature added later never reaches the provider. It rewrites `model` to `models.roles.coder` from `gtm.config.ts`, whatever the agent asked for, and caps the output at 32,000 tokens;
5. strips server-side tools (web search, web fetch, code execution, tool search, remote MCP servers, the advisor) and the beta flags that turn them on, and refuses a request that asks the provider to fetch a URL;
6. drops the container's headers for a short allowlist and attaches the key.

After the response, the usage the provider reported is priced from `models.pricing` and written to the cost ledger. That write is bookkeeping: it never delays or fails the response. A response that ends before its final usage (cut off, unreadable, or from a provider that never reports usage) is charged at the worst case the request allowed: its output cap, and its size as input when no input count arrived. A provider that does not report usage on a streamed response is therefore charged the worst case every time; use one that does.

**Agent profiles.** `adapters.sandbox-cloudflare.options.profile` picks the agent, and each profile has its own image under `packages/adapters/sandbox-cloudflare/images/<profile>/Dockerfile`, built on the `cloudflare/sandbox` helper image whose tag matches the installed `@cloudflare/sandbox` version, with the agent CLI pinned to an exact version:

| Profile | Agent | Notes |
|---|---|---|
| `claude-code` (default) | Headless `claude --print` with a turn limit | Its web tools and MCP servers are disabled, and it runs without permission prompts because the container is what limits it |
| `opencode` | `opencode run` | For other model providers: the Anthropic Messages API, or an OpenAI-compatible Chat Completions API with `modelApi: "openai"`. Its web tools are disabled in its config |

Point either at Cloudflare AI Gateway with `modelBaseUrl` (the gateway's provider URL) and `AI_GATEWAY_TOKEN`; with `byok: true` the gateway supplies the vendor key it stores. The gateway token is sent only when `modelBaseUrl` is set, never to the vendor's own API.

**Limits.**

| Limit | Default | Enforced by |
|---|---|---|
| Model requests per task | 80, across the agent round and the repair round | The Worker, before forwarding |
| Inactivity | 45 minutes | The container stops when nothing calls its Durable Object |
| Time per command | Clone and install 15 minutes, agent 40, checks 15 | `timeout` in the image, which stops the whole process group |
| Changed content | 2 MB in all, 512 KB a file, 100 files | The collector in the image, then the Worker again on what it reports |
| Spec | 64 KB | The sandbox, before it writes the file |
| Model spend | $20 a day for job `ship_build`, and `budget:run_ceiling_cents` ($10) per task | The budget gate, before forwarding |

`adapters.sandbox-cloudflare.options.limits` and `dailySpendCents` can lower these and never raise the size and turn limits.

### The gatekeeper and the risk approval

The path policy decides, and the gatekeeper makes sure that what it decided on is what lands:

- The collected files are stored once as canonical JSON. Their SHA-256 is part of the storage key, and every later step re-reads the bytes and checks them against it.
- A change that needs a person is committed only with an approval of that digest. The code in `ship-risk-approve-<task> <code>` is 8 hex characters derived from the task id and the digest, so it does not carry to another task or to other files. The command re-reads the stored change, compares the code in constant time, and sends the Workflow the digest; the Workflow and then the gatekeeper each check it again.
- The commit goes through the git data API: one tree on the base commit's tree, one commit whose only parent is the base commit, and the ref `ship/<task>`, in the target repository or, with a fork configured, in the fork ([CI and the ship branch](#ci-and-the-ship-branch)). A retry that finds the branch at a commit with the same tree and parent uses it. A branch holding anything else is refused. The target's base branch is never written and no ref is forced.
- With a fork, the fork's copy of the base branch must reach the base commit first. When it is only behind the target's, the adapter syncs it (GitHub's merge-upstream, which then fast-forwards it); when it already reaches the base commit, it is left alone. A copy with commits of its own is refused rather than merged, and so is a fork that is not a fork of the target. The commit and the sync use `GITHUB_FORK_TOKEN`; opening the pull request uses `GITHUB_TOKEN`, and neither token is sent to the other repository.
- The pull request body carries the spec's problem, approach, acceptance criteria, tests and out-of-scope list, the gatekeeper's risk and counts, and the line `Ship-Task: <task>`.

Nothing in the build can merge. `CodeHost` has no merge method, and `merge_code` is permanently human ([AUTONOMY.md](AUTONOMY.md)).

### Webhooks and deploy detection

`routes(app)` mounts `POST /api/webhooks/code`. The adapter verifies `X-Hub-Signature-256` in constant time before the body is parsed and before any flag or database read: a bad or missing signature answers 401, an unset secret 503, an unreadable payload 400. After that, `ship:enabled` off answers 503, and each delivery is claimed once by a digest of what the signature covered (the event name and the body), so a redelivery does nothing, and neither does a captured payload sent again under a new delivery id, which GitHub does not sign.

The task is always re-resolved from what the code host says, never from an id in the payload:

| Event | Resolved by | Effect |
|---|---|---|
| Pull request merged | Repository and pull request number | Task `merged` with the merge commit; theme `merged` |
| Pull request closed without merging | Repository and pull request number | Task `closed`; theme `declined`. Reopening restores both to `pr_open` |
| New commits on the pull request | Repository and pull request number | The head commit is updated and the checks reset to `pending` |
| A check run, check suite or commit status fails | Repository and head commit | The task's checks are marked `failure` and you are told, once per commit |
| A deployment succeeds | Repository, then each merged task's merge commit against the deployed commit | When the environment is one of `productionEnvironments` (default `production`) or the code host marks it as production: every merged task whose merge commit the deployed commit contains becomes `deployed`, then `AnnounceShipped` for each |

With a fork, the webhooks still come from the target repository: add the webhook there, not in the fork. A pull request from the fork is resolved by the target repository and its number, like any other.

**Deploy detection.** A successful deployment of commit X to a production environment marks deployed every `merged` task of that repository whose merge commit X contains: X is the merge commit itself, or the code host's `contains` says the merge commit is in X's history (for GitHub, the compare API answers `ahead` or `identical`). A deploy that batches several merges, or a deploy of a later commit, therefore marks each merge it carries, and `AnnounceShipped` runs once per task. Each delivery checks at most 20 merged tasks (`MAX_DEPLOY_CANDIDATES`), the newest first, with a task merged as exactly X checked before the rest; any older ones wait for the next production deploy.

A comparison that fails (the code host is down, rate limited or refuses) is never taken as an answer: that task, and any not yet checked, stay `merged`, the tasks already found stay `deployed`, and the delivery answers 500 and is released. Redeliver it from the webhook's recent deliveries, or let the next production deploy, which carries the same merges, mark them.

Deploy detection needs your deploys to reach the code host as deployments (for example a GitHub Actions job with `environment: production`). Without them a merged task stays `merged` and no note is drafted. A failure inside `AnnounceShipped` is logged and never fails the webhook. The Worker refuses request bodies over 100 KB, which is above what these events normally carry.

### Statuses

| `ship_tasks.status` | Meaning |
|---|---|
| `queued` | Approved, waiting for a build. A build that finds a gate closed as it starts puts the task back here |
| `running` | The Workflow is building it |
| `proposed` | The change waits for `ship-risk-approve` |
| `pr_open` | The pull request is open |
| `refused` | The path policy, the gatekeeper or a sandbox limit refused the change |
| `failed` | The clone, the agent or the checks failed, or the task could not be built |
| `parked` | A gate closed mid-build, or no risk approval arrived in 7 days |
| `merged`, `closed`, `deployed` | Set by the webhooks |

A task that ends as `refused`, `failed` or `parked` moves its theme to `failed`; `error` and `policy_reasons` on the task say why, and the build log is in the bucket at `log_key`. That log comes out of the container, so it is untrusted text for a person to read and is never shown to a model.

### Enabling the build

1. **Plan and tools.** Containers need a paid Workers plan. `wrangler deploy` builds the sandbox image with Docker, so Docker must be running where you deploy, even for `--dry-run`. Without Docker, push the image once from a machine that has it and reference it by digest in `images` instead of a Dockerfile path.
2. **`gtm.config.ts`.** Set `modules.ship.enabled`, a `coder` model in `models.roles` with a price in `models.pricing` (an unpriced model is never called), `adapters["code-github"].options.repos` with the repositories the loop may touch, and `adapters["sandbox-cloudflare"].options` for the profile. To push the ship branches to a fork instead of the target, also set `adapters["code-github"].options.forks`, for example `{ "acme-example/quarantine": "acme-ship-bot/quarantine" }`, after creating that fork under an account or organization of its own (a private repository can only be forked where its organization allows forking private repositories). [CI and the ship branch](#ci-and-the-ship-branch) compares the two modes. `examples/ship/gtm.config.ts` shows all of these.
3. **`wrangler.jsonc`.** Add the `containers` entry with the image for your profile, the `SHIP_SANDBOX` Durable Object binding with its SQLite class in a new migration tag, and the `SHIP_BUILD` Workflow binding. `examples/ship/wrangler.jsonc` has each block marked.
4. **Worker entry.** Export the sandbox class, the egress entrypoint and the Workflow class under the names `wrangler.jsonc` uses, and pass the build's commands and routes to `createWorker`. `examples/ship/src/index.ts` is a complete entry.
5. **CI isolation.** Confirm what [CI and the ship branch](#ci-and-the-ship-branch) lists for your mode: without a fork, that no workflow run for a `ship/` branch gets a secret or a write token; with a fork, that no `pull_request_target` or `workflow_run` workflow runs a pull request's code and that fork pull request workflows get no secrets. Then set `shipBranchCiIsolated: true` in `adapters["code-github"].options`. Until then no branch is pushed, and each build stops before it starts with a reason that names what to confirm.
6. **Secrets**, with `wrangler secret put`. They are used only from the Worker and never reach the sandbox:
   - `GITHUB_TOKEN`: a fine-grained token limited to the listed repositories. Without a fork: contents read and write, and pull requests read and write. With a fork, contents read is enough on the target (the clone, file reads and commit comparisons), with the same pull request access. Check and status results arrive by webhook, so the token needs no access to them;
   - `GITHUB_FORK_TOKEN`, only with `forks`: a fine-grained token whose resource owner is the forks' owner, limited to the forks, with contents read and write. A fine-grained token reaches one resource owner, which is why the fork needs a token of its own. All forks must be under one owner. Without this token every build stops before it starts and says so;
   - `GITHUB_WEBHOOK_SECRET`: the secret you give the webhook;
   - the model key for the profile: `ANTHROPIC_API_KEY`, or the secret named in `modelKeySecret`.

   With a fork, create both GitHub tokens from the account that owns the fork, and make that account a member of the target's organization. GitHub requires whoever opens a pull request in a public repository to have write access to its head branch, and a fine-grained token does not work where its account is only an outside collaborator. Check on a scratch pair of repositories that the pull request opens (step 10) before you rely on it.
7. **Code host webhook.** In each target repository (never the fork), add a webhook to `https://<your agent host>/api/webhooks/code` with content type `application/json`, the secret above, and these events: pull requests, check runs, check suites, statuses and deployment statuses.
8. **Deploy**, then run `gtm doctor`.
9. **Flags.** `ship:enabled`, then `ship:builds_enabled`. Set `budget:job:ship_build:daily_cents` if you want a daily cap below the default.
10. **First build.** Point the loop at a scratch repository first, approve one small spec, and read the task's log and its pull request before you trust it with a real one. Check there that the agent's model calls succeed with your model and key, since the agent CLI and the model are yours to pair.

### CI and the ship branch

The gatekeeper pushes one commit to a branch named `ship/<task>` and opens the pull request from it. Pushing it makes CI run code the agent wrote (its tests, and anything those tests import) before any person has reviewed it. The sandbox holds no credentials, but your CI may: repository secrets and a `GITHUB_TOKEN` that can write. Code the agent was tricked into writing (by text in the repository or in a package it installed) would run there.

`code-github` pushes the branch to one of two places, and what you must check about CI differs:

| Mode | Where `ship/<task>` is pushed | The pull request | How CI treats it |
|---|---|---|---|
| Same repository (the default) | The target repository | In the target, from its own branch | Like any branch of the target: every workflow that runs on it gets the target's secrets and token unless you keep them away |
| Fork (`options.forks`) | A fork of the target, under another owner | In the target, from `<fork owner>:ship/<task>` | Like any pull request from a fork: GitHub gives its `pull_request` workflows no secrets and a read-only token unless a setting or a workflow hands them out |

The fork mode starts from GitHub's own isolation for fork pull requests, so it is the safer one to set up. In either mode the adapter pushes nothing until you set `shipBranchCiIsolated: true` in its options, which states that you have checked the list for your mode. Until you do, every build stops before it starts, with a reason that names what to confirm (both lists, each with its repositories, when only some repositories have a fork).

**Same repository: what to confirm.** No workflow run for a `ship/` branch gets a secret or a write token. Ways to get there in GitHub Actions, from strongest:

- **Keep every secret in an environment with required reviewers** (Settings, Environments), and reference secrets only from jobs that use that environment. A run for a `ship/` branch then waits for a person before any secret is handed out. Set the workflow's default `permissions:` to `contents: read`.
- **Skip secret-using jobs for ship branches:** add `if: ${{ !startsWith(github.head_ref || github.ref_name, 'ship/') }}` to every job that reads a secret or needs write permissions, and keep the default `permissions:` read-only.
- **Use a repository whose CI has no secrets at all**, such as a scratch copy, while you evaluate the loop.

**Fork: what to confirm.** Nothing hands a fork pull request's code a secret or a write token:

- **No `pull_request_target` workflow checks out or runs the pull request's code.** Such a workflow runs in the target, with its secrets and a write token, whatever the approval settings say. One that checks out `github.event.pull_request.head.sha`, `head.ref` or `refs/pull/<number>/merge` and then installs, builds or tests it runs the agent's code with your secrets. A `pull_request_target` workflow that only labels or comments, and never checks out the head, is fine.
- **No `workflow_run` workflow runs code or artifacts from the pull request's run.** It is triggered by the fork pull request's workflow and runs with the target's secrets, so an artifact the pull request built is as untrusted as its code.
- **Fork pull request workflows get no secrets and no write token.** In a public repository GitHub never sends them. In a private or internal repository, leave "Send write tokens to workflows from pull requests" and "Send secrets to workflows from pull requests" off (Settings, Actions, General, and the same policy at the organization level).
- **Strongest: require approval before fork pull request workflows run**, so nothing the agent wrote runs before a person looks. In a private repository, turn on "Require approval for fork pull request workflows"; it covers collaborators without write permission, so give the fork's account no more than read access to the target.
- **No self-hosted runner takes fork pull request jobs.** A self-hosted runner runs the pull request's code on your machine.
- **In the fork itself**, leave Actions disabled (GitHub disables workflows in a new fork until its owner enables them) and keep no secrets there: every `ship/` branch is pushed to it.

Keep the fork's copy of the base branch untouched. The adapter only ever fast-forwards it to the target's, and refuses to commit while it has commits of its own; reset it to the target's base branch to clear that.

The path policy refuses changes to CI configuration (`.github/**` and similar), so the agent cannot change these rules itself. Check them again whenever you add a workflow.

### Wiring the build

```ts
import { createAdapter as createGithub } from "@gtm-agents/adapters/code-github";
import { createAdapter as createSandbox, createShipSandbox } from "@gtm-agents/adapters/sandbox-cloudflare";
import { createShipBuild, evaluatePathPolicy, pathPolicyConfig } from "@gtm-agents/modules/ship";

const sandboxClasses = createShipSandbox<ShipEnv>({ config });
export const ShipSandbox = sandboxClasses.Sandbox;
export const ShipSandboxEgress = sandboxClasses.Egress;

const build = createShipBuild<ShipEnv>({
  config,
  repo: "acme-example/quarantine",
  baseBranch: "main",
  policy: pathPolicyConfig({ repo: "acme-example/quarantine", allowedRepos: ["acme-example/quarantine"], deniedPaths: ["migrations/**"] }),
  evaluatePolicy: evaluatePathPolicy,
  announceShipped: (env, taskId, now) => planning.announceShipped(env, taskId, now),
  codeHost: (env) => createGithub(context(env, "code-github")),
  sandbox: (env) => createSandbox(context(env, "sandbox-cloudflare"), env.SHIP_SANDBOX),
  operator: (env) => operatorChannel(env),
  workflow: (env) => env.SHIP_BUILD,
  options: { install: ["npm", "ci", "--ignore-scripts"], checks: ["npm", "run", "check"], productionEnvironments: ["production"] },
});
export const ShipBuildWorkflow = build.Workflow;
```

`createShipBuild` returns `startBuild` and `readEngineeringContract` for `createShipPlanning`, `commands` (the risk approval) and `routes` (the webhook) for `createWorker`, and the `Workflow` class to export. `readEngineeringContract` reads the first of `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md` on the base branch (`contractPaths`), capped at 64 KB; it is repository text, so the planning side fences it as data. Importing the build side needs the Workers runtime, because the Workflow class extends `WorkflowEntrypoint`.

### Build flags, secrets and failure behavior

| Flag | Default | Effect |
|---|---|---|
| `ship:builds_enabled` | off | Builds. Needs `ship:enabled`. Off, or unreadable: no build starts, a running build stops before its next agent round or its pull request, and the sandbox refuses every model call |
| `budget:job:ship_build:daily_cents` | unset | Lowers the daily cap on the sandbox's model spend |
| `budget:run_ceiling_cents` | 1000 | The model spend at which one task's calls stop |

- **Gates fail closed.** `StartShipBuild` starts nothing while the module, `ship:enabled` or `ship:builds_enabled` is off or unreadable, the system is halted, or the Workflow binding or an adapter is missing, and it says why. The same gate is read before each agent round and before the pull request. The model gate in the Worker refuses when the flags, the halt, the budget or the turn counter cannot be read.
- **Bookkeeping fails open.** Cost rows, audit rows, the stored log and operator notices that fail are dropped, and the task's status in the database stays the truth.
- **The sandbox is untrusted.** Its files are validated and re-counted, its status carries no text from the container, and its log is never read by a model.
- **Webhooks are verified first** and only act on a task the code host's own identifiers resolve to.

### Limits

- **Webhook deliveries over 100 KB are refused** with 413 by the Worker's body limit, before the signature is read. Pull request, check and deployment status payloads are normally far smaller, and the pull request text the gatekeeper writes is bounded, but a delivery that is refused is not retried: GitHub lists it as failed under the webhook's recent deliveries, and its task stays where it was.
- **The agent CLI and your model are yours to pair.** Each profile is pinned and tested against recorded traffic, not against a live model. Run a first build on a scratch repository.
- **Docker is needed to deploy** the module, even for `wrangler deploy --dry-run`, because Wrangler builds the image.
- **A call whose Worker is stopped before its usage arrives** is not recorded. The in-flight limit keeps that to two calls a task.
- **`parked`, `refused` and `failed` tasks all leave their theme `failed`.** The task's status and log say which it was.
- **The sandbox's own checks are advisory.** The agent runs as the same user as the checks, in the same container, so a process it left behind could change the work tree or a check's result after the checks ran. What is judged is the exact set of files the gatekeeper commits (the path policy runs on them), and what you rely on is your review and your repository's CI on the pull request, not the sandbox's check result.
- **At most 20 merged tasks are checked per production deploy**, the newest first, so the most comparisons one delivery asks the code host for is 20. With more merged tasks waiting than that, the older ones are marked by a later deploy that carries them.
- **A deploy comparison that fails waits for a redelivery or the next deploy.** The delivery answers 500 and is released, but GitHub does not redeliver a failed delivery on its own: redeliver it yourself, or let the next production deploy mark the task.
- **A fork's base branch is only fast-forwarded.** A fork whose copy of the base branch has commits of its own, or conflicts with the target's, refuses every commit until you reset it.
- **Fork mode is tested against recorded GitHub responses**, not a live pair of accounts. Who may open a pull request from a fork under another owner, with fine-grained tokens, is up to GitHub (step 6 of [Enabling the build](#enabling-the-build)), so open one on a scratch pair first.

### Another code host or sandbox

Both sides of the build are ports, so a different vendor is one more adapter, not a change to the module. A `CodeHost` adapter passes `runCodeHostContract` (one idempotent commit, never the base branch, a force or a merge; signatures before parsing; `contains` that throws rather than answer on a failed comparison; and, for a host that can commit through a fork, nothing written in the target). A `CodingSandbox` adapter passes `runCodingSandboxContract` (internet access off, no secret inside the container, limits enforced, steps that are polled). Both runners are in `packages/adapters/_contract/`.

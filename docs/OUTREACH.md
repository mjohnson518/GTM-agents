# Outreach: composing the daily cold batch

This page is for deployers turning on cold outreach, and for contributors changing how first touches are built or checked. It covers how templates and copy lines become drafts, the quality gate and every code it reports, the model reviewer, the daily cold batch step by step, who selection may and may not write to, campaign readiness, approval manifests and the release command, the holdout, auto-approve, and the flags and jobs involved. Delivery (the provider boundary, send windows, caps, the warm-up ramp, unsubscribe and the bounce monitor) is the send function's job and has its own guide. The code lives in `packages/core/src/outreach/` and `packages/core/src/quality/`, published as `@gtm-agents/core/outreach` and `@gtm-agents/core/quality`.

## What it does

```
contacts (cold, verified, keep) -> selection -> picker -> claim -> holdout split
                                                                    |
            templates + copy lines + contact fields -> compose -> quality gate -> model reviewer
                                                                    |
                                     drafts -> readiness -> manifest and release, or auto-approve -> send function
```

Once a weekday the batch picks the best-fitting cold contacts, one per account, writes each a first touch from your approved templates, checks every draft, and then either waits for you to release the batch with one command or, once auto-approve applies, hands the drafts that passed every check to the send function. No model writes a cold first touch: copy is your template with variables filled in from your own records. Nothing runs until you turn it on.

## Turning it on

1. **Templates.** Write `templates/*.md` ([BRAIN-SCHEMA.md](BRAIN-SCHEMA.md#templates)) and validate them with `npx gtm brain validate`. At runtime the batch serves templates from KV under the same rules as the brain: a lock at `templates:lock` (`{"version": 1, "hash": ..., "files": {"cold-intro.md": "<sha256 of the file>"}}`, built by `computeTemplateLock`) and each file at `template:file:<id>`. A template is served only when its bytes match the lock, it says `status: approved`, and it passes validation with your company's domain. Until `gtm brain upload` writes these keys, put them with `wrangler kv key put`, or pass the files bundled with the Worker as `templates` (below).
2. **The brain.** Upload an approved, locked brain. The batch reads the `icp` never list (a brain that cannot be read whole stops the batch), and the reviewer and the claims check read `voice`, `facts` and `message-pillars`.
3. **Register the job** in `apps/worker/src/index.ts`, with the send function and the day's volume from the send path:

   ```ts
   import { createWorker, type Env } from "@gtm-agents/core";
   import { createAdapterContext } from "@gtm-agents/core/adapters";
   import { createOutreachJobs } from "@gtm-agents/core/outreach";
   import { createOutreachSender, readColdVolume, senderDepsFromEnv } from "@gtm-agents/core/sending";
   import { createAdapter as resend } from "@gtm-agents/adapters/email-resend";
   import { createAdapter as anthropic } from "@gtm-agents/adapters/llm-gateway";
   import { createAdapter as telegram } from "@gtm-agents/adapters/operator-telegram";
   import config from "../gtm.config.ts";

   const context = (name: string, env: Env) => createAdapterContext({ name, env: { ...env }, config });
   const send = (env: Env) => createOutreachSender(senderDepsFromEnv(env, { config, provider: resend(context("email-resend", env)) }));
   const operator = (env: Env) => telegram(context("operator-telegram", env));

   const outreach = createOutreachJobs<Env>({
     send,
     volume: async (env, { flags }) => (await readColdVolume({ kv: env.KV, flags })).volume,
     model: (env) => anthropic(context("llm-gateway", env)),
     operator,
   });

   export default createWorker(config, { jobs: [...outreach], operator, sendOutreach: send });
   ```

   `sendOutreach` is what the release command sends through; without it, a release is refused.
4. **The operator chat.** The release command arrives through the operator agent, so it needs the operator channel's webhook, the `CHAT_QUEUE` binding with its consumer (`agent: { chatQueue }` in `createWorker`), and `operator:agent_enabled` set to `true` ([OPERATOR.md](OPERATOR.md)). Without them the batch still drafts and writes its manifest, but nothing can release it.
5. **Turn the batch on:** set `cold_batch:enabled` to `true` in KV. Leave auto-approve off: every batch then waits for your release.

## Templates and variables

The batch allocates among at most eight general (untargeted) and eight targeted approved `cold_intro` templates, highest `volume_weight` first. A template with `segments`, `personas` or `team_sizes` is offered only to a contact who matches every list it declares; a contact whose segment, persona or team size is unknown never gets a template that targets it. A `volume_weight` of 0 takes a template out of rotation.

**Allocation is weighted rotation.** Among the templates a contact may get, the one furthest below its weighted share of the batch so far is chosen, so a batch splits by `volume_weight` exactly and deterministically. Choosing by measured reply rates (Thompson sampling) belongs to the experiments milestone; until then `outreach:allocation_mode` is read and reported, and every value runs as weighted rotation.

Each variable comes from your own records:

| Variable | Source in the cold batch |
|---|---|
| `{{first_name}}` | The contact, when it reads as a name (letters, at least two characters) |
| `{{last_name}}`, `{{title}}` | The contact |
| `{{account_name}}` | The account, when it is a usable company name (not a fragment, a legal suffix, an address or a URL) |
| `{{segment_line}}`, `{{team_size_line}}`, `{{persona_line}}` | Your active `copy_lines` for the contact's segment (the account fit's segment, else the account's), team size and persona (`account_contacts.persona`). Empty: the whole line is removed |
| `{{persona_hint}}` | The `value_frame` of the persona's row in `persona_playbooks` |
| `{{booking_url}}`, `{{sender_name}}` | `sending.bookingUrl` and `agent.name` in `gtm.config.ts` |
| `{{attributes.<key>}}` | The contact's `attributes`, over the account's, when the value is a single line of at most 120 characters with no link, address or markup. Providers write attributes, so every draft from a template that uses them is held for a person (`PER_DRAFT_REVIEW`) |
| `{{angle_opener}}`, `{{angle_age}}`, `{{proven_insight}}`, `{{original_subject}}`, `{{company_context}}` | No source in the cold batch yet: a template that uses them is held for every contact |

**Skip rather than guess.** If any variable a template uses has no value, nothing is filled in: no draft is stored for that contact, the decision is recorded as `MISSING_VARIABLE`, and the contact is skipped for the day. A contact no template may be offered to is recorded as `NO_TEMPLATE`. Nothing ever falls back to "Hi there" or "your company".

**Copy lines** are rows in `copy_lines` (`kind` is `segment`, `team_size` or `persona`; `key` is the segment, team size or persona id, matched without regard to case; `text` is one line, at most 300 characters). They are your words, and they count as approved text for the claims check.

## The quality gate

Every draft passes the deterministic gate on NFKC-normalized text. A **block** means the copy is never stored as a draft or sent. A **hold** means a person decides: the draft is stored as `pending_approval`, outside any batch release.

| Code | Severity | Rule |
|---|---|---|
| `LINT_EMPTY_SUBJECT`, `LINT_EMPTY_BODY` | block | Nothing to send |
| `LINT_HIDDEN_CHARACTER` | block | Zero-width, direction or control characters |
| `LINT_HOUSE_RULE_CHARACTER` | block | An em or en dash |
| `LINT_PLACEHOLDER_LEAK` | block | `{{ }}`, `{ }`, `[INSERT ...]`, `[Your ...]`, template tags, `%s`, TODO, TBD, lorem ipsum |
| `LINT_URL_SHORTENER`, `LINT_HTML` | block | A link shortener; HTML markup |
| `RECIPIENT_MISMATCH` | block | The recipient is not exactly one address equal to the contact's |
| `UNUSABLE_ACCOUNT_NAME` | block | The copy names an account name the identity rules reject |
| `SUBJECT_LINE_BREAK` | block | The subject holds a line break |
| `LINT_SPAM_PHRASE`, `LINT_SUBJECT_CAPS`, `LINT_SUBJECT_PUNCTUATION` | hold | Spam phrases; a shouting or over-punctuated subject |
| `GREETING_NOT_PERSONAL` | hold | The first line lacks the contact's first name, or the first name is unknown (not checked for replies) |
| `ACCOUNT_FALLBACK_USED` | hold | "your company", "your firm" and similar while the company's name is known and absent |
| `LINK_NOT_ALLOWED` | hold | A link (including a bare host such as `example.com/offer`) anywhere but your company's domain and its subdomains, the host of `company.url`, the app host (`PRODUCT_APP_URL`), or the exact booking URL |
| `UNAPPROVED_CLAIM` | hold | A figure ("3x", "40%", "$2,000", "twelve") or a claim word (an offer, a price, a plan, a guarantee, customers or case studies) found in no approved source |
| `TOO_SHORT`, `TOO_LONG` | hold | Words outside the kind's bounds: `cold_intro` 30 to 180, `follow_up`, `breakup` and `check_in` 12 to 120, `proposal` and `lifecycle` 12 to 160, replies 8 to 160 |
| `SUBJECT_TOO_LONG` | hold | Over 90 characters |
| `NO_QUESTION` | hold | A cold intro that asks nothing |
| `EXCLAMATIONS` | hold | More than one exclamation mark |
| `MISSING_VARIABLE`, `NO_TEMPLATE` | hold | The copy could not be built (above) |
| `PER_DRAFT_REVIEW` | hold | The template uses per-contact text from outside (site text or attributes), so a person reviews each draft |
| `REVIEW_UNAVAILABLE` | hold | The model reviewer is off, or could not give a valid verdict |
| `REVIEW_FAILED` | hold | The model reviewer did not pass the draft's template |

**Approved sources for claims** are the template's own subject and body, your copy lines and persona playbooks, the contact's name and title and the account's name, the company and agent names from the config, and the brain's `facts` and `message-pillars` items. Attribute values are never a source, because providers write them. To let copy state a figure, put it in a fact. A claim word counts only where the same pattern finds the same word in a source, so a template's "feel free" never approves "it's free".

The verdict is the worst severity found. The score (100, minus 40 per block and 15 per hold) is for trend reports only. Every decision writes a `quality_checks` row with each finding's code, severity and detail, and the reviewer's verdict when it ran. A draft's row is keyed by its id; a contact whose copy could not be built is keyed by the item's idempotency key (`cold:<date>:<contact id>`). Operator messages carry a one-line summary: `38 pass, 2 held, 0 blocked; most common: GREETING_NOT_PERSONAL (2)`.

## The model reviewer

Behind `quality:model_review_enabled`, off by default.

- **The call.** The `judge` role through the model gateway, with the model and its price from `models.roles` and `models.pricing`. The system prompt is a fixed rubric, your company name and product description from the config, and the brain's `judge` slice (voice, facts, message pillars). The emails go in the user turn, each in its own quarantine fence marked as data, because copy carries contact and account fields from providers. The answer is schema-bound: per email, scores from 1 to 5 for relevance, clarity, tone and claims, the model's own pass, and up to three reasons. A pass needs the model's pass and every score at 3 or more.
- **Fail closed.** No gateway, no judge model or price, a budget that refuses or cannot be read, an error, a time-out (45 seconds), an answer that does not parse, a missing verdict or an out-of-range score: the review is unavailable and the drafts are held with `REVIEW_UNAVAILABLE`. A reviewer outage stops automatic sends; it never waves them through.
- **Cost control.** One call per batch, reviewing the first draft of each template plus one more (the middle draft of the largest template's group). Every template keeps the worst review any of its samples got, so a failing template holds every draft built on it. The call is checked against the budget first (the job's `maxSpendCents`, `budget:job:cold_batch:daily_cents`, the global limits) and its cost is recorded in `cost_events` with the job and run ids. A call that fails or times out may still have been billed, so it is recorded at an upper estimate (the prompt at about four characters a token, plus every output token allowed). A gateway that answers with a model that has no price fails the review.
- **When it runs.** When the flag is on, in both modes. When the flag is off and auto-approve applies, every draft is held with `REVIEW_UNAVAILABLE`, so turning on auto-approve means turning on the reviewer too. With the flag off in manual mode, you are the reviewer.

## The daily cold batch

The `cold_batch` job runs at 13:00 UTC, Monday to Thursday. One run:

1. **Gates.** `cold_batch:enabled` must be on and cold outreach must not be paused; either unreadable stops the run.
2. **Templates and the brain.** A brain that cannot be read whole stops the run. No servable template stops a new batch and tells you once that day.
3. **Resume.** With auto-approve on, approved first touches from the last 14 days that were never handed over and are due (a YELLOW deferral, an interrupted run) are re-checked and handed over first, under the same readiness policy. They count against the day's volume. Only batches whose run has finished, or was interrupted more than 15 minutes ago, are resumed, so a rerun never races a run still writing its batch. A draft whose template is no longer served is refused.
4. **The daily key.** Today's campaign id is fixed: `cb<YYYYMMDD>`. If today's campaign exists, the run only resumes it (in manual mode, it writes a missing manifest for its passing drafts) and never starts a second batch.
5. **Volume.** The day's warm-up volume from the send path, lowered by `cold_batch:daily_limit`, the batch maximum of 1,500, the job's row ceiling, and today's room under `delivery:domain_daily_cap`. A volume that cannot be read is 0.
6. **Selection**, oversampled 1.5 times and divided by one minus the holdout rate, then **the picker**, then the canonical suppression check over the picks (a check that fails stops the run).
7. **The campaign row** is inserted; that insert is the daily key, so of two concurrent runs only one continues.
8. **An atomic claim per contact** in the effects ledger (`cold_pick:<date>:<contact id>`), then **the holdout split**, walking the claimed contacts in rank order until the batch is full.
9. **Compose, gate and review** each draft.
10. **Store.** A draft is `approved`, with `approved_digest` and `approved_by` (`auto:flag` or `auto:autonomy_level`), only when auto-approve applies and the draft passed the whole gate; otherwise `pending_approval`. Blocked copy is never stored. Each draft carries the idempotency key `cold:<date>:<contact id>`; the contact's `campaign_contacts` row is `pending` (or `skipped` when no draft could be built).
11. **Readiness** over the drafts that passed, salvaged once (below).
12. **Policy.** RED holds everything and pages you once that day. In manual mode, the batch writes the approval manifest and sends you samples and the release command. With auto-approve, a GREEN batch is handed over whole, and a YELLOW batch by half (at least five) with the rest deferred 24 hours.

## Selection and the account rules

Selection, in SQL, keeps contacts that are:

- cold, with no `last_contacted_at` and no row in the send ledger;
- `keep` in `contact_fit`, at an account with no model fit score below 5;
- not suppressed, opted out (warmth or lifecycle) or erased;
- not cached `undeliverable`, and at or above the verification floor (`outreach:min_email_confidence`: `high`; `medium`, the default, which takes high and medium; or `low`; any other value is `high`). The verification status must be `deliverable` at every floor, because the send function refuses cold mail to anything else;
- without a queued deferral or an open draft from the last 14 days;
- not in the holdout, not known to have moved jobs, and without an open evidence conflict.

They are ranked by account fit (the model score, then the prescore), then oldest first. The picker then applies the rules that need the whole account, in order:

1. **The account key exists:** the contact's account key is a registrable company domain, and their address is at it.
2. **The never list:** the brain's `icp` never items (domains, company names, titles).
3. **Live thread:** nobody at an account where anyone is warming or warmer, a deal is past contacted, anyone replied or inquired in the last 90 days, or anyone declined in the last 90 days.
4. **Opt-out:** nobody at an account where anyone opted out or complained.
5. **Weekly cap:** cold and sequence messages per account in any 7 days (`delivery:account_weekly_cap`, default 3, the same cap the send function enforces). Selection stops one short of the cap, so readiness never finds an account at it.
6. **One per account per batch,** counting today's sends, queued deferrals and open drafts.

A short batch reports which rule cost the seats.

## Readiness

A scorecard over the drafts about to go; the worst dimension decides. Any data that cannot be read blocks its dimension.

| Dimension | Block (RED) | Warn (YELLOW) |
|---|---|---|
| Send cap | The sending domain is at its daily cap | The batch is larger than today's room |
| Bounce rate (1 and 7 days) | 5% or more | 2% or more; under 20 sends is too few to judge |
| Suppression overlap | Any recipient suppressed, or the check failed | |
| Verification coverage | Any cached undeliverable address | Half or more without a cached result |
| Content lint (sample of five) | Any lint block | Any lint warning |
| Account cap | An account would go over the weekly cap | An account would reach it |

**Salvage.** When RED comes only from suppression overlap or the account cap, the offending drafts are dropped and the rest scored once more. A RED from anything else, or from a suppression check that failed, holds the batch. Each batch's readiness is recorded as a `quality_checks` row with subject type `batch`.

## Manifests and release

In manual mode the batch writes an approval manifest to `approval_manifests`: each passing draft's id and the digest of its content (`draftDigest`: recipient, subject and body). Its code is six hex characters over the sorted pairs (`manifestCode`). You get one message with the first, middle and last drafts and the command:

```
batch-release-cb20261109-1a2b3c
```

Send it back in the operator chat (a leading `/` is accepted). It never reaches the model. In order:

1. The cold batch must be on.
2. The manifest must exist; without one nothing is released.
3. The code must match. It confirms you mean this set; it is not a secret, which is why:
4. Every draft is checked again: still open and at most 14 days old, its recipient still the contact's address, the contact still cold and not opted out, held out or suppressed, no mail from that address since drafting (anything but a bounce, an auto-reply, out of office or spam, so mail still waiting for triage counts), nothing sent to the contact since, nobody at the account in a conversation, opted out or complained since, and nothing on the brain's never list (a brain that cannot be read whole refuses the release). Its current content must hash to the digest in the manifest, so a draft edited after the manifest was written is refused, whoever edited it.
5. Readiness is scored again over the drafts that pass. RED refuses the release; salvage may drop suppressed recipients or accounts over the weekly cap.
6. The drafts that pass are marked approved with that digest and handed to the send function with `approvedDigest` set. The send function verifies the digest again.

The reply names what was sent, deferred, blocked or refused, and why. Sending the same command twice hands nothing over twice: each draft's idempotency key is claimed in the effects ledger before it goes, and the claim is released only when the send function reports a retryable failure (so the command can be sent again to retry). If the send function fails ambiguously, the claim stays and the draft is not sent again.

Follow-up steps are governed by the same autonomy class: at its default level each sweep's due steps wait for their own release command, `sequence-release-<id>-<code>`, which is separate from this one and cannot release a cold batch ([SEQUENCES.md](SEQUENCES.md)).

Held drafts are not part of a manifest. They stay `pending_approval` (counted by `/status`) as a record of what the gate stopped and why, and expire after 14 days. No path sends a held cold draft today: approving one through the operator channel marks it approved, but only a manifest release hands cold drafts to the send function. Fix the cause (a template variable, a claim, the brain) and the contact is drafted again by a later batch once the draft expires.

## Holdout

A share of each batch is held out as a no-send control, so lift can be measured against people who got nothing. Each picked contact is held independently with probability `outreach:holdout_rate` (default 0.05, at most 0.2), using a generator seeded per batch; the seed is recorded in the campaign's notes, so the draw can be reproduced. Held and treated contacts come from the same ranked range: the batch walks its claimed contacts in rank order and stops once it is full. Held contacts are claimed like sent ones, recorded in `outreach_holdout` with the day as their cohort, get no draft, and are kept out of cold selection for 90 days. The holdout is recorded only once the batch goes ahead. `heldOutContacts` lets any send path refuse a held contact as well.

## Auto-approve

Passing drafts are approved without you only when one of these holds, and the model reviewer passed them:

- `cold_batch:auto_approve` is on (your switch); or
- the `cold_batch` action class is at level 2 or above: the stored `autonomy:cold_batch` value, or `autonomy.defaults.cold_batch` in `gtm.config.ts` when none is stored, through `effectiveLevel`. Any read or parse error is level 1.

Levels are raised only by a person. Each automatic hand-over (including a resumed one) writes an `auto_sent` row in `autonomy_events`, and the first release of each manifest writes `approved_unchanged`, as evidence for promotion.

## What the send function does

The batch hands over drafts; the send function owns delivery. It runs every boundary check itself (the halt, the kill switch, suppression, the content lint, the verification policy, send windows, the per-domain and per-account caps, the circuit breaker), verifies each approval digest, records each send in the ledger, and defers what cannot go now. After the outcomes come back the batch's own bookkeeping is idempotent: the draft is marked sent, its campaign row records step 1 and when the next step is due, and the contact's warmth moves from cold to contacted.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `cold_batch:enabled` | `false` | The daily cold batch and the release command |
| `operator:agent_enabled` | `false` | The operator agent, which carries the release command ([OPERATOR.md](OPERATOR.md)) |
| `cold_batch:auto_approve` | `false` | Approve passing, reviewed drafts without a release |
| `cold_batch:daily_limit` | unset | Your limit, which can only lower the day's volume |
| `autonomy:cold_batch` | `1` | The class's level; 2 or above approves passing, reviewed drafts |
| `quality:model_review_enabled` | `false` | The model reviewer |
| `outreach:min_email_confidence` | `medium` | The verification floor for selection |
| `outreach:holdout_rate` | `0.05` | The share held out as a no-send control (at most 0.2) |
| `outreach:allocation_mode` | `weighted` | Reported only; every value runs as weighted rotation for now |
| `delivery:domain_daily_cap` | `500` | Shared with the send function: today's room for the batch |
| `delivery:account_weekly_cap` | `3` | Shared with the send function: the picker's weekly cap |

Reads fail in the direction that sends less: an unreadable switch is off, an unreadable level is 1, an unreadable cap is 0, and an unreadable or unknown verification floor is `high`.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `cold_batch` | `0 13 * * MON-THU` | `cold_batch:enabled` | 5 minutes, 1,500 drafts, 50 cents a day for the reviewer |

Change them with `createOutreachJobs({ ..., options: { batchSchedule, reviewMaxSpendCents, reviewTimeoutMs, maxDurationMs } })`. A schedule that fires more often than every 15 minutes is refused, because the batch calls a model. The job is critical (cron health watches it) and safe to rerun: the daily key makes a rerun resume instead of starting again. Pass `templates: (env) => files` to serve templates bundled with the Worker instead of from KV.

## Limits

- **Weighted rotation only.** Allocation does not yet learn from replies.
- **No signal angles yet.** Templates that use angle variables, insights, site text or an original subject are held until those sources exist.
- **One template per contact.** A contact held for a missing variable is not offered another template that day.
- **Held drafts are not sent.** A held cold draft is informational: there is no command yet that lists held drafts or releases one individually.

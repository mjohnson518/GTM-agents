# Sourcing and enrichment

This page is for deployers turning on sourcing, and for contributors adding a discovery source, an email finder or a verifier. It explains how the system finds accounts and people, finds and verifies their work email addresses, decides who fits, and turns the right people into contacts; which flags control it and what they default to; what it costs and how the budget bounds it; and which adapters ship with it and the secrets they need. The code lives in `packages/core/src/sourcing/`, `packages/core/src/enrichment/` and `packages/core/src/scoring/`, published as `@gtm-agents/core/sourcing`, `/enrichment` and `/scoring`.

## What it does

```
brain queries -> search -> candidates (raw) -> enrich -> qualify -> promote -> contacts
                              |                  |          |          |
                       dedup, identity    people, person   score    identity, suppression,
                                          fit, email,               conflicts, verification
                                          verification
```

Every weekday the discovery cycle searches with the queries in your brain, stores what it finds as candidates, finds the right person at each account and their work address, verifies the address, scores the candidate, and promotes the ones that pass every check to contacts with warmth `cold`. A nightly job prescores accounts for free, and an optional job asks a model to score account fit against your ICP. Everything is off until you turn it on, and every paid call is checked against the budget first.

What to look for never comes from code. Queries come from the brain's `keyword-portfolio` component and from rows you add to `discovery_queries`; who fits comes from `personas`; hard stops come from the `never` items of `icp` ([BRAIN-SCHEMA.md](BRAIN-SCHEMA.md)). Selling a different product means editing the brain, not this code.

## Turning it on

1. Enable `data-exa` and `data-hunter` in `gtm.config.ts` (`adapters`), and set their secrets:

   ```bash
   npx wrangler secret put EXA_API_KEY
   npx wrangler secret put HUNTER_API_KEY
   ```

2. The template's `src/index.ts` already registers the jobs. In a Worker of your own, the wiring is below. Adapters are built inside each run, so secrets are read when a job runs, not at import time:

   ```ts
   import { createWorker, type Env } from "@gtm-agents/core";
   import { createAdapterContext } from "@gtm-agents/core/adapters";
   import { createSourcingJobs } from "@gtm-agents/core/sourcing";
   import { createAdapter as createExa } from "@gtm-agents/adapters/data-exa";
   import { createAdapter as createHunter } from "@gtm-agents/adapters/data-hunter";
   import config from "../gtm.config.ts";

   const sourcing = createSourcingJobs<Env>({
     adapters(env) {
       const context = (name: string) => createAdapterContext({ name, env: env as unknown as Record<string, unknown>, config });
       const hunter = createHunter(context("data-hunter"));
       return { sources: [createExa(context("data-exa"))], people: hunter, finders: [hunter], verifier: hunter };
     },
   });

   export default createWorker(config, { jobs: [...sourcing] });
   ```

   Add `model` (a ModelGateway adapter) to the returned object if you want the model fit score.

3. Upload an approved, locked brain with at least `personas`, `icp` and `keyword-portfolio` (`gtm brain validate --write-lock`, then upload it). With no approved personas, nothing can pass person fit, so the cycle searches but skips enrichment rather than pay for lookups it would reject.

4. Turn the cycle on: `npx gtm flags set discovery:enabled true` (add `--env staging` for staging). Leave the other flags at their defaults to start.

## The discovery cycle

The `discovery_cycle` job runs weekdays at 09:00 UTC. Its four stages run in order, each bounded by its own per-run ceiling. All of them share one spend gate, so the job's daily cap stops paid calls wherever they are; a stage stopped by the budget leaves its rows for the next run, and the free stages after it still run.

### 1. Search

- Each of the brain's `keyword-portfolio` items is registered once per discovery source in `discovery_queries` as an account search. Rows you add to `discovery_queries` yourself also run; give them `search_type = 'person'` for person searches.
- Each run searches the least recently run active queries, up to `discovery:searches_per_cycle`, asking for `discovery:results_per_search` results each. A query you deactivate (`is_active = 0`) is never revived.
- While more than `discovery:raw_backlog_max` raw candidates are waiting, no new search is paid for. The backlog still drains.
- Domains on the brain's never list, and accounts the model scored below 5, are sent to the provider as exclusions.
- Results are stored in `candidates` with status `raw`, deduplicated by `(source, source_ref)`, with the query that found them. A result with no company domain (a personal mailbox domain, a shared host such as a social network, a code host or a site builder, or nothing parseable) or on the never list is stored as `rejected`, so the same result is never paid for or reconsidered again.
- A run writes at most the job's `ceilings.maxRows` new candidate rows.

### 2. Enrich

Up to `discovery:enrich_per_cycle` raw candidates per run, oldest first.

1. **Identity and the fit gate, before any paid call.** The candidate needs a company account key, must not be on the never list, and its account must not have a model fit score below 5.
2. **The person.** An account candidate (a company with no person yet) asks the people provider for people at the account's domain. They are ranked by the title classifier: persona matches first, then decision makers, then seniority. The best one fills the candidate; further matches, up to `peoplePerAccount` in total (1 to 5, default 2), become new raw candidates for the next run. Without a people provider, account candidates are rejected.
3. **Person fit.** A title the classifier drops is rejected. A title it cannot place (maybe) is enriched without any paid email lookup, so it ends borderline. A maybe is a no until proven.
4. **The email waterfall.** An address the people provider already returned is tried first; then the first finder; then each further finder, only while `discovery:email_waterfall_enabled` is on. Each step's address is kept only when it screens clean: exactly one address, at the candidate's own account domain, not a personal mailbox, a shared host or a role mailbox (`info@`, `sales@` and the like). Steps are recorded in `email_steps_tried` and never repeated. A provider that errors is skipped for the rest of the run.
5. **Suppression, then duplicates, then verification.** A found address that is suppressed, tombstoned or opted out is rejected and not kept. One that already belongs to a contact marks the candidate `duplicate`. Otherwise the address is verified (a fresh cached result is reused).
6. **Evidence.** The employer domain, the title and the email are each recorded in `contact_evidence` with their provider, source URL and confidence.

### 3. Qualify

Up to `discovery:qualify_per_cycle` enriched candidates per run. The score is free and deterministic:

| Signal | Points |
|---|---|
| Work address verified deliverable (risky) | 0.30 (0.15) |
| First and last name | 0.15 |
| Company name | 0.10 |
| Person fit keep (maybe) | 0.20 (0.05) |
| Account fit: model score / 10 * 0.25, or else prescore / 100 * 0.10 | up to 0.25 |

0.5 or more is `qualified`, under 0.3 `rejected`, anything between `borderline`. Borderline and rejected are terminal. The never list, a person-fit drop and an account fit below 5 reject whatever the score.

### 4. Promote

Up to `discovery:promote_per_cycle` qualified candidates with an address, best score first. The first check that fails decides:

1. The address parses as exactly one address, or the candidate is rejected and the address dropped.
2. It is a work address at the candidate's account (personal mailboxes and shared hosts never are), and not a role mailbox.
3. It is not already a contact, by address or by mailbox (the address without a `+tag`), and the same full name at the same account is not already a contact. Either makes the candidate a `duplicate`.
4. It is not suppressed, tombstoned or opted out. A suppression check that cannot be read holds the candidate and stops the stage.
5. It has no unresolved evidence conflict.
6. The person fit, recomputed from the current brain, is keep, and nothing is on the never list.
7. A fresh verification passes the promotion policy. An unknown result is retried on later runs, then rejected after three.

A candidate that passes becomes a contact in one D1 batch, all or nothing: the account is upserted, the contact is inserted with its normalized address and both hashes, warmth `cold`, the verification status and confidence, the source and the query; the candidate moves to `promoted`; its evidence is linked to the contact; and the persona seat and the fit verdict are recorded. Both the insert and the status change are guarded on the candidate still being qualified, so two runs can never promote it twice. A missing first name is allowed: drafting holds such a contact later rather than greet a guessed name.

## Signals and other sources

Beyond the discovery cycle, signal sources find dated reasons to write and new people: Exa websets and search monitors, dated funding and leadership news, public hiring boards, responder lookalikes and coverage fill at high-fit accounts. Each has its own `signals:*` flag, every candidate it finds still passes promotion (including the account-fit check), and a signal found before an account had contacts is carried to up to two newly promoted contacts. [SIGNALS.md](SIGNALS.md) covers each source.

## Identity rules

- **Work email only.** Personal mailbox domains and shared hosts are never collected, enriched or emailed. `accountKey` returns null for them, and null always means skip ([DATA-MODEL.md](DATA-MODEL.md)).
- **The account key** is the lowercased registrable domain. A person's company name is resolved to an account only from free sources (known accounts and cached resolutions) and only when exactly one matches.
- **Names** are split into first and last only when the value reads as a person's name ("Last, First", honorifics and suffixes are handled). Anything else is skipped, never guessed.
- **Suppression, tombstones and opt-outs** are checked with `checkSuppression` before an address is kept and again before promotion, so an erased person is never re-added, even when a new search rediscovers them.

## Verification

The verifier adapter maps its vendor's vocabulary onto four statuses: `deliverable`, `risky`, `undeliverable`, `unknown`. Everything else is core's:

- Results are cached in `email_verifications` by address hash (the address itself is not stored there): 90 days, or 7 days for `unknown`.
- Confidence on the contact: deliverable with a score of 90 or more is `high`, other deliverable results `medium` (`low` under 70), risky `low`.
- **The promotion policy** (`verification:promotion_policy`): `strict`, the default, promotes only deliverable addresses. `allow_risky` also promotes risky (accept-all) ones. Any other value, or a flag that cannot be read, is `strict`. Unknown, undeliverable and disposable addresses never promote.

## Evidence and conflict holds

Each field (email, title, employer domain) is recorded with its provider, source URL, confidence, verification time and a retention date a year out. A **conflict** is a different provider giving a different value for the same person: another address, another employer domain, or a title in another seniority band. The same provider repeating itself is an update. A conflict is never resolved by guessing: both rows are marked `conflict = 1`, each naming the other, and the person is held. A held candidate is not promoted; an existing contact keeps the values on file. Resolve a conflict by setting `resolved_at` (and `resolved_by`) on the rows.

## Person fit: the title classifier

One function, `classifyTitle`, decides person fit, the routing persona, the seat and the seniority rank, so they never disagree:

- **drop**: the title is on the icp never list, or it matches no persona title and its seniority is not one any persona lists;
- **keep**: the title contains one of a persona's `titles` phrases (case, punctuation, common spellings such as "Vice President" for "VP", and words like "of" and "the" are ignored), and none of that persona's `exclude_titles`;
- **maybe**: no phrase matches, but the seniority is one a persona lists, or there is no title. A cached review in `title_fit_reviews` can settle a maybe.

Only keep is ever promoted. To accept a title variant, add it to the persona's `titles` in the brain.

## Account prescore and fit score

**Prescore** (`account_prescore`, daily at 04:00 UTC, `fit:prescore_enabled`) is free: it writes a 0 to 100 score to `account_fit` from data already held. Team size from contact count (up to 20), a decision maker (25) or senior people (15), persona roles covered (5 each, up to 15), a signal in the last 90 days (20 at severity 0.5 or more, otherwise 10), a deliverable contact (10) and firmographic facts on file (10). An account on the never list scores 0.

**Fit score** (`account_fit_scoring`, every 15 minutes, `fit:scoring_enabled`) is optional. It scores the top `fit:score_top_n` accounts by prescore, `fit:score_per_run` per run, with the model role `classifier` (set `fitRole: "judge"` to use the judge role). The system prompt is fixed rubric text plus the brain's `fit` slice (the approved icp); provider text about the account (firmographic values, search snippets, contact titles) goes only in the user turn, inside the quarantine fence. The output is schema-bound: a 1 to 10 score, a segment, a team size, a confidence, up to three reasons and a disqualifier, which caps the score at 4. Accounts scored below 5 are not enriched further and join the search exclusion list. Scores refresh after 180 days; an account that fails three times is marked unreachable and keeps its prescore. A role with no model, or a model with no price in `models.pricing`, fails the run before any call.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `discovery_cycle` | `0 9 * * MON-FRI` | `discovery:enabled` | 10 minutes, 500 new rows, 300 cents a day |
| `account_prescore` | `0 4 * * *` | `fit:prescore_enabled` | 2 minutes, 5,000 accounts, no spend |
| `account_fit_scoring` | `*/15 * * * *` | `fit:scoring_enabled` | 5 minutes, 100 accounts, 100 cents a day |

Change the schedules and caps with `createSourcingJobs({ adapters, options: { discoverySchedule, prescoreSchedule, fitSchedule, discoveryMaxSpendCents, fitMaxSpendCents, peoplePerAccount, fitRole } })`. Schedules use named days, and a model schedule that fires more often than every 15 minutes is refused. The job runner checks the halt, the job's flag and its budget before each run and leaves a run row either way; each job also re-reads its own flag, so calling `run()` with the flag off does nothing.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `discovery:enabled` | `false` | The discovery cycle |
| `discovery:searches_per_cycle` | `5` (max 25) | Paid searches per run |
| `discovery:results_per_search` | `10` (max 100) | Results requested per search |
| `discovery:raw_backlog_max` | `300` (max 10,000) | No new searches while more raw candidates wait |
| `discovery:enrich_per_cycle` | `40` (max 50) | Candidates enriched per run |
| `discovery:qualify_per_cycle` | `20` (max 100) | Candidates qualified per run |
| `discovery:promote_per_cycle` | `50` (max 100) | Candidates considered for promotion per run |
| `discovery:email_waterfall_enabled` | `false` | Finders after the first |
| `verification:promotion_policy` | `strict` | `strict` or `allow_risky` |
| `fit:prescore_enabled` | `false` | The nightly prescore |
| `fit:scoring_enabled` | `false` | The model fit score |
| `fit:score_top_n` | `1000` (max 10,000) | Accounts in scope for the fit score |
| `fit:score_per_run` | `20` (max 100) | Accounts scored per run |

Reads fail closed: a boolean flag that cannot be read is off; a ceiling that cannot be read or does not parse as a whole number is 0, so that stage does nothing that run.

## Costs and budgets

Every paid call (a search, a people lookup, an email find, a verification, a model call) goes through one spend gate. Before the call it asks the budget gate whether new spend may start, with the job's daily cap: its `ceilings.maxSpendCents`, and `budget:job:<job>:daily_cents` if you set it (the lower applies, whatever `budget:enforcement` says), plus the run's own ceiling, `budget:run_ceiling_cents`. A refusal, or a budget that cannot be read, stops every later paid call in the run. After the call, the cost is written to `cost_events` in micro-cents with the job and run ids. Adapters report each call's cost in dollars; model calls are priced from `models.pricing` ([SECURITY-MODEL.md](SECURITY-MODEL.md#budgets-and-the-cost-ledger)).

A rough day at the defaults, with the two shipped adapters: 5 searches, then for up to 40 candidates a people lookup, an email find and a verification. At the list prices below that is a little under $3, which is why the discovery cap defaults to 300 cents. Set the cap and `usdPerCredit` to match your plans.

## Adapters and secrets

| Adapter | Ports | Secret | Options (`adapters.<name>.options` in `gtm.config.ts`) |
|---|---|---|---|
| `data-exa` | DiscoverySource (`search` here; websets, news, find-similar and monitors for [SIGNALS.md](SIGNALS.md)) | `EXA_API_KEY` | `baseUrl`, `searchType` (`auto`), `accountCategory` (`company`), `personCategory` (`people`), `highlightChars` (400); for websets, `websetEmail` (`true`) and `creditUsd` (0.006) |
| `data-hunter` | ContactFinder, EmailVerifier, PeopleProvider | `HUNTER_API_KEY` | `baseUrl`, `usdPerCredit` (0.025) |

- **data-exa** searches accounts with the `company` category and people with the `people` category. It reports the cost the API returns, or estimates it from its price table ($0.005 a request of up to 25 results, $0.025 for 26 to 100, $0.001 per result for highlights).
- **data-hunter** finds addresses (`/email-finder`), verifies them (`/email-verifier`) and lists named people at a domain (`/domain-search`, personal addresses only). Its statuses map as: `valid` to deliverable; `invalid` and `disposable` to undeliverable; `accept_all` and `webmail` to risky; `unknown`, and anything unrecognized, to unknown. A verification still in progress is a retryable error; a person who asked the vendor not to process their data comes back as unknown from the verifier and as no address from the finder. Costs are in credits (1 per address found, 0.5 per verification, 1 per ten addresses listed) times `usdPerCredit`.

Neither adapter is offered to an agent as a tool; they are used only by these jobs and the signal jobs. `data-hunter` declares no tools, and `data-exa`'s manifest classifies its calls as full-taint egress tools so the security contract covers them ([INTERFACES.md](INTERFACES.md#how-adapters-become-tools)).

## Writing another adapter

A discovery source, finder or verifier implements its port ([INTERFACES.md](INTERFACES.md)), ships a `manifest.json` with its cost table, and runs the shared contract in its `contract.test.ts`:

```ts
import { runDiscoverySourceContract } from "../_contract/discovery-source.ts";
import { runContactFinderContract } from "../_contract/contact-finder.ts";
import { runEmailVerifierContract } from "../_contract/email-verifier.ts";
```

The contracts drive the adapter with recorded responses only. They check the manifest, the shape of every result, that every result carries a cost, that the adapter uses only the injected fetch, that a missing secret fails before any request, that each HTTP failure becomes an `AdapterError` with the right code and `retryable` flag, and, for verifiers, that every vendor status maps to exactly one of the four. Keep request building and response mapping in small separate functions, so a vendor change is corrected in one place. An adapter translates; it never screens addresses, deduplicates or applies a policy.

## Limits

- **One people provider and one verifier.** Finders form a waterfall; the people provider and the verifier are single.
- **No email pattern inference.** The waterfall never builds an address from a name and a pattern; an address comes from a provider or not at all.
- **Borderline is terminal.** A candidate with a maybe title or no address ends borderline and is not revisited by this cycle.
- **Prices are list prices.** The adapters' price tables are estimates for budgeting. The cost ledger records what each call reports, so set `usdPerCredit` and the caps to your plan.

# Signals and scale

This page is for deployers turning on the signal sources, and for contributors adding one. It explains the extra sources that find accounts and people beyond the discovery cycle's searches (websets, search monitors, responder lookalikes, coverage fill), the sources that find dated reasons to write (funding and leadership news, public hiring boards), what a signal is and the rules every signal follows, how a signal found early is carried to the first contacts at an account, the nightly intent score, and how a signal becomes the angle of a first touch. The code lives in `packages/core/src/signals/` and `packages/core/src/scoring/intent.ts`, published as `@gtm-agents/core/signals` and `@gtm-agents/core/scoring`. The adapters are `@gtm-agents/adapters/data-exa` and `@gtm-agents/adapters/data-jobboards`.

## What it does

```
websets, monitors, lookalikes, coverage fill  ->  candidates  ->  enrich -> qualify -> promote  ->  contacts
                                                                                        |
news, hiring boards  ->  signals (contact or account)  ->  carry (72 h)  ------------->  +
                                         |
                                         +-> angle ({{angle_opener}}, {{angle_age}}) -> first touch
                                         +-> intent score (nightly, shadow until enforced)
                                         +-> cohort "signalled" on the send ledger
```

Every source is its own job behind its own flag, and every flag is off until you turn it on. Sources that find people never create contacts themselves: they write candidates, and the discovery cycle (`discovery:enabled`, [SOURCING.md](SOURCING.md)) enriches, qualifies and promotes them with every identity, suppression, fit and verification check. Sources that find reasons write signals, which never send anything on their own: they move the intent score and give a first touch its opener.

## Turning it on

1. Check that `src/index.ts` wires the adapters and the jobs. The worker template does; a deployment created from an older template adds them (see [Wiring](#wiring)).
2. Apply the migrations with `gtm migrate` (`0025_signals.sql` adds two columns to `monitor_items` and one to `discovery_queries`, plus indexes).
3. Turn on the sources you want, one at a time, and watch their run rows:

```bash
npx gtm flags set signals:news_enabled true --env staging
npx gtm flags set signals:hiring_boards_enabled true --env staging
npx gtm flags set scoring:intent_enabled true --env staging
```

4. Approve a template that uses `{{angle_opener}}` and `{{angle_age}}` (see [Angles](#angles-and-the-template-variables)).

## The sources

| Source | Job and schedule (UTC) | Flag | What it writes | Per-run ceiling | Cost |
|---|---|---|---|---|---|
| Websets | `signal_websets`, weekdays 10:00 | `signals:websets_enabled` | person candidates | 3 websets created, 200 items | 10 credits per matching item, 5 per email found; the worst case is reserved at creation |
| Search monitors | webhook, then `signal_monitor_drain` every 30 minutes | `signals:monitors_enabled` | account candidates | 500 hits per delivery and per drain | billed by the provider per monitor run |
| Funding and leadership news | `signal_news`, weekdays 07:00 | `signals:news_enabled` | signals | 4 searches of 25 results | $0.005 per search |
| Hiring boards | `signal_hiring_boards`, weekdays 06:00 | `signals:hiring_boards_enabled` | signals, role counts | 20 accounts | free (public boards) |
| Responder lookalikes | `signal_lookalikes`, Tuesday and Thursday 11:00 | `signals:lookalikes_enabled` | account candidates | 5 seeds, 30 inserts | $0.005 per find-similar |
| Coverage fill | `signal_coverage_fill`, weekdays 12:00 | `signals:coverage_fill_enabled` | person candidates | 5 accounts, 2 people each | the people provider's search price |
| Intent score | `intent_scoring`, daily 02:30 | `scoring:intent_enabled` | `contacts.attributes.intent` | 5,000 contacts | free |

Every paid call goes through the spend gate with the job's daily cap (`websetsMaxSpendCents` 200, `newsMaxSpendCents` 50, `lookalikesMaxSpendCents` 50, `coverageMaxSpendCents` 100 by default; a `budget:job:<job>:daily_cents` flag lowers any of them). A cap that is reached, or a budget that cannot be read, stops the run's paid calls. None of these jobs calls a model.

### Websets

You list webset specs in the job options: a natural-language description of the people you want and how many. Each run creates a webset for each spec that has none from the last 7 days, and polls every webset from the last 14 days for new items. The provider bills for every item a webset finds after it is created, so before each creation the worst case (`count` times `websetItemUsd`, $0.09 by default: an item and its email enrichment) is reserved through the spend gate, and `count` is lowered to what the job's daily cap allows; polling records nothing more. The poll point advances only when every item was stored, so items past the per-run cap are read again next run. An item at an account scored below the fit floor is rejected. An item with a clean work address at its own company (the company comes from the item, never from the address) is inserted `qualified` at the fixed score 0.6, so enrichment does not pay to find what the webset found. Any other item is inserted `raw` for enrichment to finish, or `rejected` when it has no company account or is on the never list. Promotion still runs every check, including person fit from the current brain and a fresh verification.

### Search monitors

You create a monitor at the provider (for Exa, a search that runs on a schedule and posts its results to a webhook), point it at `https://<your worker>/api/webhooks/search/<key>`, and list it in the job options with that key and the name of the Worker secret it signs with. The key is a lowercase slug, and the secret's name must start with `MONITOR_`, so no other setting or credential can sign deliveries:

```ts
monitors: [{ key: "ci-pain", provider: "data-exa", secretName: "MONITOR_CI_PAIN", description: "companies writing about flaky CI", results: "company_sites" }]
```

```bash
npx wrangler secret put MONITOR_CI_PAIN
```

The route resolves the key against your config only, refuses bodies over 1 MB, and verifies the signature (`Exa-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 of `<t>.<raw body>`, within five minutes) before it touches the database. With the flag off it answers 503 and records nothing. Hits are cleaned and stored in `monitor_items` in batches, deduplicated on the provider's result id and on the URL per monitor. The drain job turns up to 500 a run into raw account candidates, reading the account from the result's host, so only a monitor whose results are companies' own sites (`results: "company_sites"`, a search in the provider's company category) produces candidates. Hits from a monitor of articles (`results: "articles"`) are skipped, so a publisher never becomes an account.

### Funding and leadership news

A few fixed news searches (`DEFAULT_NEWS_QUERIES`, or your own `newsQueries`) over the last 30 days. A hit becomes a signal only when:

- it has a published date inside the window and an http(s) URL;
- its title names exactly one known account (one not scored below the fit floor) by its distinctive name, as a whole phrase;
- with that name removed, the rest of the title still reads as the category: a round raised, or a leader appointed. The account's own name never counts as evidence, so "Acme Funding launches a podcast" is not a funding signal for an account called Acme Funding.

Funding severity scales with the round where one is named (0.60 for an unnamed or seed round, 0.61 for Series A, up to 0.64 for Series D or later). Leadership news is category `news` with `evidence.category` `leadership`, severity 0.60. Both expire after 30 days.

### Hiring boards

For up to 20 high-fit accounts a run (model fit 7 or more, or unscored with a prescore of 70 or more) not checked in the last 7 days, the `data-jobboards` adapter reads the account's public Greenhouse, Lever and Ashby boards. A board token is guessed from the account's domain (`brightloop.example` gives `brightloop`) until a board is found, then the found board is read. The adapter requests only:

- `https://boards-api.greenhouse.io/v1/boards/<token>/jobs`
- `https://api.lever.co/v0/postings/<token>?mode=json`
- `https://api.ashbyhq.com/posting-api/job-board/<token>`

The token must match `^[a-z0-9][a-z0-9-]{0,62}$`, the host is checked before every call, and redirects are not followed. Postings are classified into role kinds inside the adapter (`engineering`, `data`, `product`, `design`, `sales`, `marketing`, `customer_success`, `operations`, `finance`, `people`, `legal`, `other`), and only the counts leave it: a posting title is never returned or stored. Hiring becomes a signal at most once per 90 days per account, when at least 3 postings fall in the role kinds you care about (`roleKinds`, every kind but `other` by default) and the board reports a posting date.

### Responder lookalikes

Seeds are accounts that responded in the last 180 days: a positive reply, a meeting booked, a sign-up or a subscription (the one definition of each, in `packages/core/src/metrics/`). Each run takes the 5 least recently used seeds and asks for companies similar to each seed's site. A result is skipped when it is the seed, on the never list, already known (an account or contacts), a candidate in the last 90 days, or scored below the fit floor. Up to 30 raw account candidates a run.

### Coverage fill

Accounts with a model fit of 7 or more, fewer than 2 keep-listed contacts, and a signal or a response in the last 30 days. Up to 5 accounts a run, best fit first, each claimed in `resource_claims` with a 30-day cooldown (given back when the lookup is stopped by the budget or a provider error), and up to 2 people each from the people provider, through the same people lookup enrichment uses (work addresses at the account's domain only, titles the brain's personas keep). Someone already a contact is skipped. Each person is a raw candidate.

### Source attribution

Each non-search source has its own `discovery_queries` row, inactive so the search stage never runs it: one per webset, per monitor, per lookalike seed, and one for coverage fill. Candidates carry its id, contacts inherit it, and promotion credits it, so conversion reports compare sources the same way they compare queries.

## Signals

A signal is a dated, sourced reason to write to an account. Every row in `signal_events` carries:

| Field | Column |
|---|---|
| source type | `source` (`exa_news`, `hiring_board`, ...) |
| category | `type` (`funding`, `hiring`, `launch`, `news`, `job_change`, `post`, `filing`, `product_usage`, `custom`) |
| severity, 0 to 1 | `severity` |
| source URL | `source_url` |
| event date | `event_date` |
| evidence, stored as data only | `evidence` (JSON) |
| expiry | `expires_at` |
| a contact or an account | `contact_id`, `account_key` |

The rules (`recordSignal`):

- No date or no URL means no signal. A date that does not parse or is in the future, a URL that is not http(s), an expiry that is not after now, or an account the deployment does not know: no signal.
- Sourced signals sit at 0.60 to 0.64, below the 0.70 auto-draft line, so they move scores and pick an opener but never draft on their own.
- A signal goes to at most 2 never-contacted, keep-listed contacts at the account (one row each); otherwise to the account (no contact); otherwise nowhere.
- One event is recorded once per account (same source and event key), so a source that re-reads its window every day never routes one event to more contacts over time.
- The headline and the evidence are third-party text: cleaned (one line, capped, injection patterns redacted) before storage and still untrusted after. Nothing builds a prompt from them.
- Recording the same event twice writes one row: a signal's id comes from its source, its event and its target.

## Carry

A signal found before an account had contacts is held at account level. For 72 hours after it was detected, each contact promoted at the account gets a copy (promotion calls `carrySignals`), up to 2 contacts per signal, when the contact is cold, has never been contacted, has a deliverable verification and has had no signal of its own in 90 days. Only the strongest qualifying signal is copied. Some signals are never carried: a job change (it is about another person), a multithread marker, and anything derived from product usage. Carry is bookkeeping: an error is logged and the promotion stands.

## The intent score

A nightly score out of 100 for each cold, never-contacted contact (the never-scored and least recently scored first, up to 5,000 a run), written to `contacts.attributes.intent` as `{score, band, components, at}`:

| Component | Points |
|---|---|
| Account fit | up to 30: the model fit score times 3, or, unscored, `min(18, prescore * 0.18)` |
| Title | up to 20, by seniority rank |
| Signal | `35 * severity * freshness`, freshness 1 within 14 days of the event, 0.6 within 45, 0.3 within 90 |
| Angle | 15 when the best signal gives a high-confidence angle (within 14 days), 10 for medium (within 45), 3 otherwise |

Bands: 80 and up `first_touch`; 65 to 79 `soft_touch`; 45 to 64 `nurture`; below 45 `none`. The score is shadow: it filters nothing until `intent_score:enforce` is on. `intentAllowsFirstTouch` is the check cold selection applies when it is: only `first_touch` passes, and a missing or unreadable score does not.

## Angles and the template variables

An angle is the dated reason a first touch gives. It is built only from a real, unexpired signal of the contact's own (`loadAngles`): one routed to it, or carried to it on promotion. A signal held at the account is never read for every contact there, so the 2-contact limit holds.

| Variable | Value |
|---|---|
| `{{angle_opener}}` | a fixed opener for the angle kind, with only `{account}` substituted by the account's name |
| `{{angle_age}}` | "this week", "last week" or "in March", from the event date |
| `{{angle_headline}}` | the signal's headline, only for source types you whitelist (`quoteSources`, empty by default), cleaned and capped at 120 characters, with no link or markup |

Angle kinds come from the category: `funding`, `hiring`, `launch`, `job_change`, and `new_leader` (leadership news). Other categories give no angle, and product usage never does. Confidence is high within 14 days of the event and medium within 45; older gives no angle. The defaults (`DEFAULT_ANGLE_OPENERS`) are plain; replace any of them with your own (`openers`), one line each, with no variable other than `{account}` and no link.

A template that uses the angle variables is composed for a contact with an angle and held (`MISSING_VARIABLE`) for one without; nothing is ever filled in by guessing. The opener and the age count as approved text for the quality gate's claim check, the headline does not, and a template that uses `{{angle_headline}}` is reviewed by a person for every draft. A send to a contact with a signal is in the `signalled` cohort ([MEASUREMENT.md](MEASUREMENT.md)).

## Privacy

- Product usage is never carried to a colleague and never becomes an angle: what one person does in the product is never told to someone else.
- Job boards keep role-kind counts, never titles, locations or descriptions.
- Evidence and headlines are stored as data. They never reach a system prompt, and they reach copy only through the whitelisted headline variable.

## Wiring

```ts
import { createSignalJobs, handleMonitorWebhook } from "@gtm-agents/core/signals";
import { createAdapter as createExa, parseMonitorDelivery, verifyMonitorSignature } from "@gtm-agents/adapters/data-exa";
import { createAdapter as createJobBoards } from "@gtm-agents/adapters/data-jobboards";
import { createAdapter as createHunter } from "@gtm-agents/adapters/data-hunter";

const signals = createSignalJobs<Env>({
  adapters(env) {
    const exa = createExa(context(env, "data-exa"));
    return { discovery: exa, similar: exa, news: exa, boards: createJobBoards(context(env, "data-jobboards")), people: createHunter(context(env, "data-hunter")) };
  },
  options: {
    websets: [{ query: "engineering leaders at software companies with 30 to 300 engineers", count: 25 }],
    monitors: [{ key: "ci-pain", provider: "data-exa", secretName: "MONITOR_CI_PAIN", description: "companies writing about flaky CI", results: "company_sites" }],
  },
});
// jobs: [...sourcing, ...signals, ...]
```

The monitor route, registered beside the other webhooks:

```ts
app.post("/api/webhooks/search/:key", (c) =>
  handleMonitorWebhook(c.req.raw, c.req.param("key"), {
    db: c.env.DB, flags, monitors, now: new Date(),
    secret: (name) => (typeof c.env[name] === "string" ? c.env[name] : undefined),
    verify: verifyMonitorSignature, parse: parseMonitorDelivery,
  }));
```

The composer reads angles from `ComposeContext.angles`, which the cold batch fills with `loadAngles(db, rows.map((r) => ({ contactId: r.id, accountKey: r.account_key, accountName: r.account_name })), now, { openers, quoteSources })`. A caller that leaves `angles` unset gives no contact an angle, so templates that use the angle variables are held.

## Adding a source

A source that finds people writes candidates with `insertCandidate` (cleaned text, a `source_ref` for dedup, the id of its own attribution row from `ensureSourceQuery`), never contacts. A source that finds reasons calls `recordSignal` with a date, a URL, an expiry and a known account, and never quotes provider text into copy. Give it a job with `defineJob`, a flag in `packages/core/src/flags/registry.ts` that defaults off, a per-run ceiling, and the spend gate around every paid call. Its adapter implements the shape in `packages/core/src/signals/ports.ts`, ships a `manifest.json` with each capability's cost and tool class, and a contract test over recorded, synthetic responses.

## Limits

The per-run ceilings and rule constants are in `SIGNAL_LIMITS` (`packages/core/src/signals/flags.ts`). They are constants, not flags: loosening one is a code change and a review.

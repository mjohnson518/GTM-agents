# Signals and scale

This page is for deployers turning on the signal sources, and for contributors adding one. It explains the extra sources that find accounts and people beyond the discovery cycle's searches (websets, search monitors, responder lookalikes, coverage fill), the sources that find dated reasons to write (funding and leadership news, public hiring boards), what a signal is and the rules every signal follows, how a signal found early is carried to the first contacts at an account, the nightly intent score, and how a signal becomes the angle of a first touch. The code lives in `packages/core/src/signals/` and `packages/core/src/scoring/intent.ts`, published as `@gtm-agents/core/signals` and `@gtm-agents/core/scoring`. The adapters are `@gtm-agents/adapters/data-exa` and `@gtm-agents/adapters/data-jobboards`.

## What it does

```
websets, monitors, lookalikes, coverage fill  ->  candidates  ->  enrich -> qualify -> promote  ->  contacts
                                                                                        |
news, hiring boards, employment checks  ->  signals (contact or account)  ->  carry (72 h)  ->  +
                                         |
                                         +-> angle ({{angle_opener}}, {{angle_age}}) -> first touch
                                         +-> intent score (nightly, shadow until enforced)
                                         +-> cohort "signalled" on the send ledger
```

Every source is its own job behind its own flag, and every flag is off until you turn it on. Sources that find people never create contacts themselves: they write candidates, and the discovery cycle (`discovery:enabled`, [SOURCING.md](SOURCING.md)) enriches, qualifies and promotes them with every identity, suppression, fit and verification check. Sources that find reasons write signals, which never send anything on their own: they move the intent score and give a first touch its opener.

## Turning it on

1. Check that `src/index.ts` wires the adapters and the jobs. The worker template does; a deployment created from an older template adds them (see [Wiring](#wiring)).
2. Apply the migrations with `gtm migrate` (`0025_signals.sql` adds two columns to `monitor_items` and one to `discovery_queries`, plus indexes; `0030_monitor_signals.sql` adds `monitor_items.signal_id` for article signals).
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
| Search monitors | webhook, then `signal_monitor_drain` every 30 minutes | `signals:monitors_enabled` | account candidates; with `signals:article_monitors_enabled`, signals from article hits | 500 hits per delivery and per drain | billed by the provider per monitor run |
| Funding and leadership news | `signal_news`, weekdays 07:00 | `signals:news_enabled` | signals | 4 searches of 25 results | about $0.022 per search ($0.007 including 10 results, $0.001 for each further result) |
| Hiring boards | `signal_hiring_boards`, weekdays 06:00 | `signals:hiring_boards_enabled` | signals, role counts | 20 accounts | free (public boards) |
| Responder lookalikes | `signal_lookalikes`, Tuesday and Thursday 11:00 | `signals:lookalikes_enabled` | account candidates | 5 seeds, 30 inserts | $0.007 per find-similar of up to 10 results, $0.001 for each further result |
| Coverage fill | `signal_coverage_fill`, weekdays 12:00 | `signals:coverage_fill_enabled` | person candidates | 5 accounts, 2 people each | the people provider's search price |
| Intent score | `intent_scoring`, daily 02:30 | `scoring:intent_enabled` | `contacts.attributes.intent` | 5,000 contacts | free |
| Account watch | `signal_account_watch`, Mondays 06:30 | `signals:account_watch_enabled` | a digest; funding and leadership signals | 10 accounts | about $0.022 per search, within 50 cents a day |
| Competitor watch | `signal_competitor_watch`, Mondays 07:30 | `signals:competitor_watch_enabled` (proposals: `signals:competitor_proposals_enabled`) | a digest; at most one brain proposal a week | 8 competitors | about $0.022 per search, job boards free, one strategist call a week with proposals on; within 100 cents a day |
| Employment checks | `signal_employment`, weekdays 08:00 | `signals:job_change_enabled` | `contacts.employment_status`, new-role signals; with `signals:champion_moves_enabled`, person candidates | 10 checks, 5 champion lookups | 3 LeadMagic credits a check (about 6 cents on the Essential plan; free when the profile is not found), 1 credit a champion address found |

Every paid call goes through the spend gate with the job's daily cap (`websetsMaxSpendCents` 200, `newsMaxSpendCents` 50, `lookalikesMaxSpendCents` 50, `coverageMaxSpendCents` 100, `employmentMaxSpendCents` 60, `accountWatchMaxSpendCents` 50, `competitorWatchMaxSpendCents` 100 by default; a `budget:job:<job>:daily_cents` flag lowers any of them). A cap that is reached, or a budget that cannot be read, stops the run's paid calls. None of these jobs calls a model, except the competitor watch's weekly proposal (one strategist call, with `signals:competitor_proposals_enabled`).

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

The route resolves the key against your config only, refuses bodies over 1 MB, and verifies the signature (`Exa-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 of `<t>.<raw body>`, within five minutes) before it touches the database. With the flag off it answers 503 and records nothing. Hits are cleaned and stored in `monitor_items` in batches, deduplicated on the provider's result id and on the URL per monitor. The drain job turns up to 500 a run into raw account candidates, reading the account from the result's host, so only a monitor whose results are companies' own sites (`results: "company_sites"`, a search in the provider's company category) produces candidates. Hits from a monitor of articles (`results: "articles"`) never become candidates, so a publisher never becomes an account.

**Articles as signals.** With `signals:article_monitors_enabled` on as well, the drain reads each article hit the way the funding and leadership news job reads a news result ([below](#funding-and-leadership-news)): the hit needs a published date inside the last 30 days and a URL, its title must name exactly one known account by its distinctive name, and the rest of the title must read as a round raised or a leader appointed. Such a hit records a signal at that account with source type `search_monitor`, the monitor's key in its evidence, and the article's URL as its event key, so the same story delivered by two monitors is recorded once (the second hit is counted as a duplicate). A story the news job already recorded for the account under the same URL is not recorded again, in either direction; this is best effort, since it matches the URL exactly and the two jobs can run at the same moment. The hit's `monitor_items.signal_id` names one of the signal's rows; every other article is skipped. The drain writes `signal_id` only for article hits, so apply migration `0030` before turning the flag on (`gtm deploy` migrates first). Point an article monitor at news about the accounts you care about (for example, a search in the provider's news category for your segment) and it supplies dated reasons to write without a paid news search.

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

### Account watch

The news searches above look for categories (a round raised, a leader appointed) across every account. The account watch looks at the accounts that matter most, by name, every Monday:

- **Who.** Up to 10 accounts, in this order: those you pinned with `watch-add <domain>`, those with an open deal past contacted (engaged, demo scheduled, trial, proposal or negotiation), then the best model fit (not below the fit floor). An account whose name is too generic to match in a title (fewer than 4 letters, or a word such as "Labs") is skipped. `watch-list` shows every pinned account, marking one whose name is too generic, and who the next run covers.
- **What.** One dated news search for the account's name over the last 7 days. A hit is kept only when its title names that account, with a published date in the window and an http(s) URL, and only the first time it is seen, so an article is listed once, ever: at most 5 per account a week. A run in a week whose digest has gone searches nothing, and when the digest cannot be sent (no channel, the channel failed, or a run alongside it sent the week's digest first), the items are released and listed by the next run. A channel that times out after accepting the message can therefore show the same items twice: a repeated digest is preferred to a lost one.
- **Where it goes.** One digest a week in your chat: per account, each new title (cleaned to one line, as the publisher wrote it), its date and its link. A week with nothing new says so. A funding or leadership item also becomes a signal by the news rules above (source `account_watch`), so it can open a first touch.

### Competitor watch

Every Monday, for up to 8 competitors in your brain's approved `competitors` component:

- **News.** One dated search for the competitor's name over the last 7 days, kept only when the title names it as a whole phrase, and listed once, ever (at most 5 a week each; a digest that cannot be sent releases them for the next run). A name too generic to match in a title is not searched.
- **Open roles.** For a competitor with a `domain` ([BRAIN-SCHEMA.md](BRAIN-SCHEMA.md)), the public job boards for the token the domain gives (Greenhouse, Lever, Ashby), counted per role kind, never titles.
- **The digest.** One message a week: per competitor, the new titles with dates and links, and the open roles. A digest sent again after a failed one names the week's pending proposal again.
- **A proposed edit** (`signals:competitor_proposals_enabled`). A week with news makes at most one strategist call:
  - The model reads the approved `competitors` file and the week's titles and counts, fenced as untrusted, and may change at most 3 items.
  - The edit is refused if it adds a link, a dash, anything that reads like an instruction, or a figure the brain does not already hold (so no number from the news). It is also refused if it does not validate.
  - It cannot write a competitor's `domain`, and an item it returns changes only the fields it names.
  - A week whose call could not be made (no model, no price, the budget) gives its slot back.
  - Otherwise it becomes an ordinary brain proposal, and the digest names `learning-show <id>`.
  - It never applies on its own, at any autonomy level ([LEARNING.md](LEARNING.md#the-competitor-watchs-proposals)). Approved `competitors` text reaches the reply writers and the strategist, so read it as you would your own.

### Employment checks

A contact who left their company keeps getting mail at an address that will soon bounce, and one who just started a role is worth a timely note. With `signals:job_change_enabled` on and an `EmploymentChecker` wired (the template's `data-leadmagic`), `signal_employment` checks up to 10 contacts each weekday:

- **Who.** Contacts with an `https` profile URL (`contacts.attributes.profile_url`, which promotion copies from the people provider) and an account, not already moved, opted out, churned, suppressed or tombstoned. A contact is due when never checked, checked over 90 days ago, or inconclusive and checked over 30 days ago. Customers, then hot, engaged, warming, contacted and cold contacts go first, oldest check first. The suppression check runs again before each paid call; a contact it blocks is set aside for 90 days.
- **Still there.** `employment_status` becomes `current`. If the current role began in the last 90 days, the contact gets one `job_change` signal (source `employment_check`, the headline "Started a new role", the profile as its source, expiring in 45 days), which feeds the new-role angle.
- **Moved.** `employment_status` becomes `moved`, so the cold batch and every sequence skip them from then on (lifecycle follow-ups to product users do not read it). For a warming, engaged, hot or customer contact you get one chat notice, written only from our own records: "<name> at <account> (contact <id>) has moved to another company. No more cold or follow-up mail will go to their address there." The provider's text never reaches it.
- **Inconclusive** (never worked there, several current roles, no dates, or no profile found): `employment_status` becomes `unknown`, and the contact is checked again after 30 days.

Every check writes `employment_checked_at`. A provider error stops the run, and the contacts not yet checked stay due.

### Champion moves

With `signals:champion_moves_enabled` on as well, a second pass in the same run looks up every moved contact who was engaged, hot or a customer and has not been looked up yet, at their current employer from their profile alone, at most 5 lookups a run. A move found while the flag was off, or a lookup the budget or a provider error stopped, is picked up by a later run; a finished lookup is marked on the contact (`attributes.champion_lookup_at`) and never repeated:

- the address is kept only when it is a clean work address at the domain the provider names, that domain is not their old account, and the address is not suppressed;
- it becomes a raw candidate (source `champion_move`) linked to the old contact by `candidates.source_contact_id`, with the new title (from the employment check) and company name stored as cleaned data;
- the discovery cycle then screens, verifies and qualifies it like any other candidate (the ICP, the never list, person fit on the new title), and promotes it only if it passes; promotion also refuses it if the person has since opted out or been suppressed at their earlier address. Nothing is sent: the cold batch's own approval still applies;
- the chat notice says they were added as a candidate at their new company, without naming it.

A champion is one person at two addresses, so erasure follows the link both ways, through addresses only (a namesake at the new company is never erased in their place): erasing either address erases the contacts, candidates and data held under both, and tombstones both ([SECURITY-MODEL.md](SECURITY-MODEL.md#employment-checks-and-champion-moves)).

### Source attribution

Each non-search source has its own `discovery_queries` row, inactive so the search stage never runs it: one per webset, per monitor, per lookalike seed, and one for coverage fill. Candidates carry its id, contacts inherit it, and promotion credits it, so conversion reports compare sources the same way they compare queries.

## Signals

A signal is a dated, sourced reason to write to an account. Every row in `signal_events` carries:

| Field | Column |
|---|---|
| source type | `source` (`exa_news`, `search_monitor`, `hiring_board`, ...) |
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
- The watches send the news provider an account's or a competitor's name, and nothing about any person.
- Employment checks send the provider a contact's profile URL and the expected company, and nothing else. A champion lookup sends the profile URL and the name. A champion is erased at both addresses together.
- Evidence and headlines are stored as data. They never reach a system prompt, and they reach copy only through the whitelisted headline variable.

## Wiring

```ts
import { createSignalJobs, handleMonitorWebhook } from "@gtm-agents/core/signals";
import { createAdapter as createExa, parseMonitorDelivery, verifyMonitorSignature } from "@gtm-agents/adapters/data-exa";
import { createAdapter as createJobBoards } from "@gtm-agents/adapters/data-jobboards";
import { createAdapter as createHunter } from "@gtm-agents/adapters/data-hunter";
import { createAdapter as createLeadMagic } from "@gtm-agents/adapters/data-leadmagic";

const signals = createSignalJobs<Env>({
  adapters(env) {
    const exa = createExa(context(env, "data-exa"));
    const employment = createLeadMagic(context(env, "data-leadmagic"));
    return { discovery: exa, similar: exa, news: exa, boards: createJobBoards(context(env, "data-jobboards")), people: createHunter(context(env, "data-hunter")), employment };
  },
  // Notices about contacts who moved jobs.
  operator,
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

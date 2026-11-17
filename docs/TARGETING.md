# Product and ICP

This page is for deployers who want the system to know what their product is and who it is for, without writing the brain files by hand. The dashboard's **Product and ICP** view reads your own website, drafts a short product description and an ideal customer profile (ICP) with a model, and lets you edit both and approve each one into the brain. Once both are approved, it suggests search queries and personas from them, and a readiness card says what discovery and fit scoring have to work with. Contributors changing the draft path should read [SECURITY-MODEL.md](SECURITY-MODEL.md#the-product-and-icp-draft) for how it is classified.

Nothing drafted or suggested steers anything. A draft only fills the editor, and a suggestion only fills a list to pick from. Only a file a person approved, through the same brain proposal path every brain change takes, is served to fit scoring, sourcing or the agent.

## Turn it on

```bash
npx gtm migrate                                   # migrations 0035 and 0036: drafts and suggestions
npx gtm flags set targeting:enabled true          # the page can save and propose
npx gtm flags set targeting:draft_enabled true    # AI drafts (needs a model gateway)
npx gtm flags set targeting:suggest_enabled true  # suggested queries and personas (needs a model gateway)
```

Every flag defaults off and reads fail closed: a flag that cannot be read is off. With `targeting:enabled` off the page still shows what is served, read only. With `targeting:draft_enabled` or `targeting:suggest_enabled` off you can still write and approve every item yourself, with no model involved.

Approving from the page needs the learning module's dashboard source, `learningDashboard()` in `createWorker`'s `dashboard` option. The template wires it.

## What you get

Two brain components, each a list of short typed items:

| Component | Item kinds | What it steers once approved |
|---|---|---|
| `product` | `summary` (what it is), `problem`, `capability`, `outcome`, `use_case`, `differentiator`, `not_for` | The model fit score and the chat agent's planning (the `fit` and `strategist` slices), and so the one-off drafts that agent writes for you to approve. The template writers (cold mail, sequences, replies, lifecycle) never read it: `facts` stays the only thing they state |
| `icp` | `who`, `why_now`, `must_have`, `trigger`, `ignore`, `never`, `unknown` | The model fit score, the fit gate in front of paid enrichment and promotion, sourcing's hard stops (`never` items), and the agent's planning |

Suggestions add to two more components, never replacing what they hold:

| Component | Item fields | What it steers once approved |
|---|---|---|
| `keyword-portfolio` | `query`, `intent`, optional `segment` | What search looks for, and so what discovery spends on |
| `personas` | `role`, `seat`, `titles`, `seniority`, `exclude_titles`, `text` | Which people pass person fit (so who is enriched, qualified and promoted), the chat agent's planning, and the cold mail writers, which read `personas` |

The ICP describes the company that fits, not a person: job titles belong in `personas`. [SOURCING.md](SOURCING.md#what-the-brain-steers) lists everything each component steers. `company.product.description` in `gtm.config.ts` stays the one-line identity in system prompts; the page shows it, read only.

## Readiness

The page opens with what discovery and fit scoring have to work with, in plain lines: whether `product`, `icp`, `personas` and `keyword-portfolio` are approved (with their version and item count), and whether `discovery:enabled`, `fit:scoring_enabled` and `enrichment:research_enabled` are on. A missing piece says what it costs:

- no `keyword-portfolio`: search looks for nothing;
- no `personas`: search still runs and spends, but nobody it finds is enriched, qualified or promoted;
- no `icp`: fit scoring has nothing to judge accounts against, and sourcing has no hard stops;
- a component that does not match the brain's lock: discovery does nothing until the brain is uploaded again.

Everything here only reads, and a read that fails shows as off or not approved.

## Drafting from your site

Enter your site's URL (the page fills in `company.url`) and choose **Draft with AI**. The draft takes up to a minute.

1. **Reading.** The page is read with the same rules as the chat agent's `web_fetch`: a full `http` or `https` URL that passes the URL check, redirects followed by hand with every hop checked, at most 512 KB, HTML and plain text only. Then up to three more pages on the same registrable domain, taken from the first page's links when their path names a product, features, pricing, customers, about or solutions page, with no query string. A page that redirects off the site is skipped. No logins, no forms, no JavaScript. At most 24,000 characters go to the model.
2. **Drafting.** One model call on the `worker` role. The system prompt is a fixed rubric in code; your site's text goes only into the user turn, sanitized and fenced as untrusted exactly as the chat agent's `web_fetch` output is. The rubric asks for paraphrase, one segment per `who` item, an `unknown` item for every question a website cannot answer (who your most profitable and longest-staying customers are, why they chose you, what they considered instead, what size is too small, how they buy), and each item marked **stated** (the page says it) or **inferred**.
3. **Filtering.** Every drafted item is checked before you see it. An item is left out when it holds a link, an em or en dash, a price or a customer name, reads like an instruction, copies 12 or more words in a row from the site, breaks the brain's limits (a known kind, at most 300 characters and two sentences), or is an ICP `never` item: hard stops are written by a person. An item that states a figure is kept and marked so you check it. The page lists what was left out and why.

A site with too little readable text, a page that cannot be read, or an answer in the wrong shape makes no draft, and the page says why. Choose **Paste text instead** to draft from text you paste; it is treated exactly like page text. On a shared host (a site on a platform's subdomain), only pages on that exact host are read. Only each page's URL, title, size and hash are stored, never its text.

## Editing and approving

Each card is a list of items, one text box each, with its kind, a character counter and badges: drafted from your site (stated or inferred), states a figure, and not yet approved, shown whenever the served file does not hold that exact item (a drafted item loses it once its file is approved; a served item you edit gets it). ICP items are grouped as Who, Why now, Must have, Triggers, Ignore, Never and Open questions.

- **Hard stops are kept.** Every `never` item the brain serves is in the editor unchanged, including one added after the draft was made. An ICP that leaves out a hard stop the brain serves is refused unless you confirm removing it: the page names each one and asks first.
- **The served file must check out.** If a component listed in the brain's lock does not match it (an upload that stopped halfway, or KV still settling), nothing is drafted or proposed over it, because what it holds cannot be shown.
- **Check** renders the card as the component's next file (the served version plus one, today's date) and validates it with the rest of the brain: the schema, no links, no prices, no dashes, and its size in each task that reads it, against the room left beside what is served there. A `product` that would not fit beside the served `icp` in the fit slice is flagged, because that task would leave it out.
- **Save draft** keeps your edits. Unsaved edits survive a reconnect, and leaving the page with them asks first.
- **Review and approve** stores an ordinary brain proposal against the file served now and shows you its exact diff. Approve, and the component is replaced and the brain re-locked, as for any approved brain proposal. If the component changed since, the approval is refused as stale and you review again. The proposal is also listed in the Proposals view until it is decided; reviewing the same component again from this page replaces it with the newer file, so only one waits. A proposal you made yourself is never autonomy evidence and never applies on its own.
- **Start from approved** loads the served file into the editor; **Copy file** copies it.

A served component last approved more than 90 days ago gets a gentle hint to review it.

## Suggested search queries and personas

With `product` and `icp` approved, **Suggest search queries and personas** makes one model call on the `worker` role. It reads only approved, locked brain text: the product, the ICP, and the `personas` and `keyword-portfolio` already served, so it does not repeat them. No web page is read. The answer is up to 8 queries and 4 personas, and each is checked in code before you see it: an item that breaks the brain's schema, holds a link, a dash or a price, or reads like an instruction is left out; so is a query that repeats a served one, and a query, segment or persona description that names a company or domain on the ICP's never list (a never-list domain such as `initech.example` also catches the word "Initech"). A persona title already in a served persona, or on the never list, is removed, and a persona left with no title is left out. A brain sourcing cannot read whole stops the suggestion before it starts, because its never list could not be applied. The page lists what was left out and why.

Then, per component:

1. **Pick** the suggestions that fit. Nothing is picked until you tick it.
2. **Edit** the main text: a query's wording, or a persona's titles and what they care about. The other fields (intent and segment; role, seat, seniority and excluded titles) stay as suggested. To change those, approve and then edit the brain file.
3. **Save picks** keeps them; **Check** renders the next file and checks it, including its size in every task that reads it (for `personas`: the account, outreach and strategist slices).
4. **Review and approve** proposes every item served now, unchanged and in order, followed by your picks, and shows the exact diff. The server builds that file, so a proposal from the page can add queries and personas but never drop or change one you wrote; if the component changes while it is being checked, the proposal is refused and you check again. Only items are kept: notes written above a file's first item are not, so keep those in your brain folder. A pick that repeats a served query or persona title in other words gets a warning. Approve, and the component is replaced and the brain re-locked. A proposal you leave pending is replaced by your next review of the same component, so picks you have not approved yet are not carried into the next one: pick them again.

A proposal can only hold items from that suggestion, edited only in their main text, so a proposal described as suggested by the model is one. It is recorded as yours (`operator:<email>`): it never counts as autonomy evidence and never applies on its own. Approved persona text reaches the cold mail writers, as every approved persona does, so read it as copy that may shape what prospects receive.

## Keeping your brain folder in step

An approval in the dashboard writes the deployment's brain, so your local `brain/` folder is now older than what is served. Bring it in before you next upload:

```bash
npx gtm brain pull          # writes the served files and the lock into brain/
```

`gtm brain pull` asks before it replaces a local file that differs (pass `--yes`). `gtm brain upload` reads the deployed brain first and stops when a component it serves is at a newer version than your local file, or is not in your folder at all, because uploading would silently undo the approval. It also stops on a component at the same version with other content, which is what a local edit that reused the served version number looks like. Pull first, or pass `--force` to replace it. An upload that cannot read the deployed brain, or finds a deployed file that does not match the deployed lock, stops too; so does a pull.

## Limits

| Limit | Default | Change it with |
|---|---|---|
| AI drafts per UTC day | 10 (at most 50) | `targeting:drafts_daily_max`; unreadable means 0 |
| Spend per UTC day for drafts | 100 cents | `budget:job:targeting_draft:daily_cents` can lower it; the global budget applies too |
| Drafts running at once | 1 | Fixed; one still running after five minutes reads as failed |
| Pages read per draft | 4, 512 KB each | Fixed (`SITE_EXTRA_PAGES`) |
| Text sent to the model | 24,000 characters | Fixed (`SITE_TEXT_MAX_CHARS`) |
| Items per draft | 12 product, 16 ICP | Fixed |
| Suggestions per UTC day | 5 (at most 20) | `targeting:suggestions_daily_max`; unreadable means 0 |
| Spend per UTC day for suggestions | 50 cents | `budget:job:targeting_suggest:daily_cents` can lower it; the global budget applies too |
| Suggestions running at once | 1 | Fixed; one still running after five minutes reads as failed |
| Items per suggestion | 8 queries, 4 personas | Fixed |
| Items added per approval | 12 | Fixed (`ADDITIONS_MAX`) |

Every draft and suggestion is checked against the budget before the model call and recorded in the cost ledger, under the job `targeting_draft` or `targeting_suggest`. Nothing re-reads your site on a schedule.

## When something is wrong

| Symptom | Likely cause |
|---|---|
| The page is read only | `targeting:enabled` is off |
| "Draft with AI" is disabled | `targeting:draft_enabled` is off, or no model gateway is wired |
| "needs a model in models.roles and its price" | Map the `worker` role to a model and price it in `gtm.config.ts` |
| "the site has too little readable text" | The site renders with JavaScript; paste the text instead |
| "Review and approve" is disabled | The Worker does not pass `learningDashboard()` to `createWorker` |
| The approval is refused as stale | The component changed since the proposal was made; review it again |
| `gtm brain upload` stops with "would undo" | A component was approved in the dashboard; run `gtm brain pull` |
| "Suggest search queries and personas" is disabled | `targeting:suggest_enabled` is off, no model gateway is wired, or `product` or `icp` is not approved |
| "the served personas does not match the brain's lock" | A file was edited without uploading the brain again; upload it, then suggest again |
| A pick is refused as "not one of the suggested items" | The page is older than the suggestion; refresh, then pick again |

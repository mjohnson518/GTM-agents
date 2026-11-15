# Product and ICP

This page is for deployers who want the system to know what their product is and who it is for, without writing the brain files by hand. The dashboard's **Product and ICP** view reads your own website, drafts a short product description and an ideal customer profile (ICP) with a model, and lets you edit both and approve each one into the brain. Contributors changing the draft path should read [SECURITY-MODEL.md](SECURITY-MODEL.md#the-product-and-icp-draft) for how it is classified.

Nothing drafted steers anything. The draft only fills the editor. Only a file a person approved, through the same brain proposal path every brain change takes, is served to fit scoring, sourcing or the agent.

## Turn it on

```bash
npx gtm migrate                                   # migration 0035, the drafts table
npx gtm flags set targeting:enabled true          # the page can save and propose
npx gtm flags set targeting:draft_enabled true    # AI drafts (needs a model gateway)
```

Both flags default off and read fail closed: a flag that cannot be read is off. With `targeting:enabled` off the page still shows what is served, read only. With `targeting:draft_enabled` off you can still write and approve every item yourself, with no model involved.

Approving from the page needs the learning module's dashboard source, `learningDashboard()` in `createWorker`'s `dashboard` option. The template wires it.

## What you get

Two brain components, each a list of short typed items:

| Component | Item kinds | What it steers once approved |
|---|---|---|
| `product` | `summary` (what it is), `problem`, `capability`, `outcome`, `use_case`, `differentiator`, `not_for` | The model fit score and the chat agent's planning (the `fit` and `strategist` slices), and so the one-off drafts that agent writes for you to approve. The template writers (cold mail, sequences, replies, lifecycle) never read it: `facts` stays the only thing they state |
| `icp` | `who`, `why_now`, `must_have`, `trigger`, `ignore`, `never`, `unknown` | The model fit score, the fit gate in front of paid enrichment and promotion, sourcing's hard stops (`never` items), and the agent's planning |

The ICP describes the company that fits, not a person: job titles belong in `personas`. [SOURCING.md](SOURCING.md#what-the-brain-steers) lists everything each component steers. `company.product.description` in `gtm.config.ts` stays the one-line identity in system prompts; the page shows it, read only.

## Drafting from your site

Enter your site's URL (the page fills in `company.url`) and choose **Draft with AI**. The draft takes up to a minute.

1. **Reading.** The page is read with the same rules as the chat agent's `web_fetch`: a full `http` or `https` URL that passes the URL check, redirects followed by hand with every hop checked, at most 512 KB, HTML and plain text only. Then up to three more pages on the same registrable domain, taken from the first page's links when their path names a product, features, pricing, customers, about or solutions page, with no query string. A page that redirects off the site is skipped. No logins, no forms, no JavaScript. At most 24,000 characters go to the model.
2. **Drafting.** One model call on the `worker` role. The system prompt is a fixed rubric in code; your site's text goes only into the user turn, sanitized and fenced as untrusted exactly as the chat agent's `web_fetch` output is. The rubric asks for paraphrase, one segment per `who` item, an `unknown` item for every question a website cannot answer (who your most profitable and longest-staying customers are, why they chose you, what they considered instead, what size is too small, how they buy), and each item marked **stated** (the page says it) or **inferred**.
3. **Filtering.** Every drafted item is checked before you see it. An item is left out when it holds a link, an em or en dash, a price or a customer name, reads like an instruction, copies 12 or more words in a row from the site, breaks the brain's limits (a known kind, at most 300 characters and two sentences), or is an ICP `never` item: hard stops are written by a person. An item that states a figure is kept and marked so you check it. The page lists what was left out and why.

A site with too little readable text, a page that cannot be read, or an answer in the wrong shape makes no draft, and the page says why. Choose **Paste text instead** to draft from text you paste; it is treated exactly like page text. On a shared host (a site on a platform's subdomain), only pages on that exact host are read. Only each page's URL, title, size and hash are stored, never its text.

## Editing and approving

Each card is a list of items, one text box each, with its kind, a character counter and badges: drafted from your site (stated or inferred), states a figure, not yet approved. ICP items are grouped as Who, Why now, Must have, Triggers, Ignore, Never and Open questions.

- **Hard stops are kept.** Every `never` item the brain serves is in the editor unchanged, including one added after the draft was made. An ICP that leaves out a hard stop the brain serves is refused unless you confirm removing it: the page names each one and asks first.
- **The served file must check out.** If a component listed in the brain's lock does not match it (an upload that stopped halfway, or KV still settling), nothing is drafted or proposed over it, because what it holds cannot be shown.
- **Check** renders the card as the component's next file (the served version plus one, today's date) and validates it with the rest of the brain: the schema, no links, no prices, no dashes, and its size in each task that reads it, against the room left beside what is served there. A `product` that would not fit beside the served `icp` in the fit slice is flagged, because that task would leave it out.
- **Save draft** keeps your edits. Unsaved edits survive a reconnect, and leaving the page with them asks first.
- **Review and approve** stores an ordinary brain proposal against the file served now and shows you its exact diff. Approve, and the component is replaced and the brain re-locked, as for any approved brain proposal. If the component changed since, the approval is refused as stale and you review again. The proposal is also listed in the Proposals view until it is decided. A proposal you made yourself is never autonomy evidence and never applies on its own.
- **Start from approved** loads the served file into the editor; **Copy file** copies it.

A served component last approved more than 90 days ago gets a gentle hint to review it.

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

Every draft is checked against the budget before the model call and recorded in the cost ledger under the job `targeting_draft`. Nothing re-reads your site on a schedule.

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

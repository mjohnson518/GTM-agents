# Brain and template schema

This page is for deployers writing the brain and templates for their company, and for contributors changing the brain or template engines (`packages/core/src/brain/` and `packages/core/src/templates/`). Everything a deployment knows about its company, market and voice lives in two folders next to `gtm.config.ts`:

- **`brain/`:** short, typed, operator-approved lists that prompts read instead of whole documents.
- **`templates/`:** operator-written email templates. Cold copy is assembled from these by substitution, never generated.

Both are plain Markdown with a small frontmatter block, so they are easy to write, review and diff. `gtm brain validate` checks both against the rules in this document. The machine-readable JSON Schemas generated from the same definitions are published under `packages/core/brain/schema/`, for editors and other tools.

## Brain files

One file per component: `brain/<component>.md`. A `README.md` in the folder is ignored, so you can keep notes next to the files. A file has three parts:

```markdown
---
component: personas
status: approved
version: 3
updated: 2026-11-01
owner: Head of Sales
---

# Personas

Anything between the title and the first item is a note for humans. It is never sent to a model.

## economic-buyer
- role: economic_buyer
- seat: decision_maker
- titles: VP Engineering, Head of Engineering, CTO
- seniority: c_level, vp, head
- text: Owns the engineering tooling budget and approves contracts above the team's discretionary limit.

## platform-champion
- role: champion
- seat: influencer
- titles: Staff Engineer, Principal Engineer, Head of Developer Experience, Platform Lead
- text: Feels the pain of slow, flaky pipelines every day and can run a trial without asking anyone.
```

**Frontmatter.** One flat `key: value` per line, with no nesting and no inline comments.

| Key | Required | Value |
|---|---|---|
| `component` | yes | The component id. Must equal the file name without `.md` |
| `status` | yes | `draft` or `approved`. Only approved files are ever served |
| `version` | yes | A positive integer the operator bumps on each change |
| `updated` | yes | `YYYY-MM-DD` |
| `owner` | no | Who maintains the file |

**Items.**
- Each item starts with `## <item-id>`. Item ids are kebab-case and unique within the file, and other components can reference them.
- Each field is a bullet: `- key: value`.
- Keys and enum values are `snake_case`.
- List fields are comma-separated, so values in a list cannot contain commas.
- Every value fits on one line.

**Rules for every file:**
- `text`-type values are at most 300 characters and at most two sentences.
- Names are at most 80 characters.
- Lists hold at most 30 values of at most 80 characters each.
- URLs are allowed only in the `url` fields of `facts` and `commercial`, and must be `https`.
- Prices and currency amounts are allowed only in `commercial`.
- No em dashes or en dashes.
- No text copied from the web or from inbound email, and no customer names. The brain is the operator's own words.

## Components

The brain has fourteen components: twelve typed lists, plus `facts` (the only facts a prospect-facing writer may state) and `commercial` (plans and prices, never shown to a prospect-facing writer).

| Component | Holds | Read by tasks |
|---|---|---|
| `market-profile` | The category, segments, trends and buying behavior | strategist |
| `personas` | Buying roles, with the title keywords that identify them | outreach, strategist, account |
| `icp` | Who you sell to, why now, must-haves, hard exclusions, triggers | fit, sourcing, strategist |
| `message-pillars` | The claims your outreach makes, linked to the facts that support them | outreach, judge, strategist |
| `objections` | Real objections and the operator-approved answer to each | replies |
| `competitors` | Who else the buyer considers, and how you honestly differ | replies, strategist |
| `influencers` | Publications, communities, people and events the buyer trusts | account |
| `keyword-portfolio` | Search queries for sourcing, by intent | sourcing |
| `voice` | How the operator writes: do, don't, phrases, sign-off | outreach, replies, judge |
| `signals` | Which buying signals matter, and how much | sourcing |
| `stack` | Technologies you integrate with, replace or depend on | replies |
| `hiring` | Roles whose hiring signals a need for the product | sourcing |
| `facts` | The only facts a reply or outreach email may state | outreach, judge, replies, close |
| `commercial` | Plans, prices and terms | strategist, close |

### Fields by component

Fields marked * are required.

**`market-profile`**
- `kind`*: one of `category`, `segment`, `trend`, `buyer_behavior`, `timing`, `size`
- `text`*

**`personas`**
- `role`*: one of `economic_buyer`, `champion`, `user`, `influencer`, `blocker`
- `seat`*: one of `decision_maker`, `influencer`, `user`, `other`
- `titles`*: a list of title keywords
- `seniority`: a list drawn from `c_level`, `vp`, `head`, `director`, `manager`, `lead`, `senior`, `individual`
- `exclude_titles`: a list
- `text`*

**`icp`**
- `kind`*: one of `who`, `why_now`, `must_have`, `never`, `trigger`, `ignore`, `unknown`
- `text`*
- `domains`, `accounts`, `titles`: lists, allowed only on `never` items. A `never` item needs at least one of them. `never` items are hard stops that the selection code enforces.

**`message-pillars`**
- `text`*
- `proof`: a list of `facts` item ids
- `personas`: a list of `personas` item ids

**`objections`**
- `objection`*
- `response`*: the approved answer
- `personas`: a list of `personas` item ids

**`competitors`**
- `name`*
- `positioning`*: how they present themselves
- `differentiators`*: how you differ, stated honestly
- `when_we_lose`

**`influencers`**
- `kind`*: one of `publication`, `newsletter`, `podcast`, `community`, `person`, `event`
- `name`*
- `text`*

**`keyword-portfolio`**
- `query`*
- `intent`*: one of `problem`, `solution`, `competitor`, `trigger`, `role`
- `segment`

**`voice`**
- `kind`*: one of `do`, `dont`, `phrase`, `avoid`, `signoff`
- `text`*

**`signals`**
- `type`*: one of `job_change`, `hiring`, `funding`, `launch`, `post`, `news`, `filing`, `product_usage`, `custom`
- `weight`*: a number from 0 to 1
- `max_age_days`: an integer from 1 to 365
- `text`*

**`stack`**
- `technology`*
- `relation`*: one of `integrates`, `complements`, `replaces`, `competes`, `requires`
- `text`*

**`hiring`**
- `titles`*: a list
- `weight`*: a number from 0 to 1
- `text`*

**`facts`**
- `text`*
- `value`: the exact number or term a writer may use
- `url`: https
- `expires`: `YYYY-MM-DD`

**`commercial`**
- `plan`*
- `price`: a number
- `currency`: ISO 4217, required with `price`
- `interval`: one of `month`, `year`, `one_time`
- `text`*
- `url`: https

An id listed in `proof` or `personas` must exist in the referenced component.

## Serving rules

A component reaches a prompt only if all of these hold:

1. Its frontmatter says `status: approved`.
2. Its frontmatter `component` matches the file name.
3. The SHA-256 of the file's exact bytes matches its entry in the lock file.
4. It parses cleanly and passes the single-file rules: no URLs outside `url` fields, no prices outside `commercial`.

The loader re-checks all of these at runtime. A draft is never read, and with no lock nothing is served. When a component is not served, prompts fall back to behavior that does not depend on it.

### Byte budgets

Each task gets a fixed slice of the brain, under a byte budget:

| Task | Budget | Components, in priority order |
|---|---|---|
| `fit` | 2 KB | icp |
| `sourcing` | 4 KB | icp, signals, hiring, keyword-portfolio |
| `judge` | 4 KB | voice, facts, message-pillars |
| `account` | 4 KB | personas, influencers |
| `outreach` | 6 KB | personas, message-pillars, voice, facts |
| `strategist` | 6 KB | market-profile, icp, personas, message-pillars, competitors, commercial |
| `close` | 6 KB | facts, commercial |
| `replies` | 8 KB | facts, objections, competitors, voice, stack |

Components are added whole, in priority order, while they fit. A component is never cut mid-item. A component that is missing, unapproved, unlocked or too large for the remaining budget is named at the end of the slice:

```
Missing from the brain for this task: competitors, stack. Do not fill these in from memory; say what is unknown.
```

The slice starts with a header that carries the brain version, the first 12 hex characters of the lock hash. Every output can then be traced to the brain it read:

```
GTM BRAIN (version 3f9a1c0b7d2e, operator-approved; task: replies)
```

`commercial` appears only in the `strategist` and `close` slices. No prospect-facing writer ever receives prices or offers.

### The lock file

`brain/brain.lock.json` records the hash of every approved file:

```json
{
  "version": 1,
  "hash": "3f9a1c0b7d2e...<64 hex characters>",
  "files": {
    "icp.md": "<sha256 of the file's bytes>",
    "personas.md": "<sha256 of the file's bytes>"
  }
}
```

- `hash` is the SHA-256 of the sorted lines `<file> <sha256>\n`.
- Only approved files are locked.
- `gtm brain validate --write-lock` writes the lock, and only when validation passes. `gtm brain upload` validates, requires that lock, and uploads the files first and the lock last to the deployment's KV namespace (`brain:file:<component>`, then `brain:lock`; templates likewise under `template:file:<id>` and `templates:lock`), so a half-finished upload is never served.
- Editing an approved file without re-locking it takes that component out of every prompt until the operator re-locks it. That is deliberate: what is served is always what was approved.

The learning loops may propose brain changes ([LEARNING.md](LEARNING.md)). Each proposal shows the exact component diff and the hash of the file it replaces; a person approves it, and applying it writes the file and re-locks the brain through the same lock functions, refusing when the current file no longer matches. Direct writes without a person happen only for the `brain_edit` class at autonomy level 2 or above, and a regression afterwards rolls the edit back and demotes the class.

## Templates

One file per template: `templates/<id>.md`. The frontmatter holds the metadata and the subject; the body is the plain-text email.

```markdown
---
id: cold-intro-flaky-builds
kind: cold_intro
status: approved
step: 1
angle: none
volume_weight: 1
subject: Flaky builds at {{account_name}}
personas: platform-champion, economic-buyer
---
Hi {{first_name}},

Most teams we talk to lose a few engineer-hours a week rerunning builds that failed for no reason.
{{persona_line}}

Is that something your team tracks today, or does it mostly show up as frustration in standup?

{{sender_name}}
```

| Key | Required | Value |
|---|---|---|
| `id` | yes | Kebab-case. Must equal the file name without `.md` |
| `kind` | yes | One of `cold_intro`, `follow_up`, `breakup`, `check_in`, `proposal`, `lifecycle` |
| `status` | yes | `draft` or `approved` |
| `step` | for sequence kinds | The sequence step: `cold_intro` is 1, then `follow_up`, then `breakup` |
| `angle` | no | The signal angle the opener uses: `none` (the default), `job_change`, `hiring`, `funding`, `leadership`, `launch`, `news`, `custom`. A follow-up step prefers templates written for the first email's angle, then those with angle `none` |
| `subject` | yes | At most 90 characters after substitution. May use variables |
| `volume_weight` | no | A number from 0 to 1 (default 1): the operator's share before experiments take over |
| `segments`, `personas`, `team_sizes` | no | Targeting lists. A template with targeting is offered only to matching contacts |
| `updated` | no | `YYYY-MM-DD` |

### Variables

| Variable | Comes from |
|---|---|
| `{{first_name}}`, `{{last_name}}`, `{{title}}` | The contact |
| `{{account_name}}` | The account |
| `{{angle_opener}}` | The operator's fixed opener for the signal angle, with only the account name substituted, from the contact's own real, unexpired signal. Third-party text never reaches an email |
| `{{angle_age}}` | How long ago the signal happened, for example "last week" |
| `{{angle_headline}}` | The signal's cleaned headline, only for source types you whitelist ([SIGNALS.md](SIGNALS.md)). Every draft from a template that uses it is reviewed by a person |
| `{{persona_hint}}` | The persona playbook line for the contact's persona |
| `{{original_subject}}` | The first email's subject, for follow-up steps. A follow-up's subject is always `Re: ` and that subject, so it threads |
| `{{booking_url}}` | The booking link from config |
| `{{sender_name}}` | The agent name from config |
| `{{segment_line}}`, `{{team_size_line}}`, `{{persona_line}}` | Operator-written copy lines for the contact's segment, team size or persona. Each must sit alone on its line; when it is empty, the whole line is removed |
| `{{attributes.<key>}}` | A field from the contact's or account's `attributes`, when it is short single-line text with no link. Every draft from a template that uses one is reviewed by a person |
| `{{proven_insight}}`, `{{company_context}}` | Reserved for an approved learning snippet and the account's own site text. They validate, but nothing fills them in this release, so a template that uses either is held for every contact |

**Skip rather than guess.** If any variable a template uses has no value for a contact, the draft is held for that contact. Nothing ever falls back to "Hi there" or "your company".

**Lifecycle templates** are filled by the lifecycle follow-up writer, which supplies only `{{first_name}}`, `{{last_name}}`, `{{sender_name}}` and `{{booking_url}}`; any other variable skips every follow-up of that kind. Each follow-up reads the template with its own id, such as `lifecycle-first-use` ([LIFECYCLE.md](LIFECYCLE.md#lifecycle-follow-ups) lists them).

### Template rules

- The body is plain text. It has no footer, unsubscribe line or tracking: the send function appends the postal footer and the unsubscribe line to every email sent from a template.
- The only links allowed are `{{booking_url}}` and URLs on your own company domain.
- Word counts after substitution: `cold_intro` 30 to 180, `follow_up`, `breakup` and `check_in` 12 to 120, `proposal` and `lifecycle` 12 to 160. Validation rejects a body that is already over the maximum before substitution, and warns when it may be under the minimum; the send-time quality gate enforces the bounds on the rendered draft.
- `{{company_context}}` is not allowed in a subject.
- A `cold_intro` asks at least one question.
- At most one exclamation mark. No em dashes or en dashes.
- No placeholder syntax other than the variables above: no `{ }`, `[INSERT]`, `%s`, TODO or lorem.

These are structural checks. At send time, every rendered draft also passes the full deterministic quality gate and the model reviewer.

## Validation

```bash
npx gtm brain validate                 # ./brain and ./templates
npx gtm brain validate path/to/brain   # a brain directory, with the templates/ folder inside it (or next to it, when the directory is named brain)
npx gtm brain validate --write-lock    # validate, then write brain/brain.lock.json
```

`--templates <dir>` names another templates folder, and `--domain <domain>` sets the company domain for the template link check (otherwise it comes from `gtm.config.ts`).

**Errors** (non-zero exit):
- a file name that is not one of the fourteen components, or a file in the brain folder that is not Markdown (`README.md` and the lock file excepted);
- invalid frontmatter;
- an unknown field or a missing required field;
- a wrong enum value, an out-of-range number or a malformed date;
- an over-long value or list;
- a URL or price outside the components that allow them;
- an em or en dash;
- a broken id reference;
- a lock entry that does not match an approved file;
- a component larger than the budget of every task that reads it;
- any template rule above.

**Warnings:**
- a missing component;
- a draft component;
- a component that some task will drop for size;
- a template without targeting when others have it.

Missing components are allowed, so a new deployment can start with an empty brain and add components one at a time.

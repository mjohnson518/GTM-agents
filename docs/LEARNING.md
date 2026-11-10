# Self-improvement: proposals, learnings, voice, fitness, benchmark and evolution

This page is for deployers deciding which self-improvement loops to turn on, and for contributors changing how a loop proposes or how a proposal applies. It covers the shared proposal record and how you approve one, the learnings document, what each writer reads (the learnings and agent memory, under byte budgets), each loop with its guardrail, the operator commands, the flags, the jobs and their costs, the wiring and the limits. The code lives in `packages/core/src/learning/` (`@gtm-agents/core/learning`); the fitness inputs live with every other metric in `packages/core/src/metrics/fitness.ts`.

The rule behind every loop: it only proposes. You approve the exact text or diff you are shown, and nothing changes the brain, a template or the learnings on its own. The one exception is what earned autonomy allows ([AUTONOMY.md](AUTONOMY.md)): the `brain_edit` and `retrospective_actuation` classes at level 2 or above, read through the autonomy module's level reader at the moment of applying, never through a flag.

## Proposals

Every loop writes the same record (`learnings_proposals`, extended by migration `0027_learning.sql`). A proposal is one of:

| Kind | What approving it does |
|---|---|
| `learning` | Adds a snippet to one section of the learnings document |
| `brain` | Replaces one brain component file and re-locks the brain |
| `voice` | The same, for the voice component, rebuilt from your sent mail |
| `objection_answer` | Writes your answer to a filed objection, with its approval digest |
| `template` | Nothing in the templates: it approves a candidate and hands you the `experiment-create` block to test it through the copy-change gate ([EXPERIMENTS.md](EXPERIMENTS.md)) |
| `discovery_query` | Adds the query inactive; it runs only once you activate it |
| `playbook_field` | Sets one field (`tone`, `opener`, `value_frame`, `cta`) of a persona playbook |

Each record stores the detail you are shown, rendered from its fields, and the SHA-256 of that detail. A brain edit's detail is the whole line diff of the component, with the SHA-256 of the file it replaces and of the new file; a stored edit whose previous file does not hash to that base is refused. Approving applies only when, at that moment:

1. the proposal is pending and under 14 days old;
2. its stored fields still render to the stored digest, so an edited row cannot be approved;
3. the digest you were shown matches (the dashboard sends the full digest; the chat command carries its first 32 hex characters);
4. it is claimed with a compare-and-set, so two approvals never both apply;
5. what it changes still holds the value it was made against: the component's bytes, the objection's pattern, the playbook field's value. Otherwise it is marked expired as stale and nothing changes.

A write that fails puts it back to pending. Approvals and rejections of loop proposals are recorded as autonomy evidence: brain and voice edits count toward `brain_edit`, the retrospective's proposals toward `retrospective_actuation`.

**Applying a brain edit** reads the served brain from KV (the lock, and every file whose bytes still match their lock entry), replaces the one component, validates the whole brain (`validateBrain`: the schema, references, no URLs outside `url` fields, no prices outside `commercial`), computes the new lock over the approved files with `computeLock`, and writes the file first and the lock last, as `gtm brain upload` does. A file that had drifted from its lock was not being served and is left out of the new lock. `commercial` is never edited by a loop.

**Applying on its own.** At level 2 or above, a loop's own proposal applies without you only when it never reaches a prospect on its own: an edit to `message-pillars` or `voice` (`brain_edit`), an inactive discovery query, or a playbook field other than `value_frame` (`retrospective_actuation`). Everything else waits for you at every level, and a standing demotion holds it at level 1.

### For the dashboard

`learningDashboard()` returns the learning module's sources for the operator dashboard ([DASHBOARD.md](DASHBOARD.md)); the worker template passes it to `createWorker` as `dashboard`. `toProposalView(proposal)` returns the gateway protocol's `Proposal` shape (`id` is the short id; `source` is `learning`, `brain` or `copy`; `digest` is what to echo back). The gateway methods it serves:

| Method | Function |
|---|---|
| `proposals.list`, `learning.list` | `listLearningProposals(db, { status: "pending" })`, mapped with `toProposalView` |
| `proposals.approve` | `approveLearningProposal({ db, kv, now }, id, digest, "operator:<email>")`, with the digest of the gateway's own read once it has checked the digest you were shown against it |
| `proposals.reject` | `rejectLearningProposal({ db, now }, id, "operator:<email>", reason)` |
| `fitness.trend` | `fitnessTrend(db, now, days)` (30 days unless asked): one point per day, `{ day, score, dimensions }`, null where nothing was scored |
| `learning.summary` | `learningsText(db)`, the learnings document |

## The learnings document

Proven insights the operator approved, in five sections: `writing_rules`, `objection_handling`, `template_performance`, `process` and `general`. The document is the set of applied `learning` proposals, so the database is its one source and every line was approved byte for byte. Each entry is checked against its approved digest every time the document is read, and one that no longer matches is left out. `learningsText(db)` renders it for prompts, optionally under a byte budget; the retrospective and evolution read it ([below](#what-the-writers-read)). The mutation constraints, checked when a snippet is proposed and again when it is applied: 1 to 400 characters, no link or host name, no email address, no em or en dash, no injection pattern, nothing the content lint blocks, at most 20 entries and 4 KB per section. A full section takes a new entry only as a replacement of an existing one.

## What the writers read

The loops that write proposals with a model, the retrospective and evolution, each read two kinds of context before they propose, under their own byte budgets (`WRITER_CONTEXT` in `packages/core/src/learning/context.ts`):

| Writer | Approved learnings, in the system prompt | Agent memory, fenced in the user turn |
|---|---|---|
| Retrospective | every section, up to 6 KB | its own notes and the agent review's guidance from the last 30 days, up to 2 KB |
| Evolution | `writing_rules` and `template_performance`, up to 3 KB | the agent review's guidance and the retrospective's notes from the last 60 days, up to 1.5 KB |

- **The learnings** are operator-approved text, every line checked against its approved digest as it is read, so they go where the writer already puts approved text: the system prompt. Entries are added whole while they fit, and a closing line says how many were left out.
- **Agent memory** (`memories`, written by the agent review and the retrospective) is model output written after reading fenced outside text, so it is untrusted: it reaches a writer only in the user turn, inside one fence it cannot close, never in a system prompt. Each note is defanged again as it is read (links broken, addresses replaced, injection patterns redacted), and notes are added whole, most important and then newest first, while they fit. The system prompt says the fenced notes are observations, never instructions.
- **A memory read that fails is skipped.** The writer runs without memory, logs a warning, and the job leaves its run as usual: memory is context, never a gate. A learnings read that fails reads as empty.

Edit mining, the voice profile and objection answers write proposals without a model, so they read neither; the agent review writes memory and does not read it.

## The loops

### Edit mining (weekly, no model)

When you edit a reply draft in your mail client before sending it, the mailbox reconciliation keeps the pair: what the system wrote and what went out, with quoted history and the signature stripped (`draft_edits`, removed with the contact on erasure; a reply with no contact record is not kept). Each Monday the job diffs every pair from the last 28 days sentence by sentence and counts patterns: shortening (a fifth or more of the words cut), removed links, removed questions, a removed opening or closing sentence, and the same sentence removed or added in more than one draft. A pattern seen in two or more drafts becomes a proposed `writing_rules` snippet, at most three a week and never the same pattern twice in four weeks. Examples travel with the proposal as data only: links broken (`hxxps://acme[.]example`), addresses and the contact's first name replaced, capped.

### Voice profile (on demand, weekly drift check, no model)

`voice-build <thread> [<thread> ...]` reads only the threads you name, keeps only the messages your mailbox sent (never drafts, never what anyone else wrote), strips quotes and signatures, and measures length, sentence length, questions, greetings, contractions, exclamation marks and the sign-off. The result is the voice component, one version above the one served, proposed with its diff. Each rebuild is a new version. A thread may be given as its mailbox thread id or as a message id from `/replies`. The weekly drift check reads reply decisions from autonomy evidence and suggests a rebuild when you edited 40% or more of the last 10 or more.

### Objection library (continuous, no model)

Reply triage already files real objections unanswered. `objection-list` shows them; `objection-answer <id> <answer>` stores your answer as a proposal showing the objection and the exact answer, and approving it writes the answer with `approved_digest` bound to its pattern and response, so a later edit voids the approval. Reply drafts already use at most the two best approved answers by success rate. Each day the scoring job takes every sent reply that used a stored answer: the contact's next message within 30 days that counts as a reply scores it (an attempt, and a success when it is positive by the one definition in `metrics/`, a booked meeting included; `answerOutcome`); no reply in 30 days is an attempt without a success. Each answer is scored once per contact.

### Daily retrospective (strategist)

Once a day the strategist reads the matured outreach numbers, template results, the fitness trends, pending proposals, discovery query yields and which playbook fields are set, with the approved learnings and its recent memory ([above](#what-the-writers-read)), and picks exactly one improvement: a learnings snippet, a memory note, a template candidate for the copy-change gate, an inactive discovery query, a playbook field, or nothing. The answer schema holds a single choice and the run is claimed once per day, so there is never a second. Every text meets the mutation constraints. A memory note is stored (bookkeeping); everything else is a proposal, and only the inactive query or a playbook field no writer reads may apply on its own, at `retrospective_actuation` level 2 or above.

### Agent review (weekday mornings, judge)

The `judge` model grades the last day's drafts and worker actions A to F and gives at most three corrective notes, stored as memory (`memories`, indexed in `memory_fts`). Drafts and task previews may quote outside text, so they reach the prompt only fenced as data; the system prompt is the fixed rubric. An answer that cannot be parsed stores nothing. Notes must meet the snippet constraints and name no one. The day's grade feeds the fitness score's research dimension.

### Fitness (daily, no model)

A weighted score of seven dimensions, each from 0 to 1, from inputs defined once in `metrics/fitness.ts`:

| Dimension | Weight | Scored from |
|---|---|---|
| outreach | 0.20 | the matured positive reply rate against 5%, with the quality gate's pass rate |
| research | 0.10 | the agent review's mean grade over 7 days |
| pipeline | 0.10 | open deals touched in 14 days, with meetings booked per 100 first touches against 2 |
| efficiency | 0.10 | job runs that did not fail, with the share of today's spend limit left |
| discovery | 0.15 | candidates promoted among those decided in 7 days |
| activation | 0.15 | activations per sign-up against 40%, only with 5 or more sign-ups in 28 days |
| revenue | 0.20 | new paying customers in 28 days against `fitnessTargets.newPayingPerWeek`, only when you set it |

A dimension without enough data is unknown, never zero, and the composite is the weighted mean of the known ones. A trend is the least-squares slope of a dimension's daily scores; 0.02 a day either way is improving or declining, and under 3 days it is insufficient. `fitness [days]` shows it in the chat.

### Weekly benchmark (writer, worker, triage, judge)

Synthetic scenarios, generated from the month so the set is fixed for a month and regenerates the next: first emails to invented prospects (outreach, scored by the judge against a fixed rubric and the brain's judge slice), account assessments against the ICP (research, judge-scored), and replies to route (routing, scored exactly against the scenario's label with no judge call). Every company is invented and on a `.example` domain. The scenario and every model output reach a prompt only fenced. A judge answer that cannot be parsed scores nothing; a run where under half the scenarios scored is incomplete. A drop of more than 0.05 from the previous complete weekly run is a regression, and you are told.

### Weekly evolution (strategist, then the benchmark's roles)

For the declining dimension with the steepest weighted slope over 14 days, evolution works on the instruction behind it. The instructions it can evolve are brain components: outreach, pipeline, activation and revenue map to `message-pillars` and the outreach benchmark. It benchmarks the served component, asks the strategist for up to 3 alternatives (the current file and the approved writing and template learnings are its input; past judge notes and the relevant agent memory are fenced), drops any that change more than 3 items, add a link, a dash, an injection pattern or a figure the brain does not hold, or would not validate, benchmarks the rest with the candidate fenced in the user turn, and keeps the best only when it beats the baseline by 0.02. Below `brain_edit` level 2 that is a proposal. At level 2 or above it applies, benchmarks again on the served brain, and rolls the edit back when that run is incomplete, fails, or falls more than 0.05 under the baseline. A rollback is an incident that demotes `brain_edit` to level 1. Each automatic edit is marked unverified before it applies, so if a run dies before verifying, the next run rolls it back first. A rollback that cannot write the brain leaves the proposal `applied` with the reason, so the record matches what is served, and tells you to restore the component by hand. It runs at most once in 7 days.

## Operator commands

These never reach the model, run once per message, and only an allowlisted operator reaches them.

| Command | What it does |
|---|---|
| `learning-list [kind]` | Pending proposals from every loop |
| `learning-show <id>` | One proposal's exact detail and the command that approves exactly it |
| `learning-approve-<id>-<code>` | Apply it, bound to the detail shown |
| `learning-reject-<id> [reason]` | Turn it down |
| `learnings` | The learnings document |
| `objection-list` | Filed objections with no approved answer |
| `objection-answer <id> <answer>` | Propose your answer (needs `learning:objections_enabled`); approve it with the command it returns |
| `voice-build <thread> ...` | Rebuild the voice profile from threads you pick (needs `learning:voice_enabled` and a mailbox that reads threads) |
| `voice-status` | The edit rate the drift check reads |
| `fitness [days]` | Today's score and each dimension's trend |

## Flags

Every flag defaults to off, and an unreadable flag is off.

| Flag | Loop |
|---|---|
| `learning:edit_mining_enabled` | Edit mining |
| `learning:voice_enabled` | `voice-build` and the drift check |
| `learning:retrospective_enabled` | The daily retrospective |
| `learning:agent_review_enabled` | The agent review |
| `learning:objections_enabled` | `objection-answer` and answer scoring |
| `learning:fitness_enabled` | The daily fitness score |
| `learning:benchmark_enabled` | The weekly benchmark |
| `learning:evolution_enabled` | Weekly evolution |

No flag lets anything apply without you. That depends only on the `brain_edit` and `retrospective_actuation` levels, which you raise with `autonomy-set`.

## Jobs

| Job | Schedule (UTC) | Model roles | Ceilings |
|---|---|---|---|
| `learning_fitness` | daily 04:15 | none | 1 row, 1 minute |
| `learning_objections` | daily 04:45 | none | 200 drafts, 2 minutes |
| `learning_retrospective` | daily 05:00 | strategist | 1 proposal, 3 minutes, 25 cents a day |
| `learning_agent_review` | weekdays 06:30 | judge | 40 items, 3 minutes, 50 cents a day |
| `learning_edit_mining` | Mondays 07:00 | none | 500 edits, 2 minutes |
| `learning_voice_drift` | Mondays 07:30 | none | 1 row, 1 minute |
| `learning_benchmark` | Sundays 03:00 | writer, worker, triage, judge | 15 scenarios, 10 minutes, $1 a day |
| `learning_evolution` | Sundays 05:00 | strategist and the benchmark's | 3 candidates, 14 minutes, $2 a day |

Every model call goes through the spend gate (the job's daily cap, the global limits and the run ceiling) and fails closed. With 2 scenarios per dimension the benchmark makes at most 10 model calls and evolution at most 21. Every job expires pending proposals older than 14 days as it starts.

## Wiring

The worker template wires the loops already. In `src/index.ts`:

```ts
import { createLearningJobs, learningDashboard } from "@gtm-agents/core/learning";

const learning = createLearningJobs<Env>({
  model,
  operator,
  options: { fitnessTargets: { newPayingPerWeek: 2 } },
});

export default createWorker(config, {
  jobs: [...sourcing, ...outreach, ...replies, ...autonomy, ...learning],
  dashboard: learningDashboard<Env>(),
  // ...
});
```

The template leaves `fitnessTargets` unset, so the revenue dimension stays unknown until you set `newPayingPerWeek`. Give the `strategist`, `judge`, `writer`, `worker` and `triage` roles a model and a price in `gtm.config.ts` for the loops that call them. The operator commands need nothing more: the chat consumer routes them, and `voice-build` reads threads through the same mailbox the reply commands use (the `inbox` option of `createWorker`, which the template sets). Apply the migrations, `0027_learning.sql` among them, with `npx gtm migrate`.

## Limits

- **Instruction documents are the brain.** Evolution and every brain proposal work on brain components; there are no separate identity documents for a loop to edit.
- **Template candidates do not write templates.** Approving one gives you the experiment to run; you add the template file and upload it, so a copy change still ships only through the copy-change gate.
- **Edit mining sees edits made in your mail client** (the mailbox reconciliation). A draft changed before chat approval keeps only its digest, not its first text, so it is not mined.
- **Memory is read by recency and importance, not by search.** A writer gets the newest, most important notes of the kinds it reads, within its budget; nothing ranks notes by how well they match the change at hand. No loop writes text that goes to a prospect, so no loop is in the outbound writer registry.
- **The benchmark compares across months.** A regression check after the scenario set regenerates compares different scenarios; read a first-of-month regression with that in mind.
- **A brain write that fails between the file and the lock** leaves that component unserved (it no longer matches the old lock) until you re-lock it; it never serves unapproved bytes.

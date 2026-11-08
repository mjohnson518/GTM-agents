# Sequences: follow-ups to the cold first touch

This page is for deployers turning on the cold sequence's follow-up steps, and for contributors changing how they are checked, threaded or released. It covers the steps and their timing, the templates follow-ups are written from, everything that stops, ends or pauses a sequence, threading under the first email, approval and the release command, the manual channel step, stale sequences, and the flags, jobs and limits involved. The first touch itself is the cold batch's job ([OUTREACH.md](OUTREACH.md)); delivery (send windows, caps, the kill switch, unsubscribe) is the send function's ([SENDING.md](SENDING.md)). The code lives in `packages/core/src/sequences/`, published as `@gtm-agents/core/sequences`.

## What it does

```
first touch sent (cold batch) -> campaign row at step 1, next step due after its delay
                                      |
follow-up sweep, several times each weekday:
  due rows -> reply check over the whole account -> account rules -> contact rules
           -> send ledger (reconcile, exhausted?) -> existing draft for the step
           -> manual channel step (optional) -> threading (Message-IDs)
           -> template for the step -> quality gate -> model reviewer (one per template)
           -> drafts + manifest + release command, or auto-approve -> send function (path "sequence")
```

A sequence is the first email and the steps after it, all in one conversation. Every step after the first is a reply under the first email, with the first email's subject, and it goes out only after the sweep has checked, right before it leaves, that nobody at the account has written in. No model writes a follow-up: copy is your approved template for that step with variables filled in from your own records. Nothing runs until you turn it on.

## Turning it on

1. **Templates.** Write one approved template per follow-up step in `templates/` ([BRAIN-SCHEMA.md](BRAIN-SCHEMA.md#templates)), with `kind` and `step` matching your configured steps (by default `follow_up` with `step: 2` and `breakup` with `step: 3`), validate them with `npx gtm brain validate` and upload and lock them as for the cold batch. `examples/brains/acme/templates/` has a complete three-step sequence.
2. **The cold batch.** Follow-ups start from first touches the cold batch sent ([OUTREACH.md](OUTREACH.md)). Each sent first touch leaves its campaign row at step 1 with the next step due after `sequences.cold.steps[1].delayDays`.
3. **Register the jobs** in `apps/worker/src/index.ts`, with the same email provider the delivery jobs use:

   ```ts
   import { createWorker, type Env } from "@gtm-agents/core";
   import { createAdapterContext } from "@gtm-agents/core/adapters";
   import { createSequenceJobs } from "@gtm-agents/core/sequences";
   import { createAdapter as resend } from "@gtm-agents/adapters/email-resend";
   import { createAdapter as anthropic } from "@gtm-agents/adapters/llm-gateway";
   import { createAdapter as telegram } from "@gtm-agents/adapters/operator-telegram";
   import config from "../gtm.config.ts";

   const context = (name: string, env: Env) => createAdapterContext({ name, env: { ...env }, config });
   const email = (env: Env) => resend(context("email-resend", env));
   const operator = (env: Env) => telegram(context("operator-telegram", env));

   const sequences = createSequenceJobs<Env>({
     email,
     operator,
     model: (env) => anthropic(context("llm-gateway", env)),
   });

   export default createWorker(config, { jobs: [...sequences /* , delivery and outreach jobs */], email, operator });
   ```

   The release command sends through the `email` provider you give `createWorker`; without it, a sequence release is refused.
4. **The inbox.** The reply check can only see replies the inbox has recorded, so every step is held until intake is running: set up a mailbox ([INBOX.md](INBOX.md)) and turn `inbox:enabled` on. With Gmail (poll intake, the default) a step goes out only when the latest inbox poll completed in the last 10 minutes, so a broken token, a halt or a stopped poll holds follow-ups instead of letting them go to people whose replies were never recorded. With Cloudflare Email Routing only, where mail is recorded the moment it arrives, set `sequences:reply_intake` to `routed`.
5. **The operator chat** carries the release, resume and manual-touch commands, so it needs the operator channel set up and `operator:agent_enabled` on ([OPERATOR.md](OPERATOR.md)).
6. **Turn sequences on:** set `sequences:enabled` to `true` in KV. Delivery must be on (`delivery:enabled`) for anything to leave.

## Steps and timing

The steps come from `sequences.cold` in `gtm.config.ts`:

```ts
sequences: {
  cold: {
    steps: [
      { step: 1, kind: "cold_intro", delayDays: 0 },   // the cold batch's first touch
      { step: 2, kind: "follow_up", delayDays: 3 },    // 3 days after step 1
      { step: 3, kind: "breakup", delayDays: 7 },      // 7 days after step 2
    ],
  },
},
```

Steps are numbered 1, 2, 3 in order (up to 5), and each `delayDays` counts from the step before it. That is the default above; leave it out to use it.

A sequence lives on its `campaign_contacts` row: `sequence_step` (the last step that went out), `sequence_active`, `next_send_at`, `sequence_paused_at` and `sequence_pause_reason`. The send ledger (`outreach_sends`) is the truth about which steps went out and when: when a write after a send was lost, the sweep moves the row on from the ledger instead of sending the step again, and a row the ledger says is not due yet is moved to when it is.

## Templates for follow-ups

The templates for a step are your approved, served templates whose `kind` and `step` match the configured step, with a `volume_weight` above 0. Among those a contact may be offered (targeting by `segments`, `personas` and `team_sizes`, exactly as for the cold batch), templates written for the first email's `angle` come first, then templates for every angle (`angle: none`). Several templates for one step split by `volume_weight`.

Variables are the cold batch's ([OUTREACH.md](OUTREACH.md#templates-and-variables)), plus `{{original_subject}}`, the first email's subject. The subject a follow-up goes out with is always `Re: ` and the first email's subject, whatever the template's subject line says, so it threads in clients that group by subject; write `subject: Re: {{original_subject}}` in follow-up templates to say so.

**The fixture check.** Before any contact sees a template, the sweep renders it for an invented contact and runs it through the deterministic quality gate. It must pass with no finding at all: a finding there is the template's, not a contact's. A template that uses a variable follow-ups have no source for (`{{angle_opener}}`, `{{angle_age}}`, `{{proven_insight}}`, `{{company_context}}`) fails it. A step with no template, or with a template that fails, holds every row due for that step: the rows stay due, nothing ends, and you are told once a day which template and why.

**Skip rather than guess.** A contact whose own values leave a variable empty is never greeted with a fallback: that draft fails the gate (`MISSING_VARIABLE`) and the contact's sequence pauses. A contact no template may be offered to stays due, and is named in the daily template notice.

## What stops, ends or pauses a sequence

Before every step, in the sweep and again in the release command, in this order:

| Check | Result |
|---|---|
| **The reply check.** Inbound mail in the last 30 days from the contact (by contact or by address), or from anyone at the same account (any contact at the account, or any sender whose domain is the account's domain or a subdomain of it), classified as a reply, an inquiry or an unsubscribe, **or not classified yet** | Stops every sequence at the account (status `replied`) |
| Someone at the account is in a conversation: warming or warmer, a deal past contacted, a reply or inquiry in the last 90 days, or a decline in the last 90 days | Ends the sequence |
| Someone at the account opted out or complained | Ends the sequence |
| The address is suppressed, or the contact was erased | Ends the sequence |
| Person fit is no longer `keep`, the account or title is on the brain's never list, the contact moved jobs, their warmth is past contacted, they opted out, or the address is known to be undeliverable | Ends the sequence |
| The contact has no account (so the account rules cannot be applied) | Pauses the sequence |

Right before the send function is called, the reply check and the row's state (still active, not paused, still waiting for this step) are read once more, because the checks, the Message-ID lookups and the model review take time: a step whose account wrote in meanwhile is withheld, and if either read fails nothing is sent.

Out-of-office replies, auto-replies, bounces and spam do not stop a sequence. (Reply detection may hold a sequence until someone is back; see `holdSequences`.) Reply detection and triage also stop sequences as mail arrives; the sweep's own check is the gate that holds even if those writes fail.

**Fails closed.** The reply check, the account rules and the suppression list are gates. If any of them cannot be read, nothing is drafted, released or sent for any row, the rows stay due, and you are told once that day. The brain must be readable whole, so its never list always applies.

Then, per row:

- **Exhausted.** A row whose next step is beyond the last configured step is finished (inactive, reason `exhausted`). After the last step goes out the row finishes the same way.
- **The first email is missing** from the send ledger: a follow-up cannot thread under it, so the sequence pauses.
- **The step's draft was rejected:** the sequence pauses until you resume it, and the step is drafted afresh then.
- **A draft fails the quality gate** for this contact: the sequence pauses, and the finding codes are recorded in `quality_checks` (subject type `followup`).
- **A send that fails for this contact** (the content lint, an approval mismatch, a provider refusal, or an outcome that leaves it unclear whether the provider accepted it) pauses the sequence. A refusal because the address is suppressed or undeliverable ends it.

You get one message per sweep naming the contacts it paused, each with its resume command. A row held by threading, a template or the reviewer is looked at again 3 hours later, so held rows never crowd newer due rows out of the sweep's row ceiling.

## Threading

Every follow-up sets `In-Reply-To` to the Message-ID of the latest earlier step and `References` to the Message-IDs of every earlier step in order (the first email's, then step 2's for step 3), with the subject `Re: <first email's subject>`, so every client shows the sequence as one conversation.

A Message-ID here is the RFC 5322 id the provider actually sent the email with. Some providers, Resend among them, replace a Message-ID set by the sender, so the sweep asks the provider for the real one (`EmailProvider.getMessageId`, a `GET /emails/{id}` for Resend) the first time a later step needs it, and stores it on the send ledger (`outreach_sends.message_id`), so each is fetched once. At most 50 lookups run per sweep.

**A step is never sent unthreaded.** If any earlier step's Message-ID cannot be found (the lookup fails, the provider does not know it yet, the email went through another provider, or the provider has no lookup), the step is held and stays due for the next sweep. When the provider cannot look Message-IDs up at all, you are told once a day.

## Approval and release

Follow-ups follow the cold batch's autonomy, read the same way ([OUTREACH.md](OUTREACH.md#auto-approve)):

- **At the default level** (`autonomy:cold_batch` at 1 and `cold_batch:auto_approve` off), the sweep stores each due step that passed every check as a draft (`follow_up` or `breakup`, status `pending_approval`), puts all of them in one approval manifest, and sends you one message with the first, middle and last drafts and the command:

  ```
  sequence-release-sq202611041630ab12-1a2b3c
  ```

  It is named so it cannot be confused with `batch-release`, and neither command releases the other's manifest. A step waiting in a manifest is not put up again while that manifest can still be released.
- **With `cold_batch:auto_approve` on, or the `cold_batch` class at level 2 or above,** drafts that pass the gate and the model review are approved bound to their digest (`approved_by` `auto:flag` or `auto:autonomy_level`) and sent, with an `auto_sent` autonomy event. **The reviewer must be on** (`quality:model_review_enabled`): with it off, follow-ups are put up for your release even at a higher level.

Send the release command back in the operator chat (a leading `/` is accepted). It never reaches the model. In order:

1. `sequences:enabled` must be on, and the inbox must be recording (step 4 of [Turning it on](#turning-it-on)).
2. The manifest must exist, be a follow-up manifest, and its code must match. The code confirms you mean this set; it is not a secret, which is why every step is checked again.
3. The manifest must be at most 72 hours old. An older one is refused whole, and the next sweep puts the steps still due up again with a new command.
4. Every draft: still open, its recipient still the contact's address, and its current content must hash to the digest the manifest recorded, so a draft edited after the message was sent is refused, whoever edited it. Its sequence must still be active, not paused, and waiting for exactly this step, which the send ledger confirms has not gone out. Then every check in [What stops a sequence](#what-stops-ends-or-pauses-a-sequence) runs again, the reply check included.
5. The drafts that pass are approved with that digest. A step that is due and can be threaded is handed to the send function with `approvedDigest` set, and the send function verifies the digest again. A step not due yet (for example, held until someone is back from leave) or not threadable yet stays approved, and the sweep sends it once it is, after running every check again. Editing an approved draft returns it to review.

The reply names what was sent, what is waiting and what was refused, and why. Sending the same command twice sends nothing twice. The first release of each manifest writes an `approved_unchanged` autonomy event.

## Sending

Each step goes through the send function ([SENDING.md](SENDING.md)) on path `sequence`, with every boundary check it runs: delivery on, the halt and the cold kill switch, suppression, the content lint, the verification policy (an address known to be undeliverable is refused), the approved digest, the recipient's send window, the per-domain daily cap and the per-account weekly cap (which counts cold and sequence mail together), and the circuit breaker.

- **One key per step.** Each step's idempotency key is `seq:<campaign id>:<contact id>:<step>`. The send function claims it in the effects ledger right before sending, so a step is never sent twice, whoever retries; a step whose key is already claimed is treated as sent. It is also the draft's unique key, so a step never has two drafts.
- **A step that must wait stays on its row.** A step deferred by a send window, a cap, the kill switch or the breaker is due again at the time the send function names, on its campaign row, and is never written to the deferred queue: the deferred replay re-checks only the contact, and a colleague's reply must stop the step too. Its approved draft waits and is sent by a later sweep, after every check runs again: a draft you released, at any level; a draft approved automatically, only while automatic approval still applies. If you lowered the level or switched auto-approve or the reviewer off in the meantime, it returns to review and is put up for your release.
- A send that fails retryably (delivery off, a missing secret, a state that could not be read) leaves the step due for the next sweep.

## The manual channel step

Behind `followup:manual_channel_enabled`, off by default. Before the last step, the sweep drafts a short fixed note (at most 300 characters: the contact's first name, the first email's subject and your agent's name) and asks you to send it by hand on LinkedIn or X:

```
channel-done-mt1a2b3c4d5e      sent on LinkedIn
channel-done-mt1a2b3c4d5e x    sent on X
channel-skip-mt1a2b3c4d5e      not sending it
```

The last email waits until you mark it, or 5 days. Nothing is posted anywhere automatically. A done touch is recorded in the contact's history (`outreach_log`, channel `linkedin` or `x`, provider `manual`), never in the email send ledger, so it never counts as an email in a metric, a cap or a bounce rate. At most 10 touches are asked for per UTC day; past that, the last step goes without one. The manual step is an optional extra touch, not a safety check: if the touches cannot be read or written, the last step goes as it would with the flag off, and every gate still runs first.

## Pauses and resuming

A paused sequence keeps its place: it stays active but is skipped until you resume it.

```
sequence-resume-ct_1a2b3c4d5e6f
```

Resuming clears the pause and makes the next step due now; every check runs again before it goes. A sequence that ended or stopped is never resumed.

## Stale sequences

The `sequence_stale_check` job runs on Saturday mornings and tells you, once per row and state, about sequences that are paused or have been due for more than 3 days without their step going out (a template problem, a reviewer outage, a Message-ID that cannot be found, a step waiting for your release). Paused ones come with their resume command. It changes nothing and calls no model.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `sequences:enabled` | `false` | The follow-up sweep, the stale check and the `sequence-release` command |
| `sequences:reply_intake` | `poll` | How the reply check knows it is not blind: `poll` needs `inbox:enabled` and an inbox poll completed in the last 10 minutes; `routed` (Cloudflare Email Routing only) needs `inbox:enabled` alone. Anything else holds every step |
| `followup:manual_channel_enabled` | `false` | The manual channel step before the last step |
| `cold_batch:auto_approve` | `false` | Shared with the cold batch: approve passing, reviewed follow-ups without a release |
| `autonomy:cold_batch` | `1` | Shared with the cold batch: at 2 or above, passing, reviewed follow-ups are approved |
| `quality:model_review_enabled` | `false` | The model reviewer; required for anything to go without a release |
| `delivery:enabled` | `false` | The send function's master switch ([SENDING.md](SENDING.md)) |
| `delivery:account_weekly_cap` | `3` | Cold and sequence messages per account in any 7 days |

Reads fail in the direction that sends less: an unreadable switch is off, an unreadable level is 1.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `sequence_sweep` | 08:30, 12:30, 16:30 and 20:30, Monday to Friday | `sequences:enabled` | 4 minutes, 200 rows, 25 cents a day for the reviewer |
| `sequence_stale_check` | 10:00 on Saturdays | `sequences:enabled` | 30 seconds, 500 rows |

Change them with `createSequenceJobs({ ..., options: { sweepSchedule, staleSchedule, sweepMaxRows, maxDurationMs, reviewMaxSpendCents, reviewTimeoutMs, messageIdLookups, manualTouchesPerDay } })`. A sweep schedule that fires more often than every 15 minutes is refused, because the sweep calls a model (one review per template per sweep, judge role, checked against the budget first and recorded in `cost_events`). The sweep is critical (cron health watches it) and safe to rerun: every step is keyed, so a rerun never sends a step twice. Pass `templates: (env) => files` to serve templates bundled with the Worker instead of from KV.

## Operator commands

| Command | What it does |
|---|---|
| `sequence-release-<id>-<code>` | Send the follow-ups a sweep put up for release |
| `sequence-resume-<contact id>` | Resume a contact's paused sequence |
| `channel-done-<id> [linkedin\|x]` | Record a manual touch sent by hand; the last step goes on the next sweep |
| `channel-skip-<id>` | Skip the manual touch; the last step goes on the next sweep |

None of them reaches the model. Each runs once per chat message, however often the message is delivered.

## Limits

- **Template copy only.** Follow-ups are your templates with variables filled in; nothing writes copy per contact.
- **One review per template.** The reviewer reads one rendered draft per template per sweep, and a failing template holds its whole step; per-contact differences are covered by the deterministic gate.
- **Message-IDs come from the provider.** A provider without a Message-ID lookup cannot thread follow-ups, so they wait. Store the Message-ID on the ledger by other means (for example from a delivery webhook that carries it) and no lookup is needed.
- **A follow-up template that uses `{{attributes.<key>}}`** holds every draft for a person (`PER_DRAFT_REVIEW`), so such a step pauses each contact. Keep follow-up templates to contact fields and copy lines.
- **Multithreading to a colleague after silence, re-engagement on a new signal, signal response, referrals and lifecycle follow-ups** are separate and not part of the cold sequence.

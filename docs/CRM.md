# CRM mirror

This page is for deployers who want their team's CRM to show the people the system works with and what happened with them, and for contributors adding a CRM adapter. The mirror copies contacts, their companies and short summaries of our own activity into a CRM through the `CrmSink` port ([INTERFACES.md](INTERFACES.md#crmsink-optional)). The template wires Attio (`crm-attio`).

The mirror is one way. This deployment's database stays the truth: nothing is read back from the CRM, and an edit made in the CRM never changes what the system does.

## Turn it on

1. Create an Attio access token with the scopes `record_permission:read-write`, `object_configuration:read` and `note:read-write`, and store it:

   ```bash
   npx wrangler secret put ATTIO_API_KEY
   ```

2. In `gtm.config.ts`, set `adapters["crm-attio"].enabled` to `true`. `gtm doctor` then asks for the secret.
3. Apply the migration and turn on the flag:

   ```bash
   npx gtm migrate                                  # migration 0037: crm_sync_state, crm_links and crm_erasures
   npx gtm flags set crm:mirror_enabled true
   ```

The `crm_mirror` job runs every 15 minutes. Its first runs work through everything the database already holds, `crm:mirror_per_run` rows at a time (default 100, at most 500), oldest first; after that each run picks up what changed. It makes no model call and spends nothing.

Every flag defaults off and reads fail closed: a flag that cannot be read is off, and a `crm:mirror_per_run` that cannot be read or is not a whole number is 0. `system:halt` stops the job like every other.

## What is mirrored

| In the CRM | From | When |
|---|---|---|
| A company record, matched on its domain: the account's name and domain | `accounts` | Before its first contact is written. A later change to the account's name or domain goes out the next time one of its contacts changes |
| A person record, matched on their address: first and last name, job title, and their company | `contacts` | Every contact, as soon as it exists (a promoted candidate, or a person who wrote in), and again when one of those fields changes |
| A note "Cold email sent: <our subject>", "Follow-up 2 sent: <our subject>", "Email sent: <our subject>" or "Reply sent" | `outreach_sends` | Each email we send |
| A note "Reply received: interested" (or question, referral, warm, objection, not a fit, unclear) | `inbound_emails`, by its triaged intent only | Each reply from a contact, once triage has given it an intent. Auto-replies, spam, noise and opt-outs are not mirrored as replies |
| A note "Meeting booked for 2026-11-20 15:00 UTC", and "Meeting held on 2026-11-20" | `calendar_meetings` | A meeting booked or moved, and a meeting marked held |
| A note "Deal moved to proposal" | `deal_stage_history` | Each deal stage change for a deal with a contact |
| A note "Opted out of email on 2026-11-20" | warmth `opted_out`, or a suppression entry for an opt-out, complaint or do-not-contact | Once, for a person already in the CRM |

Each note is dated when the activity happened. A person's warmth, attributes, research, scores and notes are not sent.

## What never leaves

- **No inbound text.** The mirror never reads a reply's body, preview, subject, sender name, headers or triage notes. A reply appears only as its intent, from a fixed list. A reply we sent is summarized without its subject, because a reply's subject can repeat the one the sender wrote.
- **Only our own words.** Every summary is a fixed sentence filled from enumerated values (an intent, a deal stage, a time) or from a subject line we wrote and sent. Deal notes and stage reasons are not sent.
- **Nobody who opted out.** A contact that is suppressed for any reason, or opted out, gets nothing more: no update and no activity. If they were already in the CRM and the reason is an opt-out, a complaint or do-not-contact, one note says they opted out of email. A bounce or a manual block stops the mirror for them without a note. A contact suppressed before the mirror reached them is never written at all.
- **Nobody who was erased.** Erasing a person deletes their contact row, so the mirror has nothing of theirs to write. See below.

## Erasure

Deleting data is a permanently human-only action, so the mirror never deletes anything in the CRM. When a person who was mirrored is erased here, the same erasure deletes their link to the CRM record and leaves a notice for the operator, delivered by the `operator_outbox` job (the template registers it):

> A person mirrored to the CRM (crm-attio) was erased here. Their CRM record <record id> still holds their data: delete it in the CRM yourself. The mirror will not write to it again.

The notice names the CRM's record id, never the person's address. Delete the record in Attio by that id. The id is also kept in `crm_erasures` (sink, record id, when), so it is not lost if the notice cannot be delivered:

```bash
npx wrangler d1 execute <database> --remote --command "SELECT sink, external_id, erased_at FROM crm_erasures ORDER BY erased_at DESC"
```

A person erased while the mirror is writing their record is caught the same way: the mirror records the link only while the contact still exists, and otherwise puts the record in `crm_erasures` with the same notice. Activity recorded about the person before the erasure is never mirrored afterwards.

## How a run works

The job reads five streams in order (contacts, sends, replies, meetings, deal stage changes), each after its own cursor in `crm_sync_state`, and leaves rows changed in the last 15 minutes for a later run: some jobs stamp a row with the time they started and write it minutes later, so the wait is longer than any job may run, and such a row is never passed by the cursor. The contacts stream uses at most half of a run's rows, so a burst of contact changes never holds up the activity. For each row it first makes sure the contact and its company are in the CRM, writing them only when the fields it would write have changed since the last write (`crm_links` keeps a digest), then writes the note.

- **Each note is written once.** A note is claimed in the effects ledger (`runOnce`, keyed by sink, stream and row) before it is written. A rerun, or a cursor that was lost, writes nothing twice. Attio notes have no idempotency key, so a write that times out after Attio stored it can, rarely, leave one duplicate note.
- **A failure stops the run.** A CRM error (a bad token, a rate limit after one retry, an outage) stops the run with every cursor where its last finished row put it, and the run is recorded as failed with the reason. The next run picks up from there. Nothing upstream waits on the mirror: a CRM outage never holds a send, a reply or a sourcing run.
- **A suppression list that cannot be read stops the run** rather than write about someone who may have opted out.

## Attio specifics

- People are matched on `email_addresses` and companies on `domains`, with Attio's upsert (`PUT .../records?matching_attribute=...`). Attio keeps the values a record already holds in the attribute it matches on, so addresses or domains a teammate added stay. Name, job title and company are written as this deployment holds them, so an edit to those in Attio is replaced the next time the contact changes here.
- A person's company is a reference to the company record the mirror wrote.
- Notes are plain text on the person, with `created_at` set to when the activity happened.
- Attio allows 25 writes a second. The adapter retries a `429` once after its `Retry-After` (at most ten seconds), then fails the run.

## Limits

| Limit | Default | Change it with |
|---|---|---|
| Rows per run, across the streams | 100 (at most 500) | `crm:mirror_per_run`; unreadable means 0 |
| Run schedule | every 15 minutes | `createCrmJobs({ schedule })` in `src/index.ts` |
| Run time | 5 minutes | Fixed |
| Rows left for a later run | changed in the last 15 minutes | Fixed (`CRM_SETTLE_MS`, one minute more than the longest a job may run) |
| Rows for the contacts stream | half of the run's rows | Fixed |
| Spend | none | The job makes no paid call |

## Adding another CRM

Write an adapter that implements `CrmSink` ([packages/adapters](../packages/adapters/README.md)): upsert a company matched on its domain, upsert a person matched on their address (with the company's record id when given), and write an activity as a note on the person. Keep the adapter a translator: what is mirrored, when, and for whom is decided in `packages/core/src/crm/`. Wire it in `src/index.ts` with `createCrmJobs({ sink: (env) => createYourCrm(context(env, "crm-yours")) })`. The sink's `name` keys its cursors and links, so two sinks never share them.

## When something is wrong

| Symptom | Likely cause |
|---|---|
| The run summary says "flag off" | `crm:mirror_enabled` is off |
| "no CRM sink is configured" | `adapters["crm-attio"].enabled` is false in `gtm.config.ts` |
| "crm:mirror_per_run is 0 or unreadable" | The flag is set to something that is not a whole number |
| The run fails with "needs the secret ATTIO_API_KEY" | Put the secret with `wrangler secret put` |
| The run fails with "HTTP 401" or "HTTP 403" | The token is wrong or lacks a scope listed above |
| The run fails with "HTTP 422" | The workspace's people or companies object lacks a standard attribute the adapter writes (`email_addresses`, `name`, `job_title`, `company`, `domains`) |
| A contact never appears | It is suppressed or opted out, or it changed in the last 15 minutes |

# Meeting notes

This page is for deployers who record their sales calls with a meeting-notes tool and want what prospects say on those calls (their pain, their objections, the next steps you agreed) to reach the system. It is also for contributors adding another notes tool. The template wires Fathom (`notes-fathom`) and Granola (`notes-granola`) through the `MeetingNotesProvider` port ([INTERFACES.md](INTERFACES.md#meetingnotesprovider-optional)).

Everything a call produces is the prospect's own words, found word for word in the transcript. No model writes text that is stored, shown to you or sent.

## Turn it on

1. Create an API key in your notes tool and store it:

   ```bash
   npx wrangler secret put FATHOM_API_KEY    # Fathom: Settings, API Access
   npx wrangler secret put GRANOLA_API_KEY   # Granola: needs a Business or Enterprise plan
   ```

2. In `gtm.config.ts`, set `adapters["notes-fathom"].enabled` (or `notes-granola`) to `true`. `gtm doctor` then asks for its key.
3. Make sure the `worker` role has a model and a price in `models`, and that the Worker has its `BUCKET` binding (the template does).
4. Apply the migration and turn on the flag:

   ```bash
   npx gtm migrate                                     # migration 0038
   npx gtm flags set convert:notes_enabled true
   npx gtm flags set convert:notes_in_recap true       # optional: next steps in recap drafts
   ```

Both flags default off and read fail closed: a flag that cannot be read is off. Turning `convert:notes_enabled` off stops reading and extracting; calls already processed stay in your briefs and the digest, and transcripts are still deleted on schedule.

## Which recordings are read

A key sees what its owner can see. With Fathom, that is the owner's recordings and the meetings shared with them or their team. With Granola, a personal key sees the notes its owner owns or that are shared with them, and only notes with an AI summary. Granola marks only the note's owner as internal, so a teammate on the call counts as an outside invitee (matching still needs a known contact) and their speech is read as the other side's.

The `meeting_notes_ingest` job runs hourly and reads at most 20 new recordings per tool. A recording is kept only when it belongs to a known contact:

- **Match.** Each invitee the tool does not mark as internal is looked up by address, and by mailbox (a `+tag` variant is the same person), against your contacts.
  - Contacts who are suppressed, erased or opted out are set aside.
  - If one contact is left, that's the match.
  - If several are left, the match is the one calendar sync attributed a meeting to that started within 30 minutes of the recording. Otherwise nobody matches.
- **Skip.** A recording that matches nobody is skipped, with a reason (`no_contact`, `ambiguous` or `suppressed`), and its transcript is never fetched. Internal meetings and calls with strangers are never read. A recording with no usable start time (`invalid`), or whose transcript the tool says is gone (`no_transcript`), is skipped too, so it never holds up the ones after it.
- **Keep.** A matched recording gets one `meetings` row with the contact, their deal, the time and the title, and then its transcript goes to blob storage (`transcripts/<meeting id>.json`, at most 200 KB, speech and who said it as us, them or unknown; no speaker names). If the transcript cannot be stored, the row is removed again and the recording is tried later, so a transcript is never left where erasure and retention cannot find it. The tool's own summary is not kept.
- **Seen once.** `meeting_recordings` records each recording seen, matched or skipped, so none is read twice. A recording whose transcript is not ready yet is looked at again on the next run.

The first run looks back 7 days; later runs start from the last run that read every page to its end, less a day of overlap.

## What is extracted

The `meeting_notes_extract` job runs hourly. It reads up to 5 stored transcripts a run, with one call on the `worker` model role each, within 100 cents a day (`budget:job:meeting_notes_extract:daily_cents` can lower it).

- **Input.** The transcript reaches the model fenced as untrusted data, with injection patterns redacted, each line marked as the prospect's side, yours, or unknown. The system prompt is a fixed rubric and the names in your brain's approved `competitors` component. No tool is offered.
- **What is kept:**

  | Item | Kept when |
  |---|---|
  | Pain points | Found word for word within one line on the prospect's side (or an unknown speaker's) |
  | Objections | The same, and each is also filed for you to answer (below) |
  | Next steps | Found word for word within one line; who owns it is the side of that line, not the model's claim |
  | Competitors | A name from your brain's `competitors` that appears as a whole word in the transcript |
  | Sentiment | One of positive, neutral, negative or mixed |

  A quote that holds a link, an email address, a dash or a redacted instruction is dropped. Each kind keeps at most 5 items, of at most 300 characters.
- **Failures.** A model that is unavailable, or refused by the budget, stops the run without counting against the meeting. A call that fails or answers in the wrong shape counts an attempt; after 3, the meeting is marked processed with nothing extracted. A meeting whose stored transcript is missing is released, and the next ingest fetches the recording again.

## Where calls show up

- **Your briefs.** Prep briefs and deal handoff briefs show the last two processed calls, under "From call recordings (their words, checked against the transcript)": pain points, objections, and next steps marked as ours or theirs. They are kept apart from your own notes, which the `notes` command writes. Briefs reach only you.
- **Recap drafts** (`convert:notes_in_recap`). A recap for a meeting whose recording was processed adds "What we agreed:", with up to 3 next steps quoted as said. Such a draft is marked for review of that draft (`per_draft_review` in its notes). Like every meeting draft, it waits for your approval.
- **Objections to answer.** Each objection is filed in the objections list, unapproved and with no answer, at most once per call and item (author `meeting:<meeting id>:<n>`), as objections from replies are: under the brain objection it matches, or `unmatched`, with the quote only as its example. Answer and approve the ones worth answering.
- **The weekly digest.** Monday's funnel digest adds "Competitors named on calls" with a count per competitor, by your brain's names, when any were named.

## Retention and erasure

- **Retention.** The `meeting_transcript_retention` job (daily, 200 a run, whatever the flag says) deletes a transcript a year after its meeting and clears its key. The extracted quotes stay with the meeting until the person is erased.
- **Erasure.** Erasing a person deletes their transcripts from blob storage before their rows, and their meetings with them. An erasure without the `BUCKET` binding refuses rather than leave a transcript behind. Objections filed from their words, from calls or from replies, are deleted while unapproved; an approved one keeps your answer and loses their words. Erasure finds a person by their own contact: what someone else said on a call recorded for another contact stays with that contact's meeting until it is erased or the transcript ages out.

## Limits

| Limit | Value | Where |
|---|---|---|
| Recordings looked at per run, per tool | 20 | `NOTES_LIMITS.ingestPerRun` |
| First lookback, and overlap after | 7 days, 24 hours | `NOTES_LIMITS` |
| Transcript stored | 200 KB of speech | `NOTES_LIMITS.transcriptMaxBytes` |
| Transcript read by the model | 30,000 characters | `NOTES_LIMITS.modelInputChars` |
| Extractions per run | 5 | `NOTES_LIMITS.extractPerRun` |
| Extraction spend | 100 cents a day | `budget:job:meeting_notes_extract:daily_cents` can lower it |
| Transcripts kept | 365 days | `NOTES_LIMITS.retentionDays` |
| Items per kind, characters per quote | 5, 300 | `NOTES_LIMITS` |

The two API reads cost nothing beyond your notes tool's plan. Fathom allows 60 calls a minute, and fewer for transcripts. Granola allows 5 a second.

## Adding another notes tool

Implement `MeetingNotesProvider`: list recordings created after a time, a page at a time, with each invitee's address (and whether they are internal, when the tool knows), and return a transcript as segments marked `us`, `them` or `unknown`. Keep the adapter a translator: which recordings are read, and what is kept, is decided in `packages/core/src/notes/`. Add it to `providers` in `createMeetingNotesJobs` in `src/index.ts`. Its `name` keys its cursor and its recordings.

## When something is wrong

| Symptom | Likely cause |
|---|---|
| The ingest run says "flag off" | `convert:notes_enabled` is off |
| "no meeting-notes provider configured" | Neither `notes-fathom` nor `notes-granola` is enabled in `gtm.config.ts` |
| "no BUCKET binding" | The Worker has no `BUCKET` binding |
| A call never shows up | No invitee is a known contact, several are and calendar sync matched none, or the contact is suppressed. `meeting_recordings.reason` says which |
| The ingest run fails with "HTTP 401" | The key is wrong, or (Granola) the plan does not include the API |
| Extraction says "needs a model in models.roles" | Map the `worker` role to a model and price it in `gtm.config.ts` |
| A recap has no "What we agreed" | `convert:notes_in_recap` is off, the recording was not processed yet, or it started more than 30 minutes from the meeting |

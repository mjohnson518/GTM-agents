# Convert: booked meetings, briefs and what follows

This page is for deployers turning on calendar sync, and for contributors changing how bookings are detected, attributed or followed up. It covers connecting Google Calendar, what is and is not read and stored, how a meeting is detected and tied to a contact, what happens when a meeting is booked, cancelled, moved, held or missed, the prep and handoff briefs, the post-demo drafts, and the commands, flags, jobs and limits involved. The code lives in `packages/core/src/convert/` (`@gtm-agents/core/convert`), the meeting metric in `packages/core/src/metrics/meetings.ts`, and the adapter in `packages/adapters/calendar-google/`.

## What it does

```
every 15 minutes: calendar sync (read-only, ids, status, times, attendees, organizer)
  -> is it a booking?  -> who is it?  (accepted contact | your invite to a contact | one contacted person at their company)
       attributed -> stop outreach to the account, warmth hot, deal to demo_scheduled,
                     credit the first touch, prep brief to you
       ambiguous  -> one notice with the candidates and the link command
every 15 minutes: reminders at 24h and 1h -> after the meeting: "held or no-show?"
  held     -> recap draft for approval -> (optional) day 4 and day 10 follow-up drafts
  no-show  -> recap withdrawn, rebook draft for approval
  cancelled before it starts -> credit withdrawn, rebook draft for approval
hourly (optional): a deal reaches proposal or negotiation -> handoff brief to you
```

There is no click tracking. The booking link records nothing per person, so a booking is found the only honest way: it appears on your calendar. Nothing in convert sends mail. Every recap, rebook and follow-up is a draft that waits for your approval in the operator chat, and you send it from your mail client. No model is called anywhere in convert.

## Connecting Google Calendar

The `calendar-google` adapter reads your primary calendar through the Google Calendar API with the same OAuth client the `inbox-gmail` adapter uses ([INBOX.md](INBOX.md)).

1. **Enable the Google Calendar API** in the same Google Cloud project as your OAuth client.
2. **Choose the scope.** Ask for `https://www.googleapis.com/auth/calendar.events.owned.readonly`: it reads events on calendars the account owns, which includes the primary calendar, and nothing else. If your OAuth consent screen does not offer it, `https://www.googleapis.com/auth/calendar.events.readonly` also works. The adapter never writes: creating, changing or cancelling events, and free/busy lookups, are refused without a request.
3. **Grant a refresh token** for the account whose calendar holds your meetings, with offline access and consent (`access_type=offline`, `prompt=consent`), as for the mailbox.
   - **One token for both.** A Google refresh token carries every scope granted in the consent that produced it. If you authorize `gmail.modify` and the calendar scope together (or add the calendar scope later with `include_granted_scopes=true`), the new token serves both adapters: store the same value under both secret names.
   - **Re-authorizing.** A token granted before you added the calendar scope does not carry it. Grant a new one with both scopes, then update both secrets. Google Workspace domain-wide delegation must list every scope you request; a missing one fails with `unauthorized_client`, and the calendar sync job's failure page shows that code.
4. **Set the secrets:**

   ```bash
   npx wrangler secret put GOOGLE_CALENDAR_REFRESH_TOKEN
   # GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are shared with inbox-gmail
   ```

5. **Enable the adapter** in `gtm.config.ts`:

   ```ts
   adapters: {
     "calendar-google": { options: {} }, // maxPages (1 to 20, default 10) caps pages of 250 events per sync
   },
   ```

6. **Register the jobs** in `apps/worker/src/index.ts`:

   ```ts
   import { createConvertJobs } from "@gtm-agents/core/convert";
   import { createAdapter as createGoogleCalendar } from "@gtm-agents/adapters/calendar-google";

   const calendar = (env: Env) => createGoogleCalendar(context(env, "calendar-google"));
   const convert = createConvertJobs<Env>({ calendar, operator });

   export default createWorker(config, { jobs: [...convert /* , the other jobs */], operator /* , ... */ });
   ```

   The meeting commands run in the operator chat with no extra wiring.
7. **Turn it on:** set `convert:calendar_enabled` to `true` in KV. Optionally turn on `convert:post_demo_enabled` and `convert:handoff_enabled` (below).

## Privacy

- **Fields read.** Every listing asks Google for exactly the event id, status, start and end, attendees (address, whether it is you, their response) and organizer (address, whether it is you). Never the title, description, location, conferencing link, attachments or attendee names. If an answer carries more, the adapter drops it before core sees it. The adapter's contract test fails if the request ever asks for a title or a description.
- **What is stored.** For an event that looks like a booking, `calendar_events` keeps its times, whether you organized it, a short code, the recurring series it belongs to, the ids of the other attributed contacts, and the SHA-256 of each outside attendee's address (with and without a `+tag`) and their domains. It never stores an address that is not already a contact. An attributed meeting adds a `calendar_meetings` row linked to the contact. Unmatched events are forgotten 3 days after they end, ambiguous ones after 14. `calendar_sync_state` holds one row: when the last sync listed the calendar, and the baseline.
- **Notices.** An ambiguous booking's notice shows the outside attendees' domains, never their addresses. Briefs show the contact's address and name, and never another person at the account by name.
- **Erasure.** Erasing a person ([DATA-MODEL.md](DATA-MODEL.md#erasure)) also deletes the calendar events linked to their contact or holding one of their address hashes (any subaddress), their meetings and meeting notes, the briefs written about them, and their meeting drafts. A meeting that belongs to someone else keeps its row and loses the erased person's attendee entry, hashes, contact id, and their domain when no other attendee shares it. Erasure by hash alone does the same for that hash. Calendar sync skips every attendee an erasure tombstone covers, so the next sync never brings the person back.
- **Untrusted text.** Nothing from the calendar is ever shown to a model, and no calendar text is stored. Everything a brief shows from a record passes through a filter that keeps plain characters and caps the length.

## How a meeting is detected

An event is a booking when all of these hold:

- it has a start and an end time (all-day events are never meetings) and is not cancelled;
- you have not declined it;
- it has at least one outside attendee: not you, not someone who declined, not an address at your company's domain or your sending domain (or their subdomains), not one of your configured mailboxes, and not a calendar resource or group calendar;
- it has at most 10 outside attendees (a bigger invite is an event, not a meeting);
- it is not a later instance of a recurring series that already has a live booking (attributed and not cancelled), a booking waiting for your link, or an instance you unlinked: a series counts as one booking. When the booked instance is cancelled, the next live instance can become the series' booking. Instances that stay unmatched are each considered on their own, so the first one a contact matches becomes the booking;
- an outside attendee **accepted**, or **you organized** it (the calendar's own account is the organizer; a colleague's address in the organizer field is not enough, since that field can be forged on an invite from outside). Anyone can put an invite on your calendar, and every answer on an invite from outside is written by its sender and can be forged. So an invite you did not organize counts only once you have accepted it (or answered maybe) yourself and someone outside accepted it. An outside organizer counts only through their own answer on the attendee list.

## How a meeting is attributed

In order, first match wins:

1. **An accepted attendee is a known contact**, matched by address, any `+tag` (`accepted_contact`).
2. **You organized it and an invitee is a known contact**, accepted or not (`organized_contact`).
3. **You organized it, and exactly one contact at an attendee's company domain was sent outreach in the 60 days before calendar sync first saw the booking** (`domain_contacted`). This never applies to personal mail domains or shared hosts, and never to an invite from outside. It is a guess, so briefs and `/meetings` say so.

Two or more candidates in step 3 make the booking **ambiguous**: it is not attributed, nothing changes, and you get one notice listing the outside attendees' domains, the candidates and the command `meeting-link-<code> <contact id>`. A booking with no candidate stays **unmatched**; it is attributed on a later sync if someone accepts or becomes a contact, and `/meetings` lists it so you can link it yourself. `meeting-unlink-<code>` makes any booking **inert**: calendar sync leaves it alone from then on.

## When a meeting is booked

Each step runs once per meeting and contact, claimed in the effects ledger, and a step that fails is retried on the next sync:

- **Outreach stops.** Every cold sequence for the contact, the other attributed contacts and everyone at their accounts ends with status `converted`, their queued cold and sequence sends in the deferred queue are cancelled, and open cold and follow-up drafts for them are rejected.
- **Warmth** moves to `hot` (forward only) for the contact and the other attributed contacts, so each of their accounts counts as in a conversation and the cold batch, a batch release and the follow-up sweep refuse it at their own gates.
- **The deal.** The contact's open deal, or else the account's newest, steps to `demo_scheduled`; with none, one is created and stepped there. A contact or account with a won deal gets no new one.
- **Measurement.** The meeting is credited to the contact's latest first touch sent in the 60 days before it was first seen, as the meeting half of the positive-reply definition ([MEASUREMENT.md](MEASUREMENT.md)). Nothing else counts it: there is no per-template meeting counter (the `templates.times_meeting` column is not written). Meetings per template are the credited sends joined to their template, read through the one definition below.
- **The prep brief** is stored with the deal and sent to you with the booking notice.

The customer lifecycle state is not moved: it has one writer, the lifecycle module.

### The one definition of a meeting booked

A meeting is booked when calendar sync tied it to a contact (any attribution above, or your link), it is not cancelled, and it had not already started when calendar sync began watching (`isMeetingBooked`, `meetingBookedSql`; see the baseline below). Booked does not require outreach: a call with an existing customer that calendar sync attributes is a booked meeting.

A meeting **followed outreach** when the contact had a first touch sent in the 60 days before the meeting was first seen (`meetingAfterOutreachSql`): the same rule that credits it to a send and makes that send's outcome positive. Both live in `packages/core/src/metrics/meetings.ts`, and every report reads them from there.

Once calendar sync is on, the scorecard says both: week to date, "N meetings booked (M after outreach)"; over 30 days, the meetings booked and held, each with the part after outreach, the no-shows and cancellations, and held meetings after outreach per 100 first touches. Until then those lines say "not measured yet".

**The baseline.** Calendar sync records when its first sync ran (`calendar_sync_state.baseline_at`), and never moves it, so an outage or a pause later never drops the bookings made meanwhile. A meeting first seen then that had already started is marked `before_baseline`. It still stops outreach, moves warmth and the deal, and gets the held question, but it is not a new booking: it is not counted as booked and credits no send, because its first sighting is not when it was booked.

## Cancelled, moved, held, no-show

- **Moved.** The new time is recorded, the reminders and the held question re-arm, and you are told once per new time. When it moved to another day (in the contact's time zone), a recap or post-demo draft still waiting for approval names the old day, so it is withdrawn: a recap is drafted again at once when the new time has passed, and otherwise after the new meeting, on the usual schedule; post-demo drafts follow the new schedule. An approved draft was sent from your mail client already and is left as it is.
- **Gone from the calendar.** A meeting that no longer appears in the listing at all (moved more than 60 days out, or deleted without a cancelled marker) keeps its last known time, but that time is stale: no reminder, held question or recap follows on it until the meeting is listed again (even after its old time has passed), and you are told once, with the unlink command in case it is off.
- **Cancelled or declined before it starts.** The meeting stops counting: its credit is withdrawn (a positive reply that came first is never touched; a withdrawal that fails is recorded in the effects ledger and retried by the next sync, unless the meeting counts again by then), its recap and follow-up drafts are withdrawn, a **rebook draft** waits for your approval, and you are told once. This includes the contact a meeting was attributed to by address declining or being taken off the invite. A change of answer to "maybe" is not a cancellation. A meeting removed from the calendar once it started is left as it was.
- **Reminders** come at 24 hours (with the prep brief) and 1 hour before the start.
- **After it ends** you are asked once: `meeting-held-<code>` or `meeting-noshow-<code>`.
  - **Held:** the **recap draft** waits for your approval.
  - **No answer within 24 hours of asking:** the recap is drafted for your review anyway.
  - **No-show:** the recap is withdrawn and a **rebook draft** waits for your approval.

Warmth, the deal stage and stopped sequences only move forward. Unlinking or cancelling a meeting does not reverse them; resume a paused sequence by hand if you need to.

## The briefs

Both are static, deterministic and built from the database alone: no model, no web.

- **Prep brief** (on booking, in the 24-hour reminder, and on demand with `prep-<contact id or email>` for any contact): who they are, the account, segment, team size and fit, recent signals (type and date only), relationship history, the last touches (subjects of your own emails only), reply intents (never their text), the deal, earlier meetings and your own meeting notes. Other people at the account are counted, never named.
- **Deal handoff brief** (with `convert:handoff_enabled`, hourly): when a deal reaches `proposal` or `negotiation`, its value, age, stage history, meetings held and missed, and the contact section above, once per deal and stage. Pricing, offers and discounts stay with you.

## The drafts

Recap, rebook and the two post-demo follow-ups are short plain-text notes built from the contact's first name, the product and agent names in `gtm.config.ts`, your booking URL (`sending.bookingUrl`) when set, and the meeting day in the contact's time zone when it is known. They are starting points you edit in your mail client. Each is written once per meeting (`drafts.idempotency_key` is `convert:<code>:<kind>`), filed under the `post_meeting_followup` or `rebook` action class, and sent to the operator chat as an approval request. A suppressed, opted-out or erased address gets no draft. Approving marks a draft approved; nothing is sent from the chat, and these drafts are not mirrored into the mailbox.

**Post-demo follow-ups** (`convert:post_demo_enabled`): once the recap is approved, the day 4 follow-up is drafted 4 days after the meeting; once that is approved, the day 10 follow-up is drafted. They stop, and open ones are withdrawn, on any mail from the contact or anyone at the account after the meeting, a suppressed address, a sign-up, or a newer meeting with the contact or the account. A no-show never gets them.

## Commands

None reaches the model, and each runs once per message.

| Command | What it does |
|---|---|
| `/meetings` | Upcoming meetings with their codes, and bookings not linked to a contact |
| `meeting-held-<code>` | It took place: the recap is drafted for approval |
| `meeting-noshow-<code>` | It did not: the recap is withdrawn and a rebook drafted for approval |
| `meeting-notes-<code> <notes>` | Keep your notes on the meeting (up to 2,000 characters each); later briefs show them |
| `meeting-link-<code> <contact id or email>` | Tie a booking to a contact; the booked effects run and the reply carries the prep brief |
| `meeting-unlink-<code>` | Make a meeting inert: it stops counting, its credit and open drafts are withdrawn, and nothing more follows |
| `prep-<contact id or email>` | A one-page prep brief on any contact |

The meeting commands need `convert:calendar_enabled`; `/meetings` and `prep-` only read and need no flag beyond `operator:agent_enabled`.

## Flags

| Flag | Default | What it turns on |
|---|---|---|
| `convert:calendar_enabled` | off | Calendar sync, the booked effects, reminders, the held question, recap and rebook drafts, and the meeting commands |
| `convert:post_demo_enabled` | off | The day 4 and day 10 follow-up drafts |
| `convert:handoff_enabled` | off | The deal handoff brief |

An unreadable flag counts as off.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `calendar_sync` | every 15 minutes | `convert:calendar_enabled` | 2 minutes, 500 events |
| `meeting_followups` | :05, :20, :35, :50 | `convert:calendar_enabled` | 1 minute, 200 meetings |
| `deal_handoffs` | hourly at :10 | `convert:handoff_enabled` | 30 seconds, 20 deals |

None calls a model or spends. `calendar_sync` is critical, so the cron health check watches it, and safe to rerun.

## Limits

- **Nothing is sent automatically.** The post-meeting follow-up and rebook action classes stay at "draft and ask" here, whatever their level.
- **Proof of value is not available yet.** Requesting the product's analysis for a prospect needs the product bridge ([ROADMAP.md](ROADMAP.md)), and sending its result is permanently human.
- **Google Calendar only**, primary calendar only, read-only. The `CalendarProvider` port ([INTERFACES.md](INTERFACES.md)) and its shared contract test are ready for another adapter.
- **When a meeting was booked** is when calendar sync first saw it: the creation time is not read. On the first run after you turn sync on, every meeting in the window is first seen then; those that had already started are not counted as bookings (the baseline above), and those still ahead count as booked that day.

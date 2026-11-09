# Measurement and reports

This page is for deployers who want to know what their deployment's numbers mean and how to read the daily scorecard and the other reports, and for contributors adding a report or a metric. It covers the per-send ledger, the one definition of each metric, matured samples, measurement health, the scorecard line by line, the funnel and cost digests, the conversion report, holdout lift, and the flags, jobs, commands and limits involved. The code lives in `packages/core/src/metrics/` (`@gtm-agents/core/metrics`) and `packages/core/src/reports/` (`@gtm-agents/core/reports`).

## The rule

Every metric has exactly one implementation, a function in `packages/core/src/metrics/` that reads the database for a time window. Every report, experiment and promotion check calls those functions, so two reports asking about the same window always show the same number. A report module never counts anything itself: it holds no SQL at all, and a test fails the build if one ever does. The same holds for the send gates' bounce rates: a test fails the build if any module outside `metrics/` counts bounces or divides by them.

Reports make no model calls. A number that cannot be read is shown as "could not be read", never as a zero, and a line that depends on something not measured (quotas; meetings while calendar sync is off; sign-ups, activations and paid customers while lifecycle is off) says "not measured yet".

## Windows

A window is half-open, `[from, to)`, in UTC. The reports build theirs from the same helpers (`metrics/window.ts`):

| Window | Span |
|---|---|
| The day | Since the previous report: yesterday, or Friday 00:00 to Monday 00:00 on a Monday |
| 7 days | The seven full UTC days before today |
| 30 days | The thirty full UTC days before today |
| Week to date | Monday 00:00 UTC until now |

## The per-send ledger

`outreach_sends` holds one row for every email the send function sends, written in the same bookkeeping step as the send ([SENDING.md](SENDING.md)). It is the basis of every outreach metric. Rows outlive an erased contact (their `contact_id` is cleared), so reports stay honest after an erasure.

| Column | What it records |
|---|---|
| `send_path` | `cold`, `sequence`, `reply` or `lifecycle`. Only `cold` and `sequence` are outreach |
| `sequence_step` | 1 for a first touch, 2 and later for follow-ups |
| `template_id`, `template_sha256` | The template and the SHA-256 of the exact template file the message was built from |
| `cohort` | `signalled`, `segment_routed` or `generic` (below) |
| `provider`, `provider_message_id` | Who sent it, and their id for it |
| `delivered_at`, `bounced_at`, `complained_at` | Set by the provider's webhook. Only a hard bounce sets `bounced_at` |
| `replied_at`, `reply_intent`, `reply_after_step`, `positive_reply_at` | Set by the reply track when it credits a reply (below) |

The composer (the cold batch, the follow-up sweep) works out the template version and the cohort when it writes a draft, and the draft carries both to the send function, because a draft can wait days for its release while its template is edited. The send function records them as bookkeeping only: a missing or malformed value is left empty and never stops a send.

**Cohort.** `signalled` (it occurs once signal sources are on, [SIGNALS.md](SIGNALS.md)) when the contact, or the contact's account, had a signal (a job change, hiring, funding, a launch and the like, from `signal_events`) detected in the 90 days before the message was composed; a signal you dismissed does not count. Otherwise `segment_routed` when the template targets segments, personas or team sizes. Otherwise `generic`, which is reported on its own and never called personalized. When the signals cannot be read, the cohort is left empty rather than guessed, and reports show it as unknown.

## The metrics

| Metric | Function | Definition |
|---|---|---|
| Reply | `countsAsReply` | A message a person wrote back. Opt-outs, unsubscribes, automatic replies (out of office included), spam and noise never count, whatever their classification |
| Positive reply | `isPositiveReply` | A reply whose triage intent is interested, question or referral, or a non-cancelled, attributed meeting first seen after the send. "Not a fit" is a reply but never positive. The meeting half applies once calendar sync is on (`meetingCountsAsPositive`, below), and a meeting that is later cancelled or unlinked withdraws its credit |
| Sign-up, activation, new paying customer | `metrics/product.ts` | The first time a contact enters signed up, activated, or a paying state, written once per contact by the lifecycle module from product and billing events, and credited to the contact's latest first touch inside the attribution window. A second activation, an upgrade or a returning customer is never a new outcome. [LIFECYCLE.md](LIFECYCLE.md) describes the states |
| Experiment samples and statistics | `metrics/experiments.ts`, `metrics/experiment-stats.ts` | Matured samples per arm, cell, subject variant and send slot, and the Monte Carlo and normal-approximation statistics every experiment, the copy-change gate and the A/B report use ([EXPERIMENTS.md](EXPERIMENTS.md)) |
| Meeting booked | `isMeetingBooked`, `countMeetings` (metrics/meetings.ts) | A calendar meeting attributed to a contact (by an accepted attendee, an operator-organized invite, the one contact at that company contacted in 60 days, or an operator link) that is not cancelled. A recurring series counts once. Heuristic attributions are flagged. [CONVERT.md](CONVERT.md) describes detection |
| First-touch attribution | reply track (`creditReply`) | A reply is credited to the contact's latest first touch sent in the 60 days before it. `replied_at` and `positive_reply_at` are the reply's own received time, never the time a job ran; when replies arrive out of order the earliest wins. `reply_after_step` is the highest step actually sent between that first touch and the reply, so it says how deep the sequence was and can never name a step that did not go out |
| Sends | `countSends` | Outreach (the cold and sequence paths) by when it was sent: first touches (step 1), follow-ups (later steps) and unnumbered sends (recorded with no step). An unnumbered send is outreach, so delivery health counts it, but it is neither a first touch nor a follow-up and no reply is credited to it. The three always add up to delivery health's sends for the same window |
| Replies received | `countReplies` | Human and positive replies by when they arrived. One ledger row is one conversation, so a second reply to the same first touch is not counted again |
| Reply depth | `replyDepth` | Those replies by `reply_after_step` |
| First-touch outcomes | `firstTouchOutcomes`, `firstTouchOutcomesBy` | The first touches sent in a window, and how many of them hard bounced, earned a human reply and earned a positive reply by now. The basis of every rate. Sliced by template, subject, cohort, segment or persona, the slices add up to the total |
| Matured samples | `maturedSamples`, `maturedTotals` | Below. `maturedTotals` adds the same rows up over every template |
| Rate | `replyRate` | Replies (human or positive) over the sends they came from, or n/a with no sends. Every report that prints or compares a rate uses it |
| Delivery counts | `deliveryCounts` | Outreach sent in the window, and the delivered, hard bounce and complaint events that arrived in it. Events count by when they arrived, so a bounce that comes in today for last week's mail counts today. Every bounce and complaint figure below is taken from these counts |
| Hard bounce rate | `hardBounceRate` | Hard bounces over sends. The one bounce rate the bounce monitor, campaign readiness, the scorecard and the funnel digest read. The gates read a trailing window that stays open at its end (anything recorded since the window opened counts, including an event stamped while the check runs); the reports read full UTC days. Their thresholds differ, their definition does not |
| Hard bounce share of outcomes | `hardBounceShareOfOutcomes` | Hard bounces over delivered plus hard-bounced mail: of the mail the provider reported an outcome for, how much bounced. Only the warm-up ramp reads it, before it raises volume, so mail whose outcome has not been reported yet never dilutes the rate it advances on. |
| Complaint rate | `complaintRate` | Complaints over delivered mail. The warm-up ramp and the reports read it |
| Delivery health | `deliveryHealth` | The counts, the hard bounce rate and the complaint rate for a report window, and delivered coverage: delivered plus hard-bounced over sends, the share the provider reported an outcome for, so a high bounce rate never lowers it |
| Reply SLA | `replySla` | Replies owed for more than 4 hours, using the reply clock's definition of owed ([REPLIES.md](REPLIES.md)), and the oldest one's age. Counted over the reply clock's window, 14 days by default. `replySla` and the operator queue's owed count (`operatorQueue`) both take a deployment's override, the `owedWindowDays` it gives `createReplyJobs`, and resolve it the same way (`owedWindowDays`), so the two never count over different windows |
| Time to answer | `replyResponseTimes` | Median hours from a reply that needed a person arriving to its answer going out |
| Spend per job | `spendByJob` | The cost ledger per job. A cost recorded outside a job (the email provider's per-message cost) is shown as `provider:<name>` |
| Failed jobs | `failedJobs` | Scheduled, rerun and manual job runs that failed. Chat turns are not jobs |
| Waiting on you | `operatorQueue` | Drafts pending approval by kind, cold batch and follow-up manifests that can still be released, owed replies, open manual touches |
| Measurement health | `measurementHealth` | Below |
| Holdout lift | `holdoutLift`, `liftVerdict` | Below |

A rate is always a count over its own denominator. When the denominator is zero the rate is "n/a", not 0%.

## Matured samples

Experiments (a later milestone) judge templates on matured samples only:

- first touches only, because a reply is credited to the first touch that opened the conversation;
- not hard bounced, because a bad address says nothing about copy;
- sent at least 10 days ago. Follow-ups land on days 3 and 10 by default, so a younger first touch has not had its whole sequence yet, and counting it would make every new template look worse than it is;
- sent from the template's current copy: the ledger's `template_sha256` must equal `templates.body_sha256`, which every cold batch run refreshes from the served templates. Editing a template starts its sample afresh, so results earned by the old copy are never credited to the new one.

## Measurement health

Before any report names a leading slice, a lift is called sufficient or an experiment concludes, the numbers under it must be complete:

- **Ledger coverage.** The provider's own evidence of what was sent in the last 7 days (each sent message's `outreach_sent` funnel event, written beside its ledger row, and each delivered event the provider webhook recorded) is matched to ledger rows by provider and message id. With 20 or more such messages, at least 95% must have a ledger row, or reply-based conclusions are held: replies would be credited against a short denominator. Under 20 there is too little to judge, and nothing is held, unless the ledger itself holds 20 or more sends for those days: then the evidence is missing, and conclusions are held.
- **The product bridge.** A product event (source `product` on the event spine, [EVENT-CONTRACT.md](EVENT-CONTRACT.md)) still unrouted 6 hours after it arrived holds product-metric conclusions, because a sign-up or payment may be missing.
- **Fail closed.** A check that cannot be read holds what it guards. An unreadable ledger check holds every conclusion.

The scorecard's measurement line shows the verdict and why.

## The daily scorecard

One operator message each weekday at 12:00 UTC, behind `ops:daily_scorecard`. Each section loads on its own: a section whose read fails says so and is listed under what needs attention, and the rest of the message still goes. Line by line:

| Line | What it shows |
|---|---|
| Week to date | First touches, positive replies, and (while their sources are on) meetings booked, sign-ups, activations and new paying customers since Monday. Quotas: not measured yet |
| Sends | First touches and follow-ups for the day, and for 7 days, and unnumbered sends when there are any |
| Delivery, 7 days | Delivered of sends (delivered coverage), hard bounces and complaints with their rates. Flagged when hard bounces reach 2% of sends, complaints reach 0.1% of delivered mail, or delivered and bounce events together cover under 95% of sends (then the two rates cannot be trusted; check that the provider's webhook is arriving) |
| Replies | Human and positive replies for the day and for 7 days, and over 7 days how many came after step 1, step 2 and so on |
| Reply SLA | Replies owed for more than 4 hours and the oldest one's age (flagged when any), and the median time to answer over 30 days |
| Spend | Spend for the day, and the six most expensive jobs |
| Failed jobs | Failed runs for the day, by job (flagged when any) |
| Convert, 30 days | Meetings booked and held, sign-ups, activations and paid, each while its source is on |
| Cohorts | First touches sent in 30 days and their positive replies, per cohort |
| Measurement | ok, with the ledger coverage, or conclusions held and why (flagged) |
| Waiting on you | Drafts pending approval by kind, cold batches and follow-up releases waiting, owed replies, manual touches |
| Flags on | Every on/off flag that is on |
| Needs attention | Every flag raised above, or "nothing" |

It is sent at most once per UTC day: the day is claimed in the effects ledger before the message goes, and released if the channel fails, so the next run tries again.

## The other reports

**The funnel digest** (Mondays at 09:00 UTC, `ops:funnel_digest`). Over the seven full days before today (the scorecard's 7-day window): sends, replies received and delivery health. The reply rate is the matured one: first touches sent 10 to 17 days ago, not bounced, and sent from each template's current copy, exactly the rows matured samples count, because a rate on yesterday's sends would read low for no reason. It flags a matured reply rate under 3% (at 50 or more matured first touches) and hard bounces over 2% (at 50 or more sends). One line of holdout lift.

**The daily cost digest** (weekdays at 14:00 UTC, `ops:cost_digest`). Spend per job for the same span as the scorecard's day. While the scorecard is on it carries spend, so the cost digest stands down.

**The conversion report** (on demand). The first touches sent in the thirty full days before today (the scorecard's cohort window), sliced by template, subject, cohort, segment and persona, best first: positive rate, then reply rate, then volume. A slice under 30 sends is labelled directional and is never named the leader, and neither is the unknown slice (sends with no template, cohort, segment or persona recorded). Nothing is named while measurement health holds reply conclusions. The subject slice is the subject line as written in the template (or a subject test's variant), never a rendered subject, which would carry names from outside. Segment and persona are read as they are recorded today.

**Holdout lift** (on demand, and one line of the funnel digest). The cold batch holds a share of each day's picks out as a no-send control ([OUTREACH.md](OUTREACH.md)). Over contacts who entered between 90 and 10 days ago:

- held: contacts held out in that span; written to: contacts whose first touch was sent in it, leaving out anyone also held out;
- positive: a positive reply from the contact received within 60 days after they entered, read from inbound mail the same way for both groups, so a held contact who writes in on their own counts just as a written-to one does;
- sign-ups within 30 days, from the product outcome definition, while lifecycle is on. Otherwise the sign-up line says "not measured yet";
- lift: the written-to rate minus the held rate, in points.

A lift is sufficient only with 100 or more contacts in each group and healthy measurement. Spillover within an account (a held contact's colleague was written to and passed it on) makes the held group look better than no outreach at all, so lift reads low, never high. The report says so every time.

Operator messages carry counts, ids and labels only. A label read from a record (a template id, a segment, a persona, a job name) keeps plain characters and is capped in length; inbound text and rendered subjects never appear.

## Commands

In the operator chat ([OPERATOR.md](OPERATOR.md)). They only read, never reach the model, and each runs once per message however often the channel delivers it. They need the operator agent on, and no other flag.

| Command | What it does |
|---|---|
| `/scorecard` | The daily scorecard, as of now |
| `/report conversion [template\|subject\|cohort\|segment\|persona]` | The conversion report; with a dimension, that one in full |
| `/report funnel` | The funnel digest, as of now |
| `/report cost` | Spend per job since the previous report |
| `/report holdout` | Holdout lift |

## Turning it on

Register the report jobs in `apps/worker/src/index.ts`, with the operator channel the rest of the Worker uses:

```ts
import { createReportJobs } from "@gtm-agents/core/reports";

const reports = createReportJobs<Env>({ operator });

export default createWorker(config, {
  jobs: [...reports /* , the other jobs */],
  operator,
  // ...
});
```

Reports go to `options.chatId`, or the first chat in `operator.allowedChatIds`. Then turn on the reports you want:

```bash
npx gtm flags set ops:daily_scorecard true
npx gtm flags set ops:funnel_digest true
```

The commands need nothing beyond the operator chat.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `ops:daily_scorecard` | `false` | The daily scorecard. While on, the daily cost digest stands down |
| `ops:funnel_digest` | `false` | The weekly funnel digest |
| `ops:cost_digest` | `false` | The daily cost digest, while the scorecard is off |

A flag that cannot be read counts as off.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `daily_scorecard` | 12:00, Monday to Friday | `ops:daily_scorecard` | One message, 1 minute |
| `funnel_digest` | 09:00 on Mondays | `ops:funnel_digest` | One message, 1 minute |
| `cost_digest` | 14:00, Monday to Friday | `ops:cost_digest` | One message, 30 seconds |

None calls a model or spends, and each is safe to rerun. Change a schedule or the chat with `createReportJobs({ operator, options: { scorecardSchedule, funnelSchedule, costSchedule, chatId } })`.

## Limits

- **Each source must be on.** Meetings need calendar sync, and sign-ups, activations and paid customers need lifecycle; while a source is off its lines say "not measured yet", and positive replies come from triage intent alone when calendar sync is off.
- **Outcomes are as of now.** A first touch's outcome keeps changing until its 60-day attribution window closes, so a report run later can show more replies for the same sends. Sends and delivery counts for a closed window do not change.
- **Subject lines are today's.** The subject slice reads the template's subject line as it stands now, so editing a subject mid-window credits the whole window to the new line.
- **Two bounce thresholds.** The scorecard flags hard bounces at 2% or more at any volume; the funnel digest flags them over 2% at 50 or more sends. Both read the same number for the same window.
- **Ledger coverage covers the last 7 days.** A gap in older ledger rows is not seen by a conclusion over a longer window.
- **Segment and persona are today's.** The conversion report reads them from the account and contact as recorded now, not as they were when the message went.
- **Drafts written before the template version and cohort were recorded** carry neither, and their sends are left out of matured samples and shown as unknown cohort.
- **The template's current copy** is the one the last cold batch run recorded in the `templates` table. An edit takes effect in matured samples once the next batch runs.

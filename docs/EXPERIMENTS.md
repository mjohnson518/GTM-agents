# Experiments: allocation, pre-registered tests and the copy-change gate

This page is for deployers who want the agent to learn which copy works without letting it change copy on its own, and for contributors changing how templates are allocated, how an experiment concludes, or how a change is proposed. It covers Thompson allocation and its guardrails, account-clustered assignment, the experiment types, pre-registration and the conclusion rules, the copy-change gate, proposals and the weekly self-review, the A/B dashboard, and the commands, flags, jobs and limits involved. The code lives in `packages/core/src/experiments/` (`@gtm-agents/core/experiments`); the counts it judges on live in `packages/core/src/metrics/experiments.ts` and the statistics in `packages/core/src/metrics/experiment-stats.ts`.

Three rules hold everywhere:

- **Measure on matured samples with the one definition.** Every count is a matured sample ([MEASUREMENT.md](MEASUREMENT.md)): a first touch, not bounced, at least 10 days old, sent from the template's current copy. Success is a positive reply as `metrics/` defines it, or, for a product metric, a product outcome credited to the arm. Nothing in `experiments/` counts sends or replies itself.
- **Conclude only by pre-registered rules.** An experiment's rules are fixed before it starts and locked while it runs. While measurement health blocks, nothing concludes and nothing is proposed. Health that cannot be read blocks.
- **Propose, never apply.** No job changes copy, a template weight or a setting. Every change is a proposal that only the operator's `exp-approve-<id>` applies, and only if nothing changed since it was made.

Every random choice draws from a generator seeded per batch or per evaluation, and the seed is recorded (on the campaign for a batch, in the experiment's notes for a conclusion), so any allocation or conclusion can be reproduced.

## Allocation

The cold batch ([OUTREACH.md](OUTREACH.md)) plans every contact's template before composing any draft (`plan.ts`). `outreach:allocation_mode` decides how:

| Mode | What happens |
|---|---|
| `weighted` (default) | Rotation by each template's `volume_weight`, exactly and deterministically. This is also the escape hatch: setting it back reverts at once. |
| `thompson` | Thompson sampling with guardrails among the general (untargeted) templates, once every arm has 50 matured sends. Before that, volume weights decide. |

A contact a targeted template matches (segments, personas or team sizes in its frontmatter) keeps segment routing under weighted rotation in either mode.

Thompson allocation (`thompson.ts`):

- **Arms:** the protected control plus at most 4 other general templates, highest weight first. The control is `experiments:control_template` when that names an active general template, otherwise the general template with the highest weight. Templates past the fifth are not offered in this mode, and the batch message names them.
- **Shares:** each arm's posterior is Beta(1 + positives, 1 + sends minus positives) over matured samples from the last 180 days, and its share is P(arm is best) by Monte Carlo over 4,000 draws.
- **Floors:** the control always gets at least 20%. Every other arm gets at least 15%, scaled down so all floors together never exceed 50%. A share is its floor plus its part of what the floors leave, so no arm is starved and the shares add up to 1.
- **Cells:** contacts are grouped by segment, team size and persona, most specific first: `segment|team size|persona`, then `segment|team size`, then `segment`. A cell decides only when every arm has 150 real matured sends in it. Each arm there is shrunk toward its rate in the parent cell with 50 pseudo-sends. Readiness counts real sends only. With no ready cell, the pooled posterior decides.
- **Counts:** within each cell, shares become whole counts by systematic sampling with a random offset (each count is within one of its share), then the arm labels are shuffled and dealt in order.
- **Colleagues stay together:** an account whose latest cold first touch (sent, or waiting as a draft) used one of the arms keeps that template.

Approved weight changes are stored as `experiments:template_weight:<template>` and replace the template file's `volume_weight` in both modes. Unset, unreadable or malformed, the file's weight applies.

## Account-clustered assignment

When two colleagues get different arms, what one hears reaches the other, and both arms are contaminated. So the unit of assignment is the account key, and a contact without one is its own unit (`assignment.ts`):

- For each running experiment, in the order they started, a unit already pinned in `experiment_assignments` keeps its arm for the life of the experiment.
- New units are taken in salted-hash order (salted with the batch seed and the experiment id). Each is assigned an arm half and half from the seeded generator. It enters only if that arm has room for every contact the account holds, against `max_sample_per_arm`. Without room it is planned without the experiment and gets no arm credit; it is never moved to the other arm, which would make membership depend on account size.
- A unit enters only when every contact of the unit in the batch may be offered both templates, only while the experiment is younger than its max duration, and only into one experiment.
- Arms are pinned before any draft is composed. A pin that cannot be written leaves the unit out: nothing is credited to an arm that was not recorded.
- A pinned account's contacts get the arm's template or neither of the experiment's templates. A colleague the arm's template cannot be offered to, every contact once the arm has grown past its max sample (accounts gain contacts), and every contact while the experiment is on hold get some other template, or none, never the other arm's.
- An account that was not enrolled but got one of the experiment's templates anyway is pinned `excluded`, so no colleague enrolls later after hearing that copy.
- If the assignments cannot be read, nobody is enrolled and no running experiment's template goes out in that batch.

The arm rides on the contact's campaign row to the send function, which records `experiment_id` and `experiment_arm` on the ledger. The holdout ([OUTREACH.md](OUTREACH.md)) is drawn before any of this, so held contacts are never enrolled.

## Experiment types

| Type | How it works |
|---|---|
| Template experiment | Control template against treatment template, on a pre-registered metric: `positive_reply` (the default), `conversation_started`, or the product metrics `signed_up`, `activated` and `paid`. At most 2 run at once. |
| Subject test | Competing subject lines on one template's body (subject and template are factorial cells). At most one runs per template, and never on a running experiment's template (nor can an experiment start on a template with one running). New units split evenly until every variant has 50 matured sends, then by Thompson sampling with floors. Each draft is composed and gated with its variant, and the variant is recorded against the draft. Contacts enrolled in an experiment always get the template's own subject. |
| Send-time test | Recipient-local early (08:00 to 10:00) against afternoon (13:00 to 15:00), behind `outreach:send_time_experiment`. Each account gets a slot, balanced within its time zone. The send function narrows the recipient's window to the slot and defers until it opens; it never widens the configured window. When `sending.windowHours` does not overlap both slots, the test plans nothing and the batch message says so. |
| Segment routing | Templates targeted by segment, persona or team size, as before. |
| Holdout | The no-send control group ([MEASUREMENT.md](MEASUREMENT.md)). |

A product metric credits the last arm the person received within 60 days, once per experiment, contact and metric: the lifecycle module records the arm on the outcome's funnel row ([LIFECYCLE.md](LIFECYCLE.md)).

## Pre-registration

An experiment is created as a draft and may be amended while it is one. It cannot start until it has every one of: hypothesis, population, exclusions, primary metric, metric window, baseline rate, minimum detectable effect (absolute, in rate points), max sample per arm (at least 20), max duration, stopping rule, and two different templates.

Its target per arm is set when it starts: the sample-size helper (two-sided 95%, 80% power, normal approximation) for its baseline and effect, capped by its max sample. `sample-size <baseline> <mde>` shows the helper's answer. A target under 300 can only conclude inconclusive, and step one of starting says so.

Starting takes two steps:

1. `experiment-start <id>` checks that the pre-registration is complete, both templates are active cold first touches with weight above 0, measurement health does not block the metric, and fewer than 2 experiments run. It then shows the record and both templates' numbered copy, with a command `experiment-start-<id>-<code>`.
2. That command starts it only if every check still passes and the code still matches. The code is the start of a SHA-256 over the record and both template files, so any edit to either in between refuses the start.

The start itself is a compare-and-set on every pre-registered field, so an amendment that lands between the checks and the write refuses it. Once running, the pre-registration is locked and no command edits it.

The start records both template files' SHA-256 (migration `0024_experiment_copy.sql`). While either template's current file differs, or cannot be read, the experiment is on hold: it enrolls no one, cannot conclude, and you are told once. Restore the copy, or stop it and start a new one.

## Conclusion

The `experiments_cycle` job evaluates every running experiment twice a day (`evaluate.ts`):

- While measurement health blocks the experiment's kind of metric, it waits, even past its max duration.
- It may conclude once both arms reach the target and the minimum age has passed (10 days for a reply metric, 45 for a product metric), or once it reaches its max duration. Before that it waits, however large the difference.
- Confidence is P(treatment beats control) by Monte Carlo over both arms' posteriors, seeded from the experiment id and the hour of evaluation. The seed goes in the notes.
- **Keep** at confidence of 0.95 or more, **discard** at 0.05 or less, both only with 300 or more matured sends in each arm. Anything else is **inconclusive**.

A conclusion is written with a compare-and-set and sent to you once. Discard and inconclusive change nothing. Keep changes nothing either: it opens a copy-change proposal for the treatment.

## The copy-change gate

A winner is proposed over the arm it beat only when each arm has 300 or more matured sends (each at least 10 days old) and P(winner better) is 0.95 or more by the deterministic normal approximation of the two Beta posteriors (`gate.ts`). The gate runs for a kept experiment, for each template that beats the protected control while allocation is `thompson`, and for a subject test's best variant against its runner-up.

Proposals are deduplicated for 7 days and sent to you. Approving one:

- **A template promotion** moves the loser's weight to the winner and leaves the loser at a floor of 0.1, so a promotion never switches a template off. It refuses, and marks the proposal stale, if either template's file changed, either weight changed, or (for an experiment) the experiment is no longer concluded with keep. A promoted experiment's status becomes `promoted`.
- **A subject winner** concludes the test with its winner, and the template goes out with the winning subject line from then on, whatever `experiments:enabled` says (contacts enrolled in an experiment still get the template's own subject). It refuses if the test is no longer running or the template changed.

A subject test whose sends reach 100 with no reply at all pages you once. That pattern is broken reply attribution, not bad copy.

## Proposals and the weekly self-review

The `experiments_self_review` job (Sundays) is rule-based and calls no model (`self-review.ts`). It makes at most 3 proposals in any 7 days, in this order:

1. **A template weight**, by 0.1: up when P(template beats the protected control) is 0.9 or more, down when it is 0.1 or less, with 150 or more matured sends in both. Skipped while measurement health blocks.
2. **The holdout rate**, doubled up to its maximum of 0.2, when fewer than 100 contacts were held out in the last 90 days.
3. **The next signal source**, the first source configured in `signalSources` whose `discovery:<source>_enabled` is not on, when verified runway (contacts ready for cold selection over today's cold volume) is under 30 days. It only proposes.
4. **The send-time test**, when it is off and the last 14 days held 300 or more first touches.

Every proposal records the value its setting held, a prediction, and the evidence to judge it by. Applied proposals are judged once their horizon passes (28 days for most, 90 for the holdout, 42 for the send-time test), and each records hit or miss. Every new proposal shows the track record of the ones before it.

Only `exp-approve-<id>` applies a proposal. It locks the settings it writes (a claim in the effects ledger, so two approvals touching the same setting never interleave), re-reads them, refuses (and marks the proposal stale) if a setting no longer holds the value the proposal was made against, claims the proposal with a compare-and-set, and then writes. A write that fails puts the proposal back to pending. A pending proposal expires after 14 days, and an approval of an older one is refused.

## The A/B dashboard

`ab-dashboard` shows each running experiment (arms, rates, P(treatment better) by the normal approximation, target and start), each running subject test, the template arms, the send-time slots, and conclusions from the last 30 days. Each test shows its leader and the lift over the second best, in points. An arm under 30 matured sends is marked directional and never named leader. A section that cannot be read says so, never zero.

## Commands

These never reach the model, run once per message, and only an allowlisted operator can send them:

| Command | What it does |
|---|---|
| `experiment-create <fields>` | Create a draft: JSON, or one `key: value` per line |
| `experiment-update <id> <fields>` | Amend a draft |
| `experiment-show <id>` / `experiment-list` | Show one, or list them |
| `experiment-start <id>` | Step one: the record, both templates' numbered copy, and the start command |
| `experiment-start-<id>-<code>` | Step two: start it, only if nothing changed |
| `experiment-stop <id>` | Stop a draft or running experiment; nothing is promoted |
| `exp-list` | Pending proposals |
| `exp-approve-<id>` / `exp-reject-<id>` | Apply or decline a proposal |
| `subject-test-create <fields>` | `name`, `template`, and two to five `variant` lines |
| `subject-test-stop <id>` | Stop a subject test without a winner |
| `ab-dashboard` | The A/B dashboard |
| `sample-size <baseline> <mde>` | Sends per arm for a two-sided 95%, 80% power test |

The fields are `name`, `hypothesis`, `population`, `exclusions`, `primary_metric`, `metric_window_days`, `baseline_rate`, `min_detectable_effect`, `max_sample_per_arm`, `max_duration_days`, `stopping_rule`, `control_template` and `treatment_template`. For example:

```
experiment-create
name: Rerun question opener
hypothesis: Asking about rerun time earns more positive replies than stating the pain.
population: Cold first touches to contacts only general templates match.
exclusions: Accounts already in another experiment.
primary_metric: positive_reply
metric_window_days: 30
baseline_rate: 0.04
min_detectable_effect: 0.03
max_sample_per_arm: 600
max_duration_days: 56
stopping_rule: Conclude at target and 10 days, or at 56 days.
control_template: cold-intro
treatment_template: cold-intro-question
```

## Turning it on

1. Make sure measurement health is clear on the scorecard ([MEASUREMENT.md](MEASUREMENT.md)); nothing concludes while it blocks.
2. Register the jobs in your Worker: `createExperimentJobs({ operator, volume, options: { signalSources: [...] } })`. If your Worker bundles its templates for the cold batch, pass the same files as `templates` to the jobs and to the chat agent, so every check reads the copy the batch sends.
3. Turn on `experiments:enabled`, then create and start an experiment. Enrollment begins with the next cold batch.
4. Optionally set `outreach:allocation_mode` to `thompson`, name the protected control in `experiments:control_template`, and turn on `experiments:self_review_enabled`.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `experiments:enabled` | off | Experiments and subject tests enroll in the cold batch, and the cycle evaluates and proposes |
| `experiments:self_review_enabled` | off | The weekly self-review |
| `outreach:allocation_mode` | `weighted` | `thompson` turns on Thompson allocation; anything else, or a read error, is weighted |
| `outreach:send_time_experiment` | off | The send-time test |
| `experiments:control_template` | unset | The protected control; unset, the highest-weight general template |
| `experiments:template_weight:<template>` | unset | State: a weight written only by an approved proposal |

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `experiments_cycle` | 09:00 and 21:00 daily | `experiments:enabled` | 2 minutes; 20 experiments and 20 subject tests a run |
| `experiments_self_review` | Sundays 14:00 | `experiments:self_review_enabled` | 2 minutes; 3 proposals |

Neither calls a model. Both leave a run row.

## Limits

| Limit | Value |
|---|---|
| Running template experiments | 2 |
| Arms in Thompson allocation | the control plus 4 |
| Control floor / other arm floor / floors in total | 20% / 15% / at most 50% |
| Matured sends before Thompson decides | 50 per arm |
| Matured sends before a cell decides | 150 per arm, shrunk with 50 pseudo-sends |
| Max sample per arm | at least 20 |
| Minimum age before concluding | 10 days (reply metrics), 45 days (product metrics) |
| Keep / discard | confidence 0.95 or more / 0.05 or less, with 300 or more matured sends per arm |
| Copy-change gate | 300 matured sends per arm, P(better) 0.95 or more |
| Loser weight after promotion | 0.1 |
| Proposal dedupe / expiry | 7 days / 14 days |
| Self-review proposals | 3 in any 7 days |
| Subject variants per test | 2 to 5 |
| Zero-reply tripwire | 100 sends with no reply |

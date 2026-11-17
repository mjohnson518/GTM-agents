---
name: turn-on-a-slice
description: Turn on the next GTM-agents capability safely, following the staged rollout (staging first, one capability at a time, with its checks). Use only when the person asks to turn something on.
disable-model-invocation: true
---

# Turn on the next capability

Every capability ships behind a flag that is off. The [staged rollout](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#9-staged-rollout) gives the order, and each stage lists what it needs, the flags to set, what to check and when to move on. Follow it; do not reorder it.

## Steps

1. Agree with the person which stage is next, and that it runs in staging first. Read that stage in DEPLOYING.md section 9.
   - **Staging never emails real people.** Discovery finds real people, so `delivery:enabled` and `replies:send_enabled` stay off in staging ([DEPLOYING.md section 8](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#8-the-command-path-staging-then-production)). Stage 5 (delivery) and the sending half of stage 6 are production-only: skip them in staging, and in staging a released batch comes back blocked, as stage 4 says.
2. Check its **Needs** line before anything else:
   - secrets: the person sets them, never you;
   - adapters enabled in `gtm.config.ts`;
   - the brain components it reads, approved, locked and uploaded;
   - models named and priced in `models.pricing`.
   Run `npx gtm doctor --remote --env staging`. If something is missing, say what, and stop.
3. Run `npx gtm flags list --env staging`. Tell the person each flag you are about to set, then set exactly the stage's flags, one at a time: `npx gtm flags set <key> <value> --env staging`.
4. Tell them what to check and when: the stage's run rows, messages and "before moving on" line, and the job times in [section 13](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#13-reference-scheduled-jobs).
5. Production comes only after the stage ran in staging and the person says so. Your shell has no terminal, so a production write cannot ask for confirmation there: give the person the exact `npx gtm flags set <key> <value>` command to run in their own terminal, where it asks them. Never add `--yes`.

## Never

- Turn on `delivery:enabled` or `replies:send_enabled` in staging, or in production before the [go-live checklist](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#12-go-live-checklist) is done.
- Change an autonomy level. That is the person's, in the operator chat (`autonomy-set`, then `autonomy-confirm`), and the permanently human-only classes never go above level 1 ([AUTONOMY.md](https://github.com/mjohnson518/GTM-agents/blob/main/docs/AUTONOMY.md#permanently-human-only-actions)).
- Turn on several stages at once, or a flag the stage does not name.
- Set `cold_batch:auto_approve`, `inbound:auto_send_tier`, `outreach:ramp_auto` or `outreach:ramp_level`, even when a stage mentions them: they loosen approval or volume, so the person sets them.

To back out, `npx gtm flags unset <key> --env staging` returns a flag to its default (off). The halt flag and the kill switch stop everything ([pausing and rolling back](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#pausing-and-rolling-back)).

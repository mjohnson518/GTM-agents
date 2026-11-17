---
name: read-doctor
description: Run `gtm doctor` on a GTM-agents deployment and explain each FAIL and WARN with its next step. Use when the person asks whether the deployment is ready, why something is not working, or what doctor reported.
---

# Read `gtm doctor`

`gtm doctor` checks the bindings, the cron trigger, `gtm.config.ts`, the adapters, the secrets, the webhooks, the kill switch and every flag. It reads; it never changes anything.

## Steps

1. In the deployment directory, run `npx gtm doctor`. For the deployed state, run `npx gtm doctor --remote --env staging` (or without `--env` for production): it also reads which secrets are set and the stop flags, and checks SPF, DKIM and DMARC on the sending subdomain.
2. Go through FAIL lines first, then WARN. For each, say in one sentence what it means and the one next step, with the section to read:
   - **Bindings, the trigger, placeholders:** [DEPLOYING.md section 1](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#1-what-you-end-up-with). Placeholders WARN until `gtm setup` has filled in `wrangler.jsonc`.
   - **`gtm.config.ts`:** the field and the rule it breaks. [Section 6](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#6-configuration-reference) has every field.
   - **Secrets:** name the missing secret and give the person the command to run in their own terminal: `npx wrangler secret put <NAME> --env staging`. [Section 5](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#5-secrets-reference) says which adapter needs which.
   - **Webhooks:** the person registers them as in [OPERATOR.md](https://github.com/mjohnson518/GTM-agents/blob/main/docs/OPERATOR.md#4-register-the-webhook) and the adapter's section of DEPLOYING.md. The registration command carries the bot token, so the person runs it, not you.
   - **SPF, DKIM, DMARC:** [section 4.2](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#42-the-domain-and-the-sending-subdomain).
   - **Halt flag or kill switch set:** everything that sends is stopped on purpose. Say so, and leave unsetting it to the person ([pausing and rolling back](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#pausing-and-rolling-back)).
   - **Flags:** doctor lists each flag with its state. Point out any flag that is on which the person may not expect.
3. For a symptom doctor does not explain, use [troubleshooting by symptom](https://github.com/mjohnson518/GTM-agents/blob/main/docs/DEPLOYING.md#11-troubleshooting-by-symptom).

## Rules

- Never ask for a secret's value, never print one, and never set one yourself.
- Never silence a FAIL by weakening a check, removing a binding or editing ids into `wrangler.jsonc` by hand. `gtm setup` fills the ids.
- Report what doctor printed, faithfully: a WARN is not a PASS.

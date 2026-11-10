# Quickstart

This page is for someone new to GTM-agents who wants the shortest real path from nothing to a staging deployment whose operator chat answers `/status`. The operator chat is the only thing it turns on: discovery, the cold batch, real sends, the inbox and every other capability stay off. [DEPLOYING.md](DEPLOYING.md) is the full guide; each step below links the section that explains it.

The examples use the fictional company Acme (`acme.example`), a deployment directory called `acme-agent` and the staging host `agent-staging.acme.example`. Replace them with your own.

## 1. What you need

- **A Cloudflare account on the Workers Paid plan.** The Free plan's limits are far below what the scheduled jobs need ([DEPLOYING.md, section 3](DEPLOYING.md#3-before-you-start)).
- **Node 24 or later on macOS or Linux** (on Windows, use WSL).
- **A public https origin for staging**: a custom domain on the same Cloudflare account, or the Worker's `https://<worker>.<your-subdomain>.workers.dev` URL ([4.1](DEPLOYING.md#41-cloudflare)).
- **A Telegram account**, to create the bot you will talk to.
- **An Anthropic API key**, for the agent's model calls.

## 2. Create the deployment

From a published release, where `<version>` is a release listed in the [changelog](../CHANGELOG.md), for example `0.1.0`:

```bash
npx @gtm-agents/cli@<version> init acme-agent   # every @gtm-agents package pinned to that version
cd acme-agent
npm install
```

To use a checkout of this repository instead, run `npx gtm init ../acme-agent --local .` from the checkout, then `npm install` in the new directory ([section 8](DEPLOYING.md#step-1-create-the-deployment)).

`gtm init` names the Worker after the directory (`acme-agent`, and `acme-agent-staging` for staging) and copies `wrangler.jsonc`, `src/index.ts`, `gtm.config.ts`, `brain/` and `templates/` folders that hold only a README each, and the built dashboard. Put the directory under git.

## 3. First edits to `gtm.config.ts`

The schema needs `company`, `agent` and `sending` from the first deploy, even though nothing is sent yet ([section 6](DEPLOYING.md#6-configuration-reference)):

- **`company`**: your name, primary domain, website and product.
- **`agent.name`**: the name the agent signs with.
- **`sending`**: `domain` must be a subdomain of `company.domain` (for example `outreach.acme.example`) and `from.email` must be on it; `replyTo`, `supportAddress` and your real `postalAddress` are required too.
- **`adapters`**: keep `operator-telegram` and `llm-gateway`, and add `enabled: false` to the other eight, so `gtm setup` and `gtm doctor` do not ask for their secrets:

  ```ts
  adapters: {
    "operator-telegram": { options: {} },
    "llm-gateway": { options: {} },
    "data-exa": { enabled: false, options: {} },
    "data-hunter": { enabled: false, options: {} },
    "email-resend": { enabled: false, options: {} },
    "inbox-gmail": { enabled: false, options: {} },
    "email-cloudflare": { enabled: false, options: {} },
    "calendar-google": { enabled: false, options: {} },
    "data-jobboards": { enabled: false, options: {} },
    "billing-stripe": { enabled: false, options: {} },
  },
  ```

- **`models`**: name a `strategist` model and give it a price in `models.pricing`, from your provider's current price list. A model without a price is never called. The template's ids and prices are examples.
- **`operator`**: leave `allowedChatIds` and `allowedUserIds` empty for now; you add your ids in step 7.

Check the file offline:

```bash
npx gtm doctor
```

It should report the bindings, the cron trigger, `gtm.config.ts` and the two adapters as PASS, and exit 0. The placeholders WARN and the webhooks WARN are expected at this point.

## 4. Create the staging resources

Log Wrangler in, then let `gtm setup` create the D1 database, KV namespace, R2 bucket, Vectorize index and queues and write their ids into `wrangler.jsonc` ([step 3](DEPLOYING.md#step-3-create-the-cloudflare-resources)):

```bash
npx wrangler login
npx wrangler whoami                 # the account every gtm command will act on
npx gtm setup --env staging --base-url https://agent-staging.acme.example
```

Setup shows its plan and asks before creating anything. It ends by printing the chat and jobs queue names and the missing secrets. In `src/index.ts`, replace the template's `gtm-agent` queue names with yours (`acme-agent-chat` and `acme-agent-staging-chat` in `agent.chatQueue`, and likewise in `scheduler.jobsQueue`, `scheduler.deadLetterQueue` and `createLifecycle`'s `eventsQueue`).

## 5. Set the secrets

First create a bot for staging: in Telegram, open a chat with @BotFather and send `/newbot`. A bot has one webhook URL, so staging and production each get their own ([4.4](DEPLOYING.md#44-telegram-operator-channel)).

Then set five secrets, each typed at Wrangler's prompt so it never lands in your shell history ([section 5](DEPLOYING.md#5-secrets-reference)). Keep a copy of each in a password manager.

```bash
npx wrangler secret put GATEWAY_TOKEN --env staging             # openssl rand -hex 32
npx wrangler secret put UNSUBSCRIBE_SIGNING_KEY --env staging   # openssl rand -hex 32
npx wrangler secret put TELEGRAM_BOT_TOKEN --env staging        # the token @BotFather sent you
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env staging   # openssl rand -hex 32
npx wrangler secret put ANTHROPIC_API_KEY --env staging         # from the Anthropic Console
```

The first `secret put` offers to create the Worker so it can hold the secret; answer yes.

## 6. Migrate, upload the brain, deploy

```bash
npx gtm migrate --env staging
npx gtm brain validate --write-lock
npx gtm brain upload --env staging
npx gtm deploy --env staging
curl -s https://agent-staging.acme.example/health   # {"ok":true,"service":"gtm-agents"}
```

The chat needs no brain, so locking and uploading the empty one is enough for now. Missing components are warnings, not errors. Before you turn on anything that writes, write your own brain and templates ([section 7](DEPLOYING.md#7-writing-your-brain-and-templates)).

Use `npx gtm deploy`, not `npm run deploy`: it runs `gtm doctor`, checks for placeholders and applies the migrations before `wrangler deploy`.

## 7. Connect the operator chat

1. **Register the bot's webhook**, reading the two values without echoing them:

   ```bash
   read -rs TELEGRAM_BOT_TOKEN          # paste the staging bot's token, press Enter
   read -rs TELEGRAM_WEBHOOK_SECRET     # the value you stored with wrangler secret put
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d url="https://agent-staging.acme.example/api/webhooks/operator" \
     -d secret_token="${TELEGRAM_WEBHOOK_SECRET}" \
     -d 'allowed_updates=["message","callback_query"]'
   ```

2. **Find your ids.** Run `npx wrangler tail --env staging` and send the bot any message. The log line "operator update from a chat that is not allowlisted was ignored" carries your `chatId` and `userId`; in a private chat they are the same number.
3. **Allow yourself in** and give the system a chat for its own messages, in `gtm.config.ts`:

   ```ts
   operator: { allowedChatIds: ["123456789"], allowedUserIds: ["123456789"] },
   adapters: { "operator-telegram": { options: { chatId: "123456789" } }, /* the rest as before */ },
   ```

4. **Redeploy:** `npx gtm deploy --env staging`.

Message the bot again: it now answers that the operator agent is turned off. That is the flag, not a fault ([OPERATOR.md](OPERATOR.md#6-turn-the-agent-on)).

## 8. Turn on the chat and send `/status`

```bash
npx gtm flags set operator:agent_enabled true --env staging
```

Flags live in KV, so allow up to a minute. Then send `/status` to the bot. It answers without calling a model:

```
Session taint: none
Messages in history: 0
Drafts waiting for approval: 0
Chat spend today: $0.00
Strategist model: <your strategist model>
```

`/help` lists every command. `npx gtm flags unset operator:agent_enabled --env staging` turns the chat off again.

## 9. Check it with `gtm doctor`

```bash
npx gtm doctor --remote --env staging
```

Expect PASS for the bindings, the cron trigger, the jobs queue, the placeholders, `gtm.config.ts`, both adapters, the secrets ("all 5 required secrets are set"), the footer and unsubscribe, and the halt flag and both kill-switch keys ("is unset"). One WARN stays while the operator adapter is enabled, because doctor cannot see Telegram: the reminder to register its webhook. Doctor also prints every flag with its default; `npx gtm flags list --env staging` shows the deployed values.

Every minute the cron trigger runs the jobs that are due, and with their flags off each leaves a `skipped` run row with the summary `flag off` ([step 6](DEPLOYING.md#step-6-verify)).

## Where next

Turn on one capability at a time, in staging first, following [DEPLOYING.md's staged rollout](DEPLOYING.md#9-staged-rollout):

- [Stage 2: discovery](DEPLOYING.md#stage-2-discovery), once your brain has approved `personas`, `icp` and `keyword-portfolio`.
- [Stage 3: the inbox](DEPLOYING.md#stage-3-the-inbox), before any mail goes out, so the first send already has its replies recorded.
- [Stage 4: the cold batch, released by hand](DEPLOYING.md#stage-4-the-cold-batch-released-by-hand).
- [Stage 5: delivery](DEPLOYING.md#stage-5-delivery), after the [go-live checklist](DEPLOYING.md#12-go-live-checklist) in production.
- [Stage 6: replies](DEPLOYING.md#stage-6-replies) and [stage 7: follow-ups](DEPLOYING.md#stage-7-follow-ups).
- [Stage 8: reports](DEPLOYING.md#stage-8-reports), which need only the operator chat and can come as early as now.
- [Stage 9: meetings](DEPLOYING.md#stage-9-meetings), [stage 10: lifecycle](DEPLOYING.md#stage-10-lifecycle) and [stage 11: earned autonomy](DEPLOYING.md#stage-11-earned-autonomy).

When staging has run each stage you need, repeat steps 4 to 9 without `--env staging` for [production](DEPLOYING.md#production).

# Deploying

This page is for anyone deploying GTM-agents to sell their own product: it takes you, alone, from an empty Cloudflare account to a verified production deployment, then shows how to turn capabilities on one at a time, operate the system day to day, and fix it when something is wrong. It is the single path through the setup; the per-topic pages linked from each section go deeper. Contributors changing the commands themselves should read [packages/cli/README.md](../packages/cli/README.md).

Nothing acts on the world when you first deploy. Every capability (the chat agent, discovery, the cold batch, real sends, the inbox, replies, follow-ups and reports) sits behind a flag that defaults to off, and you turn each one on yourself.

The examples use the fictional company Acme (`acme.example`), a deployment directory called `acme-agent`, and the hosts `agent.acme.example` (production) and `agent-staging.acme.example` (staging). Replace them with your own.

## Contents

1. [What you end up with](#1-what-you-end-up-with)
2. [Requirements by capability](#2-requirements-by-capability)
3. [Before you start](#3-before-you-start)
4. [Provider setup](#4-provider-setup)
5. [Secrets reference](#5-secrets-reference)
6. [Configuration reference](#6-configuration-reference)
7. [Writing your brain and templates](#7-writing-your-brain-and-templates)
8. [The command path: staging, then production](#8-the-command-path-staging-then-production)
9. [Staged rollout](#9-staged-rollout)
10. [Operating it](#10-operating-it)
11. [Troubleshooting by symptom](#11-troubleshooting-by-symptom)
12. [Go-live checklist](#12-go-live-checklist)
13. [Reference: scheduled jobs](#13-reference-scheduled-jobs)

## 1. What you end up with

One Cloudflare Worker per environment (production and staging), each with its own resources, flags, brain and data:

```
 Telegram (operator chat)   Resend (delivery events)   Gmail push (Pub/Sub)   your browser
          |                          |                         |                    |
 POST /api/webhooks/operator  POST /api/webhooks/email  POST /api/webhooks/mail  GET /admin, /health
          \__________________________|_________________________|____________________/
                                     |
   Email Routing --> email() --> [ one Worker ] <-- cron "* * * * *" (runs the jobs due that minute)
                                     |
   D1 (DB)  KV  R2 (BUCKET)  Vectorize (MEMORY)  Workers AI (AI)  Queues  Durable Objects  ASSETS
                                     |
   outbound: Anthropic (models)  Exa (search)  Hunter (finder, verifier)  Resend (cold and follow-up mail)
             Gmail API (inbox, reply drafts, reply sends)  Telegram Bot API (messages, approvals, pages)
```

### Bindings

`gtm doctor` fails unless every one of these is declared in `wrangler.jsonc`. `gtm setup` creates the resources and fills their ids in.

| Binding | Cloudflare product | Name `gtm setup` gives it | Used for |
|---|---|---|---|
| `DB` | D1 | `<worker>-db` | The system of record: contacts, drafts, the send ledger, run rows, costs, suppression |
| `KV` | Workers KV | `<worker>-kv` | Flags, the halt flag and kill switch, counters, the approved brain and templates |
| `BUCKET` | R2 | the `bucket_name` in the file (`<worker>-bucket` after `gtm init`) | Inbound mail bodies and other payload archives |
| `MEMORY` | Vectorize | `<worker>-memory` | Long-term memory (1536 dimensions, cosine, unless you choose otherwise at setup) |
| `AI` | Workers AI | (no resource) | Embeddings and small classifiers |
| `GATEWAY` | Durable Object `OperatorGateway` | (declared in the file) | The dashboard's WebSocket connection |
| `FOLLOWUP_AGENT` | Durable Object `FollowupAgent` | (declared in the file) | Per-contact lifecycle timers |
| `EVENTS_QUEUE` | Queue | `<worker>-events`, with `<worker>-events-dlq` as its dead-letter queue | The event spine |
| `CHAT_QUEUE` | Queue | `<worker>-chat` | Operator chat turns, moved off the webhook path |
| `ASSETS` | Static assets | (the `public/` folder) | The admin dashboard at `/admin` |

`<worker>` is the environment's Worker name: `acme-agent` for production and `acme-agent-staging` for staging. `MEMORY`, `AI`, `EVENTS_QUEUE` and the two Durable Objects are bound now so later capabilities need no new resources; the capabilities in this guide barely touch them, so they add little or nothing to your bill today. [ARCHITECTURE.md](ARCHITECTURE.md#bindings) describes each binding.

### The trigger

The Worker has exactly one cron trigger, `* * * * *`. Every minute the scheduled handler works out which registered jobs have a schedule matching that minute (in UTC, with named days such as `MON-FRI`) and runs them, four at a time, longest ceiling first, each under its own duration ceiling. A job whose ceiling would not finish within the invocation's 14-minute budget is not started: if its halt and flag checks pass, it gets a failed run row ("job <name> was not started: its ... ceiling would run past this invocation's time limit") and a page. A minute with nothing due touches no binding. Every due job leaves a row in `execution_runs`, including the ones held because the system is halted, their flag is off or their budget is spent. Adding a job never means adding a trigger; an extra trigger would run the jobs due in its minutes a second time, and `gtm doctor` fails on it. [Section 13](#13-reference-scheduled-jobs) lists every job.

### The providers

| Adapter | Port | What it does | Needed for |
|---|---|---|---|
| `operator-telegram` | OperatorChannel | Your chat with the agent: commands, approvals, release codes, pages | Everything you operate |
| `llm-gateway` | ModelGateway | Anthropic model calls, optionally through Cloudflare AI Gateway | Chat, fit scoring, the reviewer, reply triage and drafting |
| `data-exa` | DiscoverySource | Account and people search | Sourcing |
| `data-hunter` | ContactFinder, EmailVerifier, PeopleProvider | Finding and verifying work email addresses | Sourcing |
| `email-resend` | EmailProvider | Sending cold and follow-up mail, delivery and bounce webhooks | Delivery |
| `inbox-gmail` | InboxProvider | Reading the reply mailbox, mirroring reply drafts, sending approved replies | Inbox and replies |
| `email-cloudflare` | InboxProvider (receive only) | Mail that Cloudflare Email Routing delivers to the Worker | Inbox, as an alternative to Gmail |

Each adapter's `manifest.json` in [packages/adapters](../packages/adapters/) lists its secrets, flags and cost table.

## 2. Requirements by capability

Start with the foundation and the operator chat, then add one capability at a time. Each row lists only what that capability adds.

| Capability | Depends on | Accounts | Secrets | `gtm.config.ts`, brain, templates | Flags | DNS and webhooks | Cost drivers |
|---|---|---|---|---|---|---|---|
| **Foundation** | | Cloudflare on Workers Paid | `GATEWAY_TOKEN`, `UNSUBSCRIBE_SIGNING_KEY` | `company`, `agent`, `sending` (all required by the schema from the first deploy) | none | A hostname for `AGENT_BASE_URL` (a custom domain, or the Worker's workers.dev URL) | About 1,440 Worker invocations and 2,400 run rows a day with everything off |
| **Operator chat** | Foundation | Telegram, Anthropic | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY` (`AI_GATEWAY_TOKEN` optional) | `adapters` `operator-telegram` (with `options.chatId`) and `llm-gateway`; `models.roles.strategist` and its price; `operator.allowedChatIds` and `allowedUserIds` | `operator:agent_enabled` | Register the bot's webhook at `/api/webhooks/operator` | Model calls per chat turn (capped by `chat:turn_max_cents`) |
| **Sourcing** | Operator chat | Exa, Hunter | `EXA_API_KEY`, `HUNTER_API_KEY` | `adapters` `data-exa`, `data-hunter`; brain `personas`, `icp`, `keyword-portfolio`; `models.roles.classifier` and its price for the optional fit score | `discovery:enabled`; optional `fit:prescore_enabled`, `fit:scoring_enabled` | none | Searches, people lookups, email finds and verifications (job cap 300 cents a day); fit scoring model calls (100 cents a day) |
| **Inbox** | Operator chat | Google Cloud and a Gmail or Workspace mailbox, or Cloudflare Email Routing | Gmail: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`; for push `MAIL_PUSH_SECRET` and the topic (`GMAIL_PUBSUB_TOPIC` or an option). Email Routing: none | `sending.replyTo` is the watched mailbox; `adapters` `inbox-gmail` (`options.address`, `options.pubsubTopic`) or `email-cloudflare` | `inbox:enabled`; `sequences:reply_intake` set to `routed` for Email Routing only | Gmail push: a Pub/Sub push subscription to `/api/webhooks/mail`. Email Routing: MX records on a domain or subdomain on Cloudflare DNS, and a rule sending to the Worker | `inbox_poll` runs every minute (about 1,440 run rows a day); Pub/Sub messages; no model calls |
| **Cold outreach** (the daily batch) | Sourcing, operator chat (releases arrive as chat commands); inbox recommended | none | none | Approved `cold_intro` templates; brain `icp`, `voice`, `facts`, `message-pillars`; `models.roles.judge` and its price for the optional reviewer | `cold_batch:enabled`; optional `quality:model_review_enabled` | none | One reviewer call per batch when the reviewer is on (50 cents a day) |
| **Delivery** | Cold outreach | Resend, a domain you control | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | `sending.from` on `sending.domain`; `adapters` `email-resend` (`options.usdPerEmail`) | `delivery:enabled`; `outreach:ramp_level`; later `outreach:ramp_auto` | SPF, DKIM, DMARC and return-path records on the sending subdomain; the Resend webhook at `/api/webhooks/email` | Per email sent, bounded by the warm-up ramp and `delivery:domain_daily_cap` |
| **Replies** | Inbox; delivery for sending | none | none | `models.roles.triage` and `writer` with prices; brain `facts`, `objections`, `competitors`, `voice`, `stack`, `personas` | `replies:triage_enabled`, `replies:reminders_enabled`, `replies:drafting_enabled`, `replies:mirror_enabled`, `replies:send_enabled` | none | Triage and drafting model calls (100 cents a day for the triage job) |
| **Follow-ups** | Delivery, inbox recording, operator chat | none | none | Approved `follow_up` (step 2) and `breakup` (step 3) templates; `sequences.cold` | `sequences:enabled`; `sequences:reply_intake`; optional `followup:manual_channel_enabled` | none | Emails sent; one reviewer call per template per sweep when the reviewer is on (25 cents a day) |
| **Reports** | Operator chat | none | none | none | `ops:daily_scorecard`, `ops:funnel_digest`, `ops:cost_digest` | none | None: no model calls, no spend |
| **Lifecycle** (product events and billing) | Operator chat | Your product (the host application), and a billing provider adapter if you want billing events | `PRODUCT_WEBHOOK_SECRET`; `PRODUCT_READ_SECRET` for the pull; the billing adapter's own secrets | `PRODUCT_APP_URL`; in `src/index.ts`, `createLifecycle` with your events queue names and, when you have one, `billing` | `lifecycle:enabled`; optional `lifecycle:reconcile_enabled`, `billing:enabled`; `outreach:ref_tokens_enabled` for attribution tokens | Your host posts to `/api/webhooks/product`; your billing provider to `/api/webhooks/billing` | Event sweeps every 5 minutes, hourly lifecycle checks, a nightly pull of at most 1,800 rows; no model calls |
| **Meetings** (calendar sync) | Operator chat; inbox and delivery recommended | Google Cloud and the operator's Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (shared with the inbox), `GOOGLE_CALENDAR_REFRESH_TOKEN` | `adapters` `calendar-google` | `convert:calendar_enabled`; optional `convert:post_demo_enabled`, `convert:handoff_enabled` | none | `calendar_sync` every 15 minutes; no model calls, no spend |

The cents figures are each job's default daily spend cap in this toolkit, always enforced; they are not vendor prices.

**Adding capabilities one at a time.** The template's `gtm.config.ts` enables all eight adapters, and `src/index.ts` wires all of them. An adapter's `enabled` setting decides only which secrets `gtm setup` and `gtm doctor` ask for; its flags decide whether anything uses it. So, to start with only the chat, set `enabled: false` on the adapters you have not set up yet:

```ts
adapters: {
  "operator-telegram": { options: { chatId: "123456789" } },
  "llm-gateway": { options: {} },
  "data-exa": { enabled: false, options: {} },
  "data-hunter": { enabled: false, options: {} },
  "email-resend": { enabled: false, options: {} },
  "inbox-gmail": { enabled: false, options: {} },
  "email-cloudflare": { enabled: false, options: {} },
  "calendar-google": { enabled: false, options: {} },
},
```

Remove `enabled: false` from each adapter as you reach its stage, set its secrets, then turn its flags on.

## 3. Before you start

- **Cloudflare on the Workers Paid plan.** The Free plan's CPU, subrequest and KV write limits are far below what the scheduled jobs and the send path need. Upgrade the account before you run `gtm setup`. The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/) pages have the current numbers.
- **Node 24 or later on macOS or Linux** (on Windows, use WSL), and git.
- **The packages, from npm or from a checkout.** From a published release, `npx @gtm-agents/cli@<version> init <dir>` creates a deployment that installs every package from npm at exactly that version. For code that is not released yet, use a checkout of this repository and `gtm init --local <checkout>`; pin the checkout to a release or commit you have reviewed (`git checkout <tag-or-commit>`), because your deployment links to it. [RELEASING.md](RELEASING.md) explains how releases are published.
- **A domain you control.** Cold mail goes out from an isolated sending subdomain (for example `outreach.acme.example`), replies come back to a mailbox on your domain, and the Worker needs a stable public https origin for unsubscribe links and webhooks.
- **Accounts for the providers you will enable** ([section 4](#4-provider-setup)). You can deploy with only Cloudflare, Telegram and Anthropic, and add the rest later.
- **A password manager** for the secrets you generate. Cloudflare never shows a secret again once it is set.

## 4. Provider setup

Vendor dashboards change; each step below says what you need and why, not where to click. Each vendor's own documentation, linked by its top-level URL, has the current screens. This guide never quotes vendor prices: check each vendor's pricing page and set the matching option so the cost ledger records what you actually pay.

### 4.1 Cloudflare

1. Put the account on Workers Paid.
2. Log Wrangler in and check which account it uses:

   ```bash
   npx wrangler login
   npx wrangler whoami        # prints the account names and ids your login can reach
   ```

   Every `gtm` command that talks to Cloudflare runs your deployment's own Wrangler with this login, without prompting. If your login reaches several accounts, set `account_id` at the top of `wrangler.jsonc`, or `export CLOUDFLARE_ACCOUNT_ID=<account-id>`, so every command acts on the right one. In CI, use an API token (`CLOUDFLARE_API_TOKEN`) whose permissions cover Workers, D1, KV, R2, Vectorize and Queues for that account.
3. **Choose each environment's public origin**, which becomes `AGENT_BASE_URL`:
   - **A custom domain** (recommended for production, because unsubscribe links in sent mail point at it forever): the zone must be in the same Cloudflare account. Add a route to each environment's block in `wrangler.jsonc`, for example `"routes": [{ "pattern": "agent.acme.example", "custom_domain": true }]` at the top level and `agent-staging.acme.example` under `env.staging`.
   - **The workers.dev URL**: `https://<worker>.<your-subdomain>.workers.dev`, where your account's workers.dev subdomain is shown in the dashboard's Workers section. Wrangler also prints the URL after a deploy.

[Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)

### 4.2 The domain and the sending subdomain

Cold mail goes from an isolated subdomain (`sending.domain`), never your primary domain, so a deliverability problem cannot hurt the mail your team sends every day. `gtm.config.ts` refuses a `sending.domain` that is not a subdomain of `company.domain`, and a `sending.from` address that is not on `sending.domain`. Replies go to `sending.replyTo`, a real mailbox, usually on the primary domain.

At your DNS host, for the sending subdomain (for example `outreach.acme.example`):

| Record | What to add |
|---|---|
| **SPF** | The TXT record your email provider gives you, authorizing it to send for the subdomain |
| **DKIM** | The CNAME or TXT records your email provider gives you, so receivers can verify the signature |
| **Return-path (bounce domain)** | The MX and TXT records your email provider asks for, if it uses a custom return-path, so bounces reach it and SPF aligns |
| **DMARC** | A TXT record at `_dmarc.outreach.acme.example`, for example `v=DMARC1; p=none; rua=mailto:dmarc@acme.example`. Start with `p=none` and move to `p=quarantine` once the reports look clean |

Copy each record exactly as the provider shows it. If the domain's DNS is on Cloudflare, set these records to DNS only (not proxied). Check them from a terminal before you verify the domain with the provider:

```bash
dig TXT outreach.acme.example +short
dig TXT _dmarc.outreach.acme.example +short
```

Warm the domain up slowly: the warm-up ramp ([section 9](#the-warm-up-ramp)) does that for you. [SENDING.md](SENDING.md) covers the domain, the footer and unsubscribe in depth.

### 4.3 Resend (email provider)

1. Create an account and add the sending subdomain as a domain. Add the DNS records it lists ([4.2](#42-the-domain-and-the-sending-subdomain)) and wait until it shows the domain as verified.
2. Create an API key with sending access (restrict it to sending, or to this domain, if Resend offers that). Store it as `RESEND_API_KEY`.
3. Add a webhook endpoint at `https://<your host>/api/webhooks/email` for the events `email.delivered`, `email.bounced`, `email.complained`, `email.failed` and, if offered, `email.suppressed`. Opens and clicks are ignored, because mail is plain text with no tracking. Copy the endpoint's signing secret (it starts with `whsec_`) into `RESEND_WEBHOOK_SECRET`. Each environment needs its own endpoint and secret.
4. Set `adapters["email-resend"].options.usdPerEmail` to your plan's price per email, so the cost ledger is right; unset, the adapter assumes a built-in default.
5. Check the endpoint without sending anything: an unsigned request must be refused with 401. A 503 means the secret is unset or is not a valid signing secret.

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://agent-staging.acme.example/api/webhooks/email -d '{}'
   ```

[Resend documentation](https://resend.com/docs)

### 4.4 Telegram (operator channel)

1. **Create one bot per environment.** A bot has one webhook URL, so staging and production each need their own. In Telegram, open a chat with @BotFather, send `/newbot`, and pick a name and a username. BotFather answers with the bot token; store it as `TELEGRAM_BOT_TOKEN`. Optionally keep privacy mode on (`/setprivacy`), so in groups the bot only sees messages addressed to it.
2. **Generate a webhook secret** of letters, digits, underscores and hyphens, up to 256 characters (`openssl rand -hex 32` qualifies) and store it as `TELEGRAM_WEBHOOK_SECRET`.
3. **Register the webhook after the first deploy** ([section 8](#8-the-command-path-staging-then-production)). Read the values into your shell without echoing them, so they stay out of your history:

   ```bash
   read -rs TELEGRAM_BOT_TOKEN          # paste the token, press Enter
   read -rs TELEGRAM_WEBHOOK_SECRET     # the same value you stored with wrangler secret put
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d url="https://agent-staging.acme.example/api/webhooks/operator" \
     -d secret_token="${TELEGRAM_WEBHOOK_SECRET}" \
     -d 'allowed_updates=["message","callback_query"]'
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
   ```

   `getWebhookInfo` shows the registered URL and, when Telegram cannot deliver, its last error. No `gtm` command does this for you, because the CLI never reads your secrets.
4. **Find your chat id and user id.** Send the bot any message, and watch the Worker's logs with `npx wrangler tail --env staging`. An update from a chat that is not allowlisted is logged as "operator update from a chat that is not allowlisted was ignored", with its `chatId` and `userId`, and gets no answer. In a private chat the two are the same number, and they are the same for every bot you talk to, so one allowlist serves staging and production. (Before a webhook is registered, the Bot API's `getUpdates` method returns the same ids.) In a group, the chat id is the group's (a negative number) and each person who may command the agent needs their own user id listed.
5. **Put the ids in `gtm.config.ts`** and redeploy:

   ```ts
   operator: { allowedChatIds: ["123456789"], allowedUserIds: ["123456789"] },
   adapters: { "operator-telegram": { options: { chatId: "123456789" } }, /* ... */ },
   ```

   Both lists must hold an entry, or nobody is served. `options.chatId` is where every message the system sends on its own goes: job failure pages, cron health pages, the cold batch's release message, follow-up releases and delivery alerts. Without it those messages fail ("no chat to deliver to"). Reports and every reply message (approvals, reminders, mirror notices) go to the first entry of `allowedChatIds` unless their job options name another chat.

[OPERATOR.md](OPERATOR.md) covers commands, approvals, sessions and taint. [Telegram Bot API](https://core.telegram.org/bots/api)

### 4.5 Anthropic (models)

1. In the Anthropic Console, create an API key for each environment and store it as `ANTHROPIC_API_KEY`. Use the provider's own spend controls as a second fence behind the toolkit's budgets.
2. In `gtm.config.ts`, name a model for each role you will use (`models.roles`) and price each named model (`models.pricing`, in US cents per million input and output tokens, from the provider's current price list). **A model without a price is never called,** because its cost could not be recorded. The template's model ids and prices are examples: check the provider's model list and pricing page and replace both.

   | Role | Used by | Needed from |
   |---|---|---|
   | `strategist` | The operator chat agent | Stage 1 |
   | `classifier` | The optional account fit score | Stage 2, if you turn on `fit:scoring_enabled` |
   | `judge` | The optional model reviewer for cold drafts and follow-ups | When you turn on `quality:model_review_enabled` |
   | `triage`, `writer` | Reply triage and reply drafts | Stage 6 |

   `worker`, `coder` and `embedding` are reserved for later capabilities.
3. Optional: route calls through Cloudflare AI Gateway with `adapters["llm-gateway"].options.aiGatewayBaseUrl` (the gateway's provider URL ending in `/anthropic`), plus `AI_GATEWAY_TOKEN` for an authenticated gateway, and `byok: true` to let the gateway supply its stored provider key. The adapter's other options are listed in [section 6](#adapter-options).

[Anthropic Console](https://console.anthropic.com/), [pricing](https://www.anthropic.com/pricing)

### 4.6 Exa and Hunter (sourcing)

- **Exa** searches for accounts and people. Create an API key in its dashboard and store it as `EXA_API_KEY`. The adapter records the cost the API reports with each search, or estimates it from its manifest's table; check Exa's pricing page and set the discovery cap to match. [Exa](https://exa.ai/)
- **Hunter** finds and verifies work email addresses and lists people at a domain. Create an API key and store it as `HUNTER_API_KEY`. Set `adapters["data-hunter"].options.usdPerCredit` to your plan's price per credit (unset, a built-in default is assumed); the adapter records credits per call and multiplies. [Hunter](https://hunter.io/)

[SOURCING.md](SOURCING.md) explains the discovery cycle, the waterfall and the budget.

### 4.7 Google (the Gmail inbox)

The `inbox-gmail` adapter reads the reply mailbox, mirrors reply drafts into it and sends approved replies from it, through the Gmail API with OAuth. Use a mailbox dedicated to the agent (for example `avery@acme.example`): intake records every message the mailbox receives, not only replies to cold mail. Use a separate test mailbox for staging.

1. **Create a Google Cloud project** in the [Google Cloud console](https://console.cloud.google.com/) and enable the **Gmail API** and the **Cloud Pub/Sub API** in it.
2. **Configure the OAuth consent screen.** For a Google Workspace mailbox, choose the Internal user type. An External app left in testing status issues refresh tokens that expire after 7 days, which silently stops intake a week later; publish it, or use Internal.
3. **Create an OAuth client** of type Web application. Keep its client id and secret: they become `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. If you will use the OAuth 2.0 Playground in the next step, add `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. **Generate a refresh token** for the mailbox with exactly one scope, `https://www.googleapis.com/auth/gmail.modify`, which covers reading, drafts, sending and push registration. Ask for offline access and consent (`access_type=offline`, `prompt=consent`) so Google returns a refresh token. With the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground): in its settings, choose to use your own OAuth credentials and enter the client id and secret; authorize the scope while signed in as the mailbox; exchange the authorization code for tokens; copy the refresh token into `GMAIL_REFRESH_TOKEN`.
5. **Tell the adapter its own address** and point replies at it:

   ```ts
   sending: { replyTo: "avery@acme.example", /* ... */ },
   adapters: { "inbox-gmail": { options: { address: "avery@acme.example" } }, /* ... */ },
   ```

6. **Set up push (optional, but it brings detection under a minute).** Without it, the per-minute poll detects mail within a couple of minutes.
   - Create a Pub/Sub topic in the same project, for example `projects/<project-id>/topics/gmail-push`.
   - Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic.
   - Generate a long random value (`openssl rand -hex 32`) and store it as `MAIL_PUSH_SECRET`.
   - Create a push subscription on the topic whose endpoint is `https://agent.acme.example/api/webhooks/mail?token=<MAIL_PUSH_SECRET>`, with your host and the value itself.
   - Name the topic in `adapters["inbox-gmail"].options.pubsubTopic`, or store it as `GMAIL_PUBSUB_TOPIC`.

   The `inbox_watch_renewal` job registers the watch with Gmail each day at 06:20 UTC once `inbox:enabled` is on, and renews it before Gmail's 7-day expiry, so push starts after its first run. Its run row says "push not configured" when no topic is set.

[INBOX.md](INBOX.md) covers detection, classification and what each class does. [Gmail push notifications](https://developers.google.com/gmail/api/guides/push)

### 4.8 Cloudflare Email Routing (the alternative inbox)

The `email-cloudflare` adapter receives mail that Email Routing delivers to the Worker's `email()` entry point, and records it within seconds. It only receives: it cannot list mail, read threads, mirror drafts or send replies, so you answer replies from your own mail client, referrals add nobody, and reply drafts are not mirrored.

1. The domain must use Cloudflare DNS. **Email Routing takes over the MX records** of the domain or subdomain it is enabled on, so if your team's mail already runs on `acme.example` through another provider, enable it on a subdomain instead (for example `replies.acme.example`).
2. Create a routing rule for the watched address (for example `avery@replies.acme.example`) with the action that sends to a Worker, and choose the environment's Worker. Use a different address for staging.
3. Set `sending.replyTo` to that address.
4. Optionally keep a human copy: add a verified destination address in Email Routing and pass it as `forwardTo` in `src/index.ts` (`inboundEmail: { parser, forwardTo: "avery@acme.example" }`). Every message is forwarded there first.
5. **Do not route mail to the Worker before `inbox:enabled` is on** unless `forwardTo` is set: with the flag off, routed mail that was not forwarded is rejected, so the sender gets a bounce.
6. If Email Routing is your only inbox, edit `src/index.ts`: remove the Gmail `inbox` factory from `createWorker`, `createInboxJobs` and `createReplyJobs` (otherwise the poll calls Gmail without credentials and fails every minute), keep `inboundEmail`, set `inbox-gmail` to `enabled: false`, and later set `sequences:reply_intake` to `routed`.

Adapter options: `ownAddresses` (addresses whose mail counts as the deployment's own) and `maxBytes` (default 25 MiB). [Cloudflare Email Service documentation](https://developers.cloudflare.com/email-service/)

### 4.9 Google Calendar (meetings)

Calendar sync reads the operator's primary calendar, read-only, and asks only for event ids, status, times, attendees (address, whether it is you, response) and the organizer, never titles or descriptions.

1. In the same Google Cloud project and OAuth client as the inbox, add the read-only calendar scope to the consent screen: `calendar.events.owned.readonly`, the narrowest one that lists the primary calendar's events (`calendar.events.readonly` also works).
2. Grant it and obtain a refresh token. A refresh token carries every scope its grant included, so one grant with both the Gmail and the calendar scope can serve both secrets; or make a separate grant for the calendar.
3. Set `GOOGLE_CALENDAR_REFRESH_TOKEN` (and `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` if the inbox has not already).

[CONVERT.md](CONVERT.md) covers how a meeting is detected and attributed, what a booking does, and the post-meeting drafts. [Google Calendar API](https://developers.google.com/calendar/api)

## 5. Secrets reference

Set every secret with Wrangler, from the deployment directory. Wrangler prompts for the value, so it never lands in your shell history or a file, and no `gtm` command ever reads or prints one:

```bash
npx wrangler secret put <NAME> --env staging    # staging
npx wrangler secret put <NAME>                  # production
```

Before the first deploy, Wrangler offers to create the Worker so it can hold the secret; answer yes. For `wrangler dev`, put local values in `.dev.vars` (gitignored; `.dev.vars.example` lists the core names).

| Secret | Needed by | Required | Where it comes from | When it is unset |
|---|---|---|---|---|
| `GATEWAY_TOKEN` | Core: bearer token for every `/api/*` route except webhooks | Yes | Generate: `openssl rand -hex 32` | `/api/*` answers 503 |
| `UNSUBSCRIBE_SIGNING_KEY` | Core: signs one-click unsubscribe links | Yes | Generate, at least 32 characters: `openssl rand -hex 32` | Nothing is sent (`[SEND BLOCKED:not_configured]`) and `/u/` answers 503. Rotating it invalidates links already sent |
| `PRODUCT_WEBHOOK_SECRET` | Core: verifies product events from your host application ([EVENT-CONTRACT.md](EVENT-CONTRACT.md)) | For lifecycle | Generate; share with your host application | `/api/webhooks/product` answers 503 |
| `PRODUCT_READ_SECRET` | Core: signs reconciliation reads to your host application | For the nightly pull | Generate; share with your host application | The pull refuses to run; pushes still work |
| `TELEGRAM_BOT_TOKEN` | `operator-telegram` | Yes, when enabled | @BotFather | Replies and pages fail; updates are still verified |
| `TELEGRAM_WEBHOOK_SECRET` | `operator-telegram` | Yes, when enabled | Generate: letters, digits, `_` and `-`, up to 256 characters | `/api/webhooks/operator` answers 503 |
| `ANTHROPIC_API_KEY` | `llm-gateway` | Yes, when enabled | Anthropic Console | Model calls fail with an auth error; chat commands still work |
| `AI_GATEWAY_TOKEN` | `llm-gateway` | No | Cloudflare AI Gateway, for an authenticated gateway | Calls go through the gateway unauthenticated, or directly |
| `EXA_API_KEY` | `data-exa` | Yes, when enabled | Exa dashboard | The discovery cycle's searches fail |
| `HUNTER_API_KEY` | `data-hunter` | Yes, when enabled | Hunter dashboard | Lookups and verifications fail |
| `RESEND_API_KEY` | `email-resend` | Yes, when enabled | Resend: a key with sending access | Every message fails with an auth error before reaching Resend, and is not retried |
| `RESEND_WEBHOOK_SECRET` | `email-resend` | Yes, when enabled | Resend: the webhook endpoint's signing secret (`whsec_...`) | `/api/webhooks/email` answers 503 |
| `GOOGLE_CLIENT_ID` | `inbox-gmail` | Yes, when enabled | Google Cloud: the OAuth client | The poll and sweep fail with an auth error |
| `GOOGLE_CLIENT_SECRET` | `inbox-gmail` | Yes, when enabled | Google Cloud: the OAuth client | As above |
| `GMAIL_REFRESH_TOKEN` | `inbox-gmail` | Yes, when enabled | The OAuth grant with the `gmail.modify` scope | As above |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | `calendar-google` | Yes, when enabled | The OAuth grant with a read-only calendar scope (it can be the same grant as the inbox's) | Calendar sync fails with an auth error; nothing else is affected |
| `GMAIL_PUBSUB_TOPIC` | `inbox-gmail` | No | `projects/<project-id>/topics/<topic>`; or use the `pubsubTopic` option instead | No push; the poll still detects mail |
| `MAIL_PUSH_SECRET` | `inbox-gmail` push, `/api/webhooks/mail` | No (needed for push) | Generate: `openssl rand -hex 32`; also goes in the push subscription's endpoint | `/api/webhooks/mail` answers 503 |

`email-cloudflare` needs no secret. "Required, when enabled" means `gtm setup` and `gtm doctor` ask for it while the adapter is enabled in `gtm.config.ts`; `gtm doctor --remote` fails until each required secret is set, and `gtm setup` ends by printing one `npx wrangler secret put` line per missing secret.

These are vars, not secrets, set in `wrangler.jsonc`:

| Var | What it holds |
|---|---|
| `AGENT_BASE_URL` | The environment's public https origin, used in unsubscribe links. `gtm setup --base-url` fills it; `gtm deploy` refuses to run while it is still a placeholder |
| `ENVIRONMENT` | `production` or `staging`, set by the template |
| `PRODUCT_APP_URL` | Optional: your product's app URL (https). Links to its host pass the quality gate's link check, and the nightly pull reads from it |

## 6. Configuration reference

`gtm.config.ts` holds everything about your company that is not a secret: who you are, how you send, which adapters run, which models play which role, and who may command the agent. It is validated when the Worker starts and whenever a `gtm` command loads it, so a typo fails loudly instead of silently changing behavior. One file serves both environments. The schema is [packages/core/src/config/schema.ts](../packages/core/src/config/schema.ts); the examples below come from [apps/worker/gtm.config.ts](../apps/worker/gtm.config.ts).

| Field | Required | What it controls | Example |
|---|---|---|---|
| `company.name` | Yes | Your company's name in prompts, the unsubscribe page and claims checks (1 to 120 characters) | `"Acme"` |
| `company.domain` | Yes | Your primary domain, lowercase, no scheme. Mail from it counts as your own; links to it pass the link check | `"acme.example"` |
| `company.url` | Yes | Your website, https only. Its host passes the link check | `"https://acme.example"` |
| `company.product.name` | Yes | The product you sell (1 to 120 characters) | `"Acme Quarantine"` |
| `company.product.description` | Yes | One or two sentences the triage model and the reviewer read (1 to 500 characters) | `"Detects flaky tests in CI and quarantines them automatically, ..."` |
| `agent.name` | Yes | The name the agent signs with and introduces itself by (`{{sender_name}}`) | `"Avery"` |
| `sending.from` | Yes | The cold sender, `{ email, name? }`. The address must be on `sending.domain` | `{ email: "avery@outreach.acme.example", name: "Avery at Acme" }` |
| `sending.domain` | Yes | The isolated sending subdomain. Must be a subdomain of `company.domain` | `"outreach.acme.example"` |
| `sending.replyTo` | Yes | The real mailbox replies go to: the one the inbox watches | `"avery@acme.example"` |
| `sending.supportAddress` | Yes | Your support address; mail from it counts as your own | `"support@acme.example"` |
| `sending.postalAddress` | Yes | Appended to every cold and follow-up email with the unsubscribe line (10 to 300 characters) | `"Acme Inc., 100 Example Street, Springfield, EX 00000"` |
| `sending.windowDays` | No | Days cold and follow-up mail may go out, in the recipient's time zone. Default Monday to Thursday | `["MON", "TUE", "WED", "THU"]` |
| `sending.windowHours` | No | Recipient-local hours, start inclusive, end exclusive. Default 8 to 15 | `{ start: 8, end: 15 }` |
| `sending.bookingUrl` | No | Your booking link: the `{{booking_url}}` template variable, an allowed link in follow-ups, and offered in reply drafts; https only | `"https://acme.example/book"` |
| `adapters.<name>.enabled` | No | Whether `gtm setup` and `gtm doctor` load the adapter's manifest and ask for its secrets. Default `true` | `"data-exa": { enabled: false, options: {} }` |
| `adapters.<name>.options` | No | The adapter's non-secret options ([below](#adapter-options)) | `"inbox-gmail": { options: { address: "avery@acme.example" } }` |
| `models.roles` | No | The model id per role: `strategist`, `worker`, `writer`, `judge`, `triage`, `classifier`, `coder`, `embedding`. A role without a model is unavailable | `{ strategist: "claude-opus-5-5", triage: "claude-haiku-5-5" }` |
| `models.pricing.<model>` | No | Per model id: `inputCentsPerMTok` and `outputCentsPerMTok` (US cents per million tokens), plus `cacheWriteMultiplier` (default 1.25) and `cacheReadMultiplier` (default 0.1) relative to input. A model without a price is never called | See the template; replace its numbers with your provider's current prices |
| `autonomy.defaults` | No | Starting autonomy level (0 to 3) per action class; every class starts at 1, "draft and ask", unless set here. `merge_code`, `pricing_billing_auth`, `offers`, `proof_of_value_send` and `data_deletion` can never start above 1. Leave it empty to start | `{}` |
| `sequences.cold.steps` | No | The cold sequence: 1 to 5 steps numbered 1, 2, 3 in order, each `{ step, kind, delayDays }` with `kind` one of `cold_intro`, `follow_up`, `breakup`, and `delayDays` (0 to 60) counted from the previous step | Default: `cold_intro` at 0, `follow_up` 3 days later, `breakup` 7 days after that |
| `modules.ship`, `modules.linkIntake`, `modules.classifierTier`, `modules.codeMode` | No | `{ enabled }` for optional modules that have not shipped yet. Leave them off | (omitted) |
| `operator.allowedChatIds` | No | Chat ids allowed to command the agent. Empty denies everyone | `["123456789"]` |
| `operator.allowedUserIds` | No | User ids allowed to command the agent; a chat is served only when both lists match | `["123456789"]` |

Never put a literal secret in this file. Everything specific to what you sell lives here, in `brain/` and in `templates/`; selling a different product never needs a code change.

### Adapter options

| Adapter | Options (all optional) |
|---|---|
| `operator-telegram` | `chatId` (where messages without a chat go: pages, release messages; set it), `apiBaseUrl` (a self-hosted Bot API server) |
| `llm-gateway` | `aiGatewayBaseUrl`, `byok`, `anthropicVersion` (default `2026-10-21`), `promptCache` (default `true`), `fallbacks` (`"default"` turns on the provider's server-side fallback), `roles` (used only when core sends no model id) |
| `data-exa` | `baseUrl`, `searchType` (default `auto`), `accountCategory` (default `company`), `personCategory` (default `people`), `highlightChars` (default 400) |
| `data-hunter` | `baseUrl`, `usdPerCredit` (set it to your plan's price per credit) |
| `email-resend` | `apiBaseUrl`, `usdPerEmail` (set it to your plan's price per email) |
| `inbox-gmail` | `address` (the mailbox's own address; set it), `pubsubTopic`, `userId` (default `me`), `scanLimit` (1 to 500, default 200), `apiBaseUrl` |
| `email-cloudflare` | `ownAddresses`, `maxBytes` (default 25 MiB) |

### What lives in `src/index.ts`

`src/index.ts` wires the adapters and jobs into `createWorker`. You rarely change it, but three settings live there:

- `agent.chatQueue`: each environment's `CHAT_QUEUE` name, as `gtm setup` creates it (`<worker>-chat`): `["acme-agent-chat", "acme-agent-staging-chat"]`. The template ships with `gtm-agent` names; a chat message on an unlisted queue is still handled, with a warning in the logs.
- `cronHealth.schedule`: when the cron health check runs (the template: `"30 10,15 * * *"`, twice a day).
- `inboundEmail.forwardTo`: the human copy of Email Routing mail ([4.8](#48-cloudflare-email-routing-the-alternative-inbox)).

Each `create*Jobs` factory also takes `options` to change a job's schedule, rows or spend cap; the per-topic pages list them.

## 7. Writing your brain and templates

The brain is a set of short Markdown files, one per component (`personas.md`, `icp.md`, `facts.md` and the rest), that prompts read. Templates are your email copy, one Markdown file each, with frontmatter and `{{variables}}`. Only files marked `status: approved` whose bytes match the lock are ever served. [BRAIN-SCHEMA.md](BRAIN-SCHEMA.md) lists every component, field, variable and rule.

1. **Copy the example.** [examples/brains/acme](../examples/brains/acme/) is a complete brain for the fictional Acme, with a three-step template sequence:

   ```bash
   # from your deployment directory; TOOLKIT is a checkout of the repository, or its source
   # archive for the release you installed, unpacked
   TOOLKIT=../gtm-agents
   for f in "$TOOLKIT"/examples/brains/acme/*.md; do [ "$(basename "$f")" = README.md ] || cp "$f" brain/; done
   cp "$TOOLKIT"/examples/brains/acme/templates/*.md templates/
   ```

   This keeps the deployment's own `brain/README.md` and `templates/README.md` (the validator ignores README files) and leaves Acme's lock behind: you will write your own.
2. **Edit** every item into your own market, buyers, facts and voice. Keep items short, prices only in `commercial.md`, links only in the `url` fields of `facts.md` and `commercial.md`, no em or en dashes, and nothing copied from the web or a prospect's email. Set `status: draft` on anything you have not reviewed.
3. **Validate** as you go: `npx gtm brain validate`. Errors stop you; warnings (a missing or draft component) are allowed, so you can add components one at a time.
4. **Approve and lock.** When a file is right, set `status: approved`, then `npx gtm brain validate --write-lock` writes `brain/brain.lock.json`. If you edit an approved file later, validation fails and `gtm brain upload` refuses until you lock it again; the version already uploaded keeps being served meanwhile.
5. **Upload** to each environment: `npx gtm brain upload --env staging`, then `npx gtm brain upload` for production. `npx gtm brain diff` shows what differs from what is uploaded.

What each capability needs at minimum:

| Capability | Brain components | Templates |
|---|---|---|
| Sourcing | `personas`, `icp`, `keyword-portfolio` | |
| Cold outreach | `icp` (its never list); `voice`, `facts`, `message-pillars` for the reviewer and claims check | At least one approved `cold_intro` |
| Replies | `facts`, `objections`, `competitors`, `voice`, `stack`, `personas` | |
| Follow-ups | as for cold outreach | One approved template per follow-up step (`follow_up` at step 2, `breakup` at step 3 by default) |

Keep `brain/` and `templates/` in your deployment's git repository: the lock records what you approved, and git records when.

## 8. The command path: staging, then production

The whole path for staging, in order. Each step is explained below.

```bash
# 1. Create the deployment from a published release (every package pinned to <version>)
npx @gtm-agents/cli@<version> init acme-agent
cd acme-agent && npm install

#    or from a pinned checkout of the toolkit, linked with --local
git clone <repository-url> gtm-agents
cd gtm-agents && git checkout <tag-or-commit> && npm install
npx gtm init ../acme-agent --local .
cd ../acme-agent && npm install

# 2. Configure it: gtm.config.ts, brain/, templates/ (sections 6 and 7)
npx gtm brain validate
npx gtm doctor

# 3. Create the staging resources
npx gtm setup --env staging --base-url https://agent-staging.acme.example
#    then list the chat queue names in agent.chatQueue in src/index.ts

# 4. Set the secrets it lists
npx wrangler secret put GATEWAY_TOKEN --env staging      # and every other line setup printed

# 5. Migrate, lock and upload the brain, deploy
npx gtm migrate --env staging
npx gtm brain validate --write-lock
npx gtm brain upload --env staging
npx gtm deploy --env staging

# 6. Verify
npx gtm doctor --remote --env staging
curl -s https://agent-staging.acme.example/health
```

Then the same again without `--env staging` for production.

**Production asks first.** `gtm migrate`, `gtm brain upload`, `gtm flags set|unset` and `gtm deploy` ask for confirmation before they write to production, and need `--yes` when there is no terminal (in CI, for example). `gtm setup` asks before creating anything in any environment. Staging writes without asking, so you can iterate on it quickly. Wrangler runs without a terminal underneath, so its own prompts answer themselves; the `gtm` question is the real one.

### Step 1: create the deployment

`gtm init <dir>` copies the worker template into a new, empty directory: `wrangler.jsonc` with `${...}` placeholders for every resource, `src/index.ts`, `gtm.config.ts`, `.dev.vars.example`, `brain/` and `templates/` folders holding only a README each, `public/admin/` (the dashboard), `package.json`, `tsconfig.json` and `.gitignore`. By default the template comes from the CLI package and `package.json` depends on the packages at exactly the CLI's version; with `--local <checkout>`, both come from the checkout (the packages through `file:` links). The Worker is named after the directory (`acme-agent`; pass `--name` for another, lowercase letters, digits and hyphens, at most 48 characters), and staging gets `<name>-staging`. Put the new directory under git.

Use `npx gtm deploy`, not the generated `npm run deploy`: the npm script runs a bare `wrangler deploy`, which skips the migrations.

### Step 2: configure it

Fill in `gtm.config.ts` ([section 6](#6-configuration-reference)): company, agent name, sending addresses and postal address, the adapters you will enable now, the strategist model and its price. Leave the allowlists empty for now; you will add your ids after the first deploy. Write at least a first draft of the brain and templates ([section 7](#7-writing-your-brain-and-templates)). `gtm doctor` (offline) then checks the bindings, the cron trigger, the config, the adapter manifests and the secrets you will need.

### Step 3: create the Cloudflare resources

`gtm setup --env staging` creates what the environment's block in `wrangler.jsonc` still lacks (the D1 database, KV namespace, R2 bucket, Vectorize index and queues listed in [section 1](#bindings)) and writes their ids and names back into the file.

- **It looks before it creates.** It asks Cloudflare, read-only, whether each name already exists. If Cloudflare cannot be asked, it stops before creating anything.
- **It never adopts a resource silently.** If a resource with a derived name already exists but `wrangler.jsonc` does not name it, it may belong to another deployment with the same Worker name, so setup stops and says so. Rerun with `--reuse-existing` only if it is yours. The R2 bucket is the exception: the file already names it, so an existing bucket of that name is reused, with a note in the plan asking you to make sure it is yours.
- **It asks first,** printing the plan; `--yes` skips the question, and without a terminal it is required.
- **It edits only the placeholders,** keeping comments and formatting. If the file changes while setup runs, it does not write, and prints the values to enter by hand.
- **It is safe to run again.** A second run plans nothing. If a create fails halfway, fix the cause and rerun: it reuses what it already made.
- **The Vectorize index's dimensions cannot change later.** The default is 1536 with cosine distance; pass `--vector-dimensions` and `--vector-metric` (`cosine`, `euclidean` or `dot-product`) before the first run if your embedding model needs others.
- **`--base-url`** fills `AGENT_BASE_URL` with an https origin (no path). Without it, setup lists `vars.AGENT_BASE_URL` as still to fill in, and `gtm deploy` refuses to run until it is.

Setup ends with the chat queue's name and the missing secrets. Put each environment's chat queue name in `agent.chatQueue` in `src/index.ts` ([section 6](#what-lives-in-srcindexts)).

### Step 4: set the secrets

Run each `npx wrangler secret put <NAME> --env staging` line setup printed: the core ones and each enabled adapter's ([section 5](#5-secrets-reference)). Keep a copy of every value in your password manager.

### Step 5: migrate, upload the brain, deploy

- **`gtm migrate`** checks that the migrations are numbered in order with no gaps, then runs `wrangler d1 migrations apply DB --remote`. Migrations are idempotent and D1 records which ones ran, so running it again is harmless. **Always migrate before new code runs**: new code can rely on new columns.
- **`gtm brain validate --write-lock`** locks what you approved. **`gtm brain upload`** validates again and uploads nothing on an error, without a lock, or when an approved file changed after it was locked. It writes each approved file to KV (`brain:file:<component>`, `template:file:<id>`), then, in a separate call, the locks (`brain:lock`, `templates:lock`). The runtime serves a file only when its bytes match the lock, so an upload that stops halfway is never served half-written; rerun it. KV takes up to a minute to reach every Cloudflare location. `--dry-run` lists the keys without writing.
- **`gtm deploy`** runs, in order: `gtm doctor` (any FAIL stops it), a check that no `${...}` placeholder is left, `gtm migrate` (a failure stops it), `gtm brain diff` (differences are a warning), then `wrangler deploy`. `gtm deploy --dry-run` runs the checks, lists pending migrations and bundles the Worker without changing anything.

### Step 6: verify

| Check | Expect |
|---|---|
| `npx gtm doctor --remote --env staging` | PASS for bindings, cron trigger, placeholders, `gtm.config.ts`, each enabled adapter, secrets ("all N required secrets are set"), footer and unsubscribe, the halt flag and both kill-switch keys ("is unset"). One WARN stays while the operator adapter is enabled, because doctor cannot see Telegram: a reminder that "operator-telegram needs its webhook registered" |
| `curl -s https://agent-staging.acme.example/health` | `{"ok":true,"service":"gtm-agents"}` |
| `curl -s -o /dev/null -w "%{http_code}\n" https://agent-staging.acme.example/api/ping` (any `/api/` path; this one does not exist) | `401` without a token (the bearer token is set). `503` means `GATEWAY_TOKEN` is unset |
| The Worker's Cron Events in the Cloudflare dashboard | An invocation every minute |
| Run rows (query below) | Rows for the jobs due so far, `skipped` with the summary `flag off`; `cron_health` `completed` after 10:30 or 15:30 UTC |

Read run rows with Wrangler; the checks in [section 9](#9-staged-rollout) use this helper:

```bash
q() { npx wrangler d1 execute DB --remote --env staging --command "$1"; }
q "SELECT task_name, status, summary, started_at FROM execution_runs ORDER BY started_at DESC LIMIT 20"
```

### Step 7: connect the operator chat

1. Register the bot's webhook ([4.4](#44-telegram-operator-channel), step 3).
2. Message the bot, find your ids in `npx wrangler tail --env staging`, and add them to `operator.allowedChatIds`, `operator.allowedUserIds` and `adapters["operator-telegram"].options.chatId` ([4.4](#44-telegram-operator-channel), steps 4 and 5).
3. Redeploy: `npx gtm deploy --env staging`.

The agent itself stays off until stage 1 of the rollout.

### Production

Repeat steps 3 to 7 without `--env staging`: `npx gtm setup --base-url https://agent.acme.example`, the production secrets (with the production bot, Resend endpoint and mailbox), `npx gtm migrate`, `npx gtm brain upload`, `npx gtm deploy`, `npx gtm doctor --remote`, and the production bot's webhook. Answer each confirmation, or pass `--yes` in CI.

**Staging never emails real people.** Point staging at its own bot, a test mailbox and a test chat. Discovery finds real people, so keep `delivery:enabled` off in staging unless every contact in its database is an address you own.

## 9. Staged rollout

Turn on one capability at a time, in this order, and check each before the next. Run the whole sequence in staging first (with delivery off, as above), then again in production. Everything below uses `--env staging`; drop it for production.

```bash
npx gtm flags list --env staging                       # every flag, its default and its deployed value
npx gtm flags set operator:agent_enabled true --env staging
npx gtm flags get operator:agent_enabled --env staging
npx gtm flags unset operator:agent_enabled --env staging   # back to the default (off)
```

`gtm flags` refuses a key that is not in the flag registry and a value that does not fit the flag's kind, and never sets a permanently human-only action class above level 1. Flags live in KV, so a change can take up to a minute to reach every location. Jobs run on their schedules: plan each check around the times in [section 13](#13-reference-scheduled-jobs). (`cold_batch:run_now` appears in the registry but nothing reads it yet, so there is no on-demand run.)

The order differs from a pure "sourcing, then sending" order in one place: the inbox is turned on before any mail is sent, so that the very first send already has its replies, unsubscribe requests and bounces recorded, and the cold batch's rules about accounts that have written in can see them.

### Stage 0: deployed, everything off

- **Doctor:** `gtm doctor --remote` passes, as in [step 6](#step-6-verify).
- **Run rows:** every due job `skipped` with `flag off`; `cron_health` `completed` twice a day with a summary such as "6 critical job(s) checked, 0 unhealthy, 0 paged, 0 rerun".
- **Messages:** none.
- **Before moving on:** `/health` answers, Cron Events show every minute, and run rows are being written (if there are none, see [no jobs run](#jobs-and-scheduling)).

### Stage 1: the operator chat

- **Needs:** the bot's webhook registered, your ids allowlisted, `options.chatId` set, `ANTHROPIC_API_KEY` set, `models.roles.strategist` named and priced.
- **Turn on:** `npx gtm flags set operator:agent_enabled true --env staging`
- **Doctor:** adapters `operator-telegram` and `llm-gateway` PASS; secrets PASS.
- **Messages:** send `/help`, then `/status` (taint, drafts waiting, today's chat spend, the strategist model), then a task such as "Find the contacts we have at acme.example". The agent answers in the chat.
- **Run rows:** each task (not a command) writes one row with `task_name` `operator_chat` and trigger `chat`: `q "SELECT status, summary, started_at FROM execution_runs WHERE task_name = 'operator_chat' ORDER BY started_at DESC LIMIT 5"`.
- **Before moving on:** commands and a task both answer; a failure page reaches your chat (you will see one the first time any job fails; until then, trust `options.chatId` and the chat test). [OPERATOR.md](OPERATOR.md) has the full command list.

### Stage 2: discovery

- **Needs:** `EXA_API_KEY` and `HUNTER_API_KEY`, `data-exa` and `data-hunter` enabled, and an uploaded, locked brain with approved `personas`, `icp` and `keyword-portfolio`. In staging, keep it small: `npx gtm flags set discovery:searches_per_cycle 1 --env staging` and `npx gtm flags set discovery:enrich_per_cycle 5 --env staging`.
- **Turn on:** `npx gtm flags set discovery:enabled true --env staging`; optionally `fit:prescore_enabled true` (free, nightly). Leave `fit:scoring_enabled` off until you have accounts and a priced `classifier` model.
- **Run rows:** `discovery_cycle` at 09:00 UTC on weekdays, `completed` with a summary like "5 searches, 42 new; enriched 30, rejected 8, duplicate 2; qualified 12, borderline 9; promoted 10, held 0; 95 paid calls". `account_prescore` at 04:00 UTC: "prescored N accounts".
- **Data:** `q "SELECT status, COUNT(*) AS n FROM candidates GROUP BY status"` and `q "SELECT warmth, COUNT(*) AS n FROM contacts GROUP BY warmth"`; spend so far today in cents: `q "SELECT job, SUM(cost_micro_cents) / 10000.0 AS cents FROM cost_events WHERE created_at >= date('now') GROUP BY job"`.
- **Messages:** none routinely.
- **Before moving on:** contacts with warmth `cold` appear, spend stays under the discovery cap (300 cents a day by default), and the promoted people are the ones your personas describe. If not, fix the brain, not the code ([SOURCING.md](SOURCING.md)).

### Stage 3: the inbox

- **Needs:** Gmail ([4.7](#47-google-the-gmail-inbox)) with `inbox-gmail` enabled and `options.address` set, or Email Routing ([4.8](#48-cloudflare-email-routing-the-alternative-inbox)); `sending.replyTo` set to the watched address.
- **Turn on:** `npx gtm flags set inbox:enabled true --env staging`. With Email Routing only, also `npx gtm flags set sequences:reply_intake routed --env staging`.
- **Run rows:** `inbox_poll` every minute, `completed` with a summary starting `listed;` (for example "listed; pages 1, recorded 0, duplicates 0, from us 0, failed 0, pending 0"); `inbox_sweep` every 15 minutes; `inbox_watch_renewal` at 06:20 UTC ("push watch renewed until ..." or "push not configured"). With Email Routing only, there are no listings: messages are recorded as they arrive.
- **Data:** send a test message to the mailbox from another address, then `q "SELECT classification, status, COUNT(*) AS n FROM inbound_emails GROUP BY classification, status"`.
- **Messages:** none routinely; an unsubscribe by reply and a billing-failure notice each send you a notice.
- **Before moving on:** your test message is recorded within a few minutes and the poll has completed every minute for a day, with no `failed` rows. [INBOX.md](INBOX.md) explains each classification.

### Stage 4: the cold batch, released by hand

- **Needs:** contacts from stage 2; at least one approved `cold_intro` template and the brain uploaded (`gtm brain upload`); the operator chat on (the release command is a chat message). Keep `cold_batch:auto_approve` off and `autonomy:cold_batch` at its default of 1.
- **Turn on:** `npx gtm flags set cold_batch:enabled true --env staging`. Optionally `quality:model_review_enabled true` once `models.roles.judge` is priced.
- **Run rows:** `cold_batch` at 13:00 UTC, Monday to Thursday, with a summary like "manual: 25 drafts, 23 waiting for release with batch-release-cb20261109-1a2b3c; 23 pass, 2 held, 0 blocked; ...". `delivery_liveness` now also runs at 21:00 UTC on weekdays.
- **Messages:** one message with the first, middle and last drafts and the release command, `batch-release-<id>-<code>`. While delivery is off, the evening liveness check pages you that nothing went out, listing the switch that is off: that is expected.
- **Data:** `q "SELECT kind, status, COUNT(*) AS n FROM drafts GROUP BY kind, status"`; held drafts carry their codes in `quality_checks`.
- **Release or wait:** read the samples. Do not release in production until stage 5. In staging you may send the release command to watch the gates work: with delivery off, every item comes back unsent with `[SEND BLOCKED:disabled]`, and the same command can be sent again later, because a retryable failure releases each draft's claim.
- **Before moving on:** drafts read well and the held ones are held for reasons you agree with ([OUTREACH.md](OUTREACH.md) lists every code).

### Stage 5: delivery

- **Needs:** the sending subdomain verified with Resend and its DNS records in place ([4.2](#42-the-domain-and-the-sending-subdomain), [4.3](#43-resend-email-provider)); `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` and `UNSUBSCRIBE_SIGNING_KEY` set; the webhook endpoint registered; `AGENT_BASE_URL` set; `email-resend` enabled. In production, also work through the [go-live checklist](#12-go-live-checklist).
- **Turn on:** `npx gtm flags set delivery:enabled true`. Leave `outreach:ramp_level` at 0 (25 a day) and `outreach:ramp_auto` off.
- **Send:** release the next cold batch with its `batch-release-...` command. The reply names what was sent, deferred (outside the send window, a cap, the breaker), blocked or refused, and why.
- **Doctor:** adapter `email-resend` PASS; secrets PASS; the webhook check returns 401 ([4.3](#43-resend-email-provider), step 5).
- **Run rows:** `delivery_bounce_monitor` daily at 09:00 UTC (for example "healthy: 7d 0/25, 1d 0/25; ..."; under 20 sends it reports low volume); `delivery_replay` at 00:00, 08:00, 13:00 and 20:00 UTC on weekdays ("due 0, claimed 0, sent 0, ..."); `delivery_liveness` "ok: 25 today, 25 in 3 days".
- **Data:** `q "SELECT send_path, COUNT(*) AS sent, COUNT(delivered_at) AS delivered, COUNT(bounced_at) AS bounced, COUNT(complained_at) AS complaints FROM outreach_sends GROUP BY send_path"`. Delivered events arrive through the webhook within minutes; compare with the Resend dashboard.
- **Messages:** pages for hard bounces (at most five a day), complaints, unsubscribes, the circuit breaker, and bounce monitor warnings.
- **Before moving on:** a week of sends with delivered events arriving, hard bounces under 2% and no complaints. Open one message in a test inbox: plain text, your postal address in the footer, a working unsubscribe link (opening it shows a confirmation page and changes nothing until you press the button). [SENDING.md](SENDING.md) covers windows, caps and the deferred queue.

### Stage 6: replies

Turn the reply flags on one at a time, in this order:

| Flag | What it adds | Check |
|---|---|---|
| `replies:triage_enabled` | The `triage` model reads new human mail and applies each intent's side effects (opt-out, deal stage, decline hold, warmth, sequence stop) | `replies_triage` every 15 minutes: "rerouted 0, triaged 3 (0 left for retry), drafted 0, ..."; `q "SELECT intent, COUNT(*) AS n FROM inbound_emails WHERE intent IS NOT NULL GROUP BY intent"` |
| `replies:reminders_enabled` | Reminders about owed replies at 15 minutes, 2 hours and 4 hours, then each morning | `replies_reminders` every 5 minutes: "owed 1, reminded 1, quiet threads 0"; a reminder in the chat |
| `replies:drafting_enabled` | The `writer` model drafts answers from approved facts; each arrives as an approval request | A notice and an approval request with Approve and Reject buttons; nothing is sent |
| `replies:mirror_enabled` | Gmail only: reply drafts appear as real drafts on their thread, and what you send from the mailbox is reconciled | `replies_mirror` every 15 minutes: "created 1, failed 0, ..." and the draft in Gmail |
| `replies:send_enabled` | Approved replies go out from the mailbox, on the thread (needs `delivery:enabled` too) | `replies_send` every 5 minutes: "sent 1, refused 0, held 0, ..."; or `/reply_send <draft id>` |

- **Needs:** stage 3 recording; `models.roles.triage` and `writer` named and priced; brain `facts`, `objections`, `competitors`, `voice` and `stack` uploaded.
- **Before moving on:** triage intents match what people actually wrote, drafts read well, and `/replies` lists what is owed. No reply is ever sent without your approval in this version. [REPLIES.md](REPLIES.md) covers each intent and the freshness checks.

### Stage 7: follow-ups

- **Needs:** first touches sent by the cold batch (stage 5); approved follow-up templates (`follow_up` at step 2 and `breakup` at step 3 by default) uploaded; inbox recording (stage 3). With Gmail (poll intake, the default), a step goes out only when the latest `inbox_poll` completed in the last 10 minutes and listed the mailbox; with Email Routing only, `sequences:reply_intake` must be `routed`.
- **Turn on:** `npx gtm flags set sequences:enabled true --env staging`
- **Run rows:** `sequence_sweep` at 08:30, 12:30, 16:30 and 20:30 UTC on weekdays; `sequence_stale_check` Saturdays at 10:00 UTC. A sweep held because intake is not current says `held:` and the reason in its summary, and sends you "Follow-ups are held: ..." once a day ([follow-ups are held](#follow-ups)).
- **Messages:** one message per sweep with the first, middle and last drafts and `sequence-release-<id>-<code>` (a manifest expires after 72 hours); paused contacts with their `sequence-resume-<contact id>` command; a daily notice if a step has no servable template.
- **Before moving on:** release one sweep and check the follow-up threads under the first email in a test inbox (subject `Re: ...`), and that a reply from anyone at an account stops every sequence there. [SEQUENCES.md](SEQUENCES.md) covers stop rules and threading.

### Stage 8: reports

Reports need only the operator chat, so you can turn them on as early as stage 1.

- **Turn on:** `npx gtm flags set ops:daily_scorecard true --env staging` and `npx gtm flags set ops:funnel_digest true --env staging`. `ops:cost_digest` stands down while the scorecard is on, which already carries spend.
- **Run rows:** `daily_scorecard` at 12:00 UTC on weekdays and `funnel_digest` Mondays at 09:00 UTC, each with the summary `sent`.
- **Messages:** the scorecard and the digest. `/scorecard` and `/report funnel|cost|holdout|conversion` work any time.
- **Before moving on:** the scorecard's numbers match the run rows and the provider's dashboard. [MEASUREMENT.md](MEASUREMENT.md) explains every line.

### Stage 9: meetings

- **Turn on:** set the calendar secret, then `npx gtm flags set convert:calendar_enabled true --env staging`. Later, if you want them: `convert:post_demo_enabled` (post-meeting drafts) and `convert:handoff_enabled` (deal handoff briefs).
- **Run rows:** `calendar_sync` every 15 minutes and `meeting_followups` at 5, 20, 35 and 50 past each hour, completed.
- **Messages:** a booked meeting's notice and prep brief; reminders at 24 hours and 1 hour; a held or no-show question after it. `/meetings` lists what the system sees.
- **Before moving on:** book a test meeting with a synthetic contact's address you control, accept it from that address, and check that the contact's sequences stop and the brief arrives. Nothing is ever sent automatically: recaps, rebooks and post-demo steps are drafts.

### Stage 10: lifecycle

- **Turn on:** set `PRODUCT_WEBHOOK_SECRET` (and `PRODUCT_READ_SECRET` and `PRODUCT_APP_URL` for the pull), have your host application send events with the SDK ([LIFECYCLE.md](LIFECYCLE.md), `@gtm-agents/sdk`), then `npx gtm flags set lifecycle:enabled true --env staging`. Later `lifecycle:reconcile_enabled`, and `billing:enabled` once a billing adapter is wired.
- **Run rows:** `event_sweep` every 5 minutes, `lifecycle_checks` hourly, `mrr_snapshot` and `event_retention` nightly, `lifecycle_reconcile` nightly when on.
- **Check:** send a test `user.signed_up` for a synthetic contact from your host's staging; the push answers 200, the contact moves to signed up, its sequences stop and its deal steps to trial. The scorecard's sign-up line starts counting.

### Stage 11: earned autonomy

Nothing here is required: at the default level a person approves every send. When the evidence supports it:

- **Turn on the review:** `npx gtm flags set autonomy_review:enabled true --env staging`. Each Monday it proposes level changes it can justify; `autonomy-status` shows every class and its evidence. Demotion needs no flag and always runs.
- **Raise a class** only from the operator chat: `autonomy-set <class> 2`, then the `autonomy-confirm-...` command it gives you within 30 minutes. For automatic replies also set `inbound:auto_send_tier` and keep `quality:model_review_enabled` on, with a `judge` model and price in `gtm.config.ts`.
- **Run rows:** `autonomy_review` Mondays at 06:00 when on, `autonomy_watch` at 15 past every hour always.
- **Check:** after a hard bounce, complaint or unsubscribe on an automatic reply, that class is back at 1 within the hour and you were told. The cold batch demotes on a per-contact complaint at once, and on bounces or unsubscribes only when the hourly rate check (14 days, 50 or more sends, bounces at 2% or more, or unsubscribes at 1% or more) trips, so a single cold bounce does not demote it. [AUTONOMY.md](AUTONOMY.md) has the rules.

### The warm-up ramp

A new sending domain earns its reputation gradually, so daily cold volume follows fixed levels, set by `outreach:ramp_level`:

| `outreach:ramp_level` | 0 (default) | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| Cold first touches a day | 25 | 50 | 100 | 250 | 500 |

The day's volume is the ramp level, lowered by `cold_batch:daily_limit` if you set one and by today's room under `delivery:domain_daily_cap` (500 by default). Step up by hand after a clean week (`npx gtm flags set outreach:ramp_level 1`), or, once a week of delivered mail has come in, turn on `outreach:ramp_auto` and let the `delivery_ramp` job move one step at a time on evidence: up only after 7 days with delivered events, the best day near the current level, hard bounces under 2% and complaints under 0.1%; down on complaints or a warning pause. Follow-ups share the per-domain and per-account caps. [SENDING.md](SENDING.md#the-warm-up-ramp) has the exact rules.

### The kill switch and the halt

| Control | What it stops | Set | Lift |
|---|---|---|---|
| `system:halt` | Every scheduled job and every send, replies included | `npx gtm flags set system:halt '{"reason":"investigating","by":"operator"}'` | `npx gtm flags unset system:halt` |
| `outreach:cold-pause:critical` | Cold first touches and follow-ups; replies keep flowing | `npx gtm flags set outreach:cold-pause:critical '{"reason":"bounce spike","source":"operator","since":"2026-11-09T12:00:00Z"}'` | `npx gtm flags unset outreach:cold-pause:critical`, then `npx gtm flags unset outreach:cold-pause` |
| `outreach:cold-pause` | The same, at warning level; the bounce monitor sets and lifts it on its own | (set by the bounce monitor) | `npx gtm flags unset outreach:cold-pause` |

Both fail closed: a value that cannot be read counts as halted or paused, and any value at all of `system:halt` halts (`gtm flags` only accepts a JSON object for these keys). The bounce monitor sets a critical pause on its own on a confirmed hard-bounce spike ([SENDING.md](SENDING.md#the-bounce-monitor-and-the-kill-switch)); only a person lifts a critical pause, and the bounce monitor reminds you each day while it stands (while `delivery:enabled` is on). `gtm doctor --remote` shows all three keys. Add `--env staging` for staging.

### After the rollout: earning autonomy

Every batch and sweep waits for your release until you decide otherwise. Automatic approval of passing drafts needs both the model reviewer (`quality:model_review_enabled`, with a priced `judge` model) and either `cold_batch:auto_approve` or `autonomy:cold_batch` at 2 or above; with the reviewer off, everything still waits for you. Raise autonomy only on evidence, and only a person ever does. [OUTREACH.md](OUTREACH.md#auto-approve) explains the rules.

## 10. Operating it

### The daily routine

| When (UTC) | What arrives | What you do |
|---|---|---|
| 08:30, 12:30, 16:30, 20:30, weekdays | Follow-up release messages | Read the samples; send `sequence-release-<id>-<code>` |
| 12:00, weekdays | The daily scorecard | Read "Waiting on you", "Failed jobs" and "Needs attention" |
| 13:00, Monday to Thursday | The cold batch's release message | Read the first, middle and last drafts; send `batch-release-<id>-<code>` |
| Through the day | Reply notices, approval requests, reminders | Approve or reject each draft; `/replies` lists what is owed; `/reply_done <id>` or `/reply_ignore <id>` settles one you handled elsewhere |
| Any time | Job failure, cron health, bounce, complaint and breaker pages | Act on each ([section 11](#11-troubleshooting-by-symptom)); a page repeats at most once a day per job |
| Mondays 09:00 | The funnel digest | Check the matured reply rate and the bounce rate |
| Saturdays 10:00 | Stale sequences | Resume, fix the template, or let them end |

Weekly, review spend against your budget (`/report cost`), the ramp level, and held drafts (their codes tell you what to fix in the brain or templates).

### Budgets

Every paid call is checked against the budget first and recorded in the cost ledger. Per-job caps ([section 13](#13-reference-scheduled-jobs)) are always enforced. The global limits are `budget:daily_limit_cents` (default 2000) and `budget:monthly_limit_cents` (default 50000), and they only **block** when `budget:enforcement` is `hard`; the default, `soft`, only alerts at `budget:alert_threshold` (0.8) of a limit. Set the limits to what you are willing to spend and switch to `hard` before go-live. Chat turns are capped by `chat:turn_max_cents` (50); cap all chat for a day with `budget:job:operator_chat:daily_cents`. Any job can get a tighter cap with `budget:job:<job>:daily_cents`.

### Pausing and rolling back

- **One capability:** `npx gtm flags unset <flag>` returns it to its default, which is off.
- **All cold outreach:** set `outreach:cold-pause:critical` ([the kill switch](#the-kill-switch-and-the-halt)).
- **Everything:** set `system:halt`. Mail that arrives through Email Routing is still recorded, because recording only ever stops or holds mail; the poll catches up from its cursor when the halt lifts.
- **The code:** `npx wrangler rollback` (with `--env staging` for staging) returns to the previous Worker version; `npx wrangler deployments list` shows the versions. Migrations are not rolled back: they add tables, columns, indexes and triggers (and occasionally backfill data), so the previous code keeps working.
- **The brain or templates:** check the previous version out of your deployment's git repository and upload it again (`gtm brain upload`).

Flag changes take up to a minute to reach every location.

### Upgrading to a new version of the toolkit

Upgrade deliberately; nothing changes until you move a version.

1. **Read what changed** between your version and the new one: the release notes or commits, and the changed docs (in a checkout, `git log --oneline <old>..<new>` and `git diff <old>..<new> -- docs/`). [ROADMAP.md](ROADMAP.md) says what each milestone adds.
2. **Move the version.**
   - From npm: set every `@gtm-agents/*` dependency in your `package.json` to the new version (they move together), then `npm install`.
   - From a checkout linked with `--local`: in the checkout, `git checkout <new-tag-or-commit> && npm install`, then `npm install` in the deployment. Your deployment links to the checkout, so a pull there changes what the next deploy ships.
3. **Compare the template with your copies.** `gtm init` copied `src/index.ts`, `wrangler.jsonc` and `gtm.config.ts` once; a new version may wire new jobs, add a binding or add a config field. Generate a fresh copy with the new version (`npx @gtm-agents/cli@<new> init /tmp/gtm-fresh`, or `apps/worker/` in a checkout), diff it against your files and carry the changes over.
4. **Staging first:** `npx gtm doctor --env staging`, `npx gtm migrate --env staging`, `npx gtm deploy --env staging`, `npx gtm doctor --remote --env staging`, and watch it for a day. New capabilities arrive behind flags that default to off.
5. **Then production:** `npx gtm migrate`, `npx gtm deploy`, `npx gtm doctor --remote`.

Always migrate before the new code runs; `gtm deploy` does it for you.

### Backups and recovery

- **D1 is the truth,** and D1 keeps its own history: Time Travel restores a database to any minute within its retention window (`npx wrangler d1 time-travel info DB --env staging`, then `restore` with `--timestamp` or `--bookmark`). A restore overwrites the database in place and prints a bookmark to undo it. For copies you keep yourself, try `npx wrangler d1 export DB --remote --output backup.sql`; the database includes a virtual full-text table (`memory_fts`), so check Cloudflare's export documentation for how it handles virtual tables. See [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
- **Before restoring, halt.** The effects ledger that stops a message going out twice lives in D1: after a restore, sends made since the restore point are forgotten. Check the provider's log of what went out after that point before lifting the halt.
- **KV** holds flags and the uploaded brain. Keep the output of `gtm flags list` for each environment and your brain in git; both can be put back with `gtm flags set` and `gtm brain upload`.
- **R2** holds archived inbound bodies. Losing it loses those bodies, not the records, and they are not fetched again; the mail itself is still in the mailbox.
- **Secrets** cannot be read back from Cloudflare: keep them in your password manager.

### Data erasure requests

A person is erased with `eraseContact` from `@gtm-agents/core/data`: it writes a tombstone (so they are never re-added or emailed), deletes every row holding their address and their stored inbound mail, and keeps the measurement ledgers with the contact link cleared. [DATA-MODEL.md](DATA-MODEL.md#erasure) explains exactly what goes. No command runs it for you, because data deletion is permanently a person's decision. One way is a route of your own behind the bearer token, in `src/index.ts`:

```ts
import { eraseContact } from "@gtm-agents/core/data";

export default createWorker(config, {
  // ...the rest as before
  routes: (app) => {
    app.post("/api/erasure", async (c) => {
      const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
      if (typeof body.email !== "string" || body.email === "") return c.json({ error: "email_required" }, 400);
      const result = await eraseContact(c.env.DB, body.email, { source: "operator", bucket: c.env.BUCKET });
      return c.json({ ok: true, contactsDeleted: result.contactsDeleted });
    });
  },
});
```

```bash
read -rs GATEWAY_TOKEN
curl -s -X POST https://agent.acme.example/api/erasure -H "Authorization: Bearer ${GATEWAY_TOKEN}" \
  -H "content-type: application/json" -d '{"email":"jane@prospect.example"}'
```

Erasing `jane@` also erases `jane+news@`; an address that does not parse erases nothing and answers 500. Copies outside the database are yours to delete: the mail and any mirrored drafts in the mailbox, the email provider's logs, and the operator chat. Someone who only wants no more email needs no erasure: their unsubscribe or a reply saying so suppresses them.

### Costs

| Driver | Scales with | Bounded by | Where to check prices |
|---|---|---|---|
| Worker invocations and CPU | 1,440 cron invocations a day, plus webhooks, chat and routed mail | Mostly fixed; jobs wait on the network, which is not CPU time | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| KV reads and writes | Every due job reads the halt flag, its own flag and its budget cap; flags, counters and cursors write | Roughly proportional to job runs | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |
| D1 rows and storage | About 2,400 run rows a day with everything off (`inbox_poll` alone writes about 1,440), plus contacts, drafts and ledgers | Run-row retention | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Workers Logs | The template turns observability on with full sampling | Lower `head_sampling_rate` in `wrangler.jsonc` | Workers pricing |
| R2, Queues | Inbound bodies; chat turns | Small at this scale | Cloudflare's R2 and Queues pricing pages |
| Model calls | Chat turns, fit scoring, reviewer calls, reply triage and drafting | Per-turn and per-job caps, global limits | Your model provider's pricing page; set `models.pricing` to match |
| Searches, lookups, verifications | `discovery:searches_per_cycle`, `results_per_search`, `enrich_per_cycle` | The discovery job's cap (300 cents a day) | Exa's and Hunter's pricing pages; set `usdPerCredit` |
| Emails | The ramp level and follow-ups | The ramp, `delivery:domain_daily_cap`, `delivery:account_weekly_cap` | Resend's pricing page; set `usdPerEmail` |
| Gmail and Pub/Sub | Inbox activity | Gmail API quotas | Google Cloud's Pub/Sub pricing page |

No model is ever called from a job that runs every minute; per-minute work is deterministic. With the default caps, scheduled model and data spend is bounded at about 575 cents a day (discovery 300, fit scoring 100, triage and drafting 100, the cold batch reviewer 50, the follow-up reviewer 25), plus chat turns and emails. Each call is recorded in `cost_events` and shown by `/report cost` and the scorecard.

### Run-row retention

Run rows are bookkeeping: they accumulate at about 2,400 a day, and old ones are only useful for history. Plan their retention: `ops:retention_enabled` gates a run-row retention job (`createRetentionJob()` from `@gtm-agents/core/runtime`), which deletes old rows and archives nothing. The template registers it (if your `src/index.ts` predates that, add `createRetentionJob<Env>()` to `jobs`, or the flag does nothing). Each day at 03:40 UTC, `run_retention` deletes skipped rows older than 7 days, completed rows older than 30 days and failed rows older than 90 days, from `execution_runs` only. It always keeps the newest row of each job and status and never touches running rows. It deletes in batches, at most 20,000 rows and 2 minutes a run, so a large backlog drains over days. Change it with `createRetentionJob({ schedule, maxRows })`. Recent rows matter: the cron health check, failure escalation and the follow-up intake check read them.

## 11. Troubleshooting by symptom

Most answers start with a run row, the logs (`npx wrangler tail --env staging`) or `gtm doctor --remote`. Quoted text is what the system actually says.

### Setup and deploy

| Symptom | Likely cause | Check |
|---|---|---|
| `gtm doctor` FAIL on `gtm.config.ts` | A schema error; the message names the field, for example "cold mail goes from an isolated subdomain of acme.example" or "the cold sender must be on the sending domain" | Fix the field it names |
| `gtm doctor` FAIL "cron trigger" | No `* * * * *` trigger, or an extra one | Keep exactly `"triggers": { "crons": ["* * * * *"] }` in each environment's block |
| `gtm deploy`: "still hold placeholders" | `gtm setup` has not run for this environment, or `AGENT_BASE_URL` is unset | `npx gtm setup --env staging --base-url https://...` |
| `gtm setup`: "already exists in this account" | A resource with the derived name exists but `wrangler.jsonc` does not name it | If it is yours, rerun with `--reuse-existing`; otherwise choose another Worker name |
| `gtm migrate`: "has no database id yet" | Setup has not filled the D1 id | Run `gtm setup` for that environment |

### Secrets

| Symptom | Likely cause | Check |
|---|---|---|
| `gtm doctor --remote`: "secrets ... missing: X; set each with wrangler secret put" | Set for the other environment (forgot `--env staging`, or set staging only); set only in `.dev.vars`; or the adapter is enabled but you are not using it yet | `npx wrangler secret put X --env staging`; or set the adapter's `enabled: false` |
| "could not list the deployed secrets" | Wrangler is not logged in, the login reaches another account, or the Worker does not exist yet | `npx wrangler whoami`; `CLOUDFLARE_ACCOUNT_ID`; deploy once |
| A job fails with "adapter X needs the secret Y" | The secret is missing in this environment | Set it, then wait for the next run |

### Jobs and scheduling

| Symptom | Likely cause | Check |
|---|---|---|
| No jobs run: no run rows at all | No cron trigger (doctor FAIL); the deploy failed; or the migrations never ran, so run rows cannot be written (logs say "run row could not be written") | Cron Events in the dashboard; `gtm doctor`; `gtm migrate`; `wrangler tail` |
| Every job `skipped` "halted" | `system:halt` is set | `npx gtm flags get system:halt`; unset it when ready |
| `skipped` "halt flag unreadable" or "flag unreadable" | KV could not be read; the system holds until it can | `gtm doctor --remote`; check the KV binding |
| `skipped` "flag off" after you set the flag | Set in the other environment, or within the last minute | `npx gtm flags get <key> --env staging` |
| `skipped` "budget: job_cap", "budget: daily_limit", "budget: monthly_limit" or "budget: unreadable" | The job's daily cap or a global limit is reached, or the budget could not be read | `/report cost`. A `budget:job:<job>:daily_cents` flag can only tighten a cap; a code cap rises through the job factory's `options` (for example `discoveryMaxSpendCents`), and the global limits through the `budget:*` flags |
| `skipped` "the previous run is still going" | The last run has not finished within its ceiling | Normal once; repeated means the job is slow, check its failures |
| `failed` "was not started" | Too much was due in one minute to fit the invocation | Move a long job's schedule with its job options |
| A "Cron health: <job> is missed/failed/abandoned" page | A critical job did not complete after its expected time | That job's run rows and error; the check reruns jobs that are safe to rerun |

### The operator chat

| Symptom | Likely cause | Check |
|---|---|---|
| The bot never answers, and the logs show nothing | The webhook is not registered, or points at another host | `getWebhookInfo` ([4.4](#44-telegram-operator-channel)) |
| Logs: "operator update from a chat that is not allowlisted was ignored" | Your ids are not in both allowlists | Add the logged `chatId` and `userId`, redeploy |
| "The operator agent is turned off for this deployment..." | `operator:agent_enabled` is off | Turn it on |
| Commands work but tasks fail: "has no valid price in models.pricing" or an auth error | The strategist model is unpriced, or `ANTHROPIC_API_KEY` is wrong | Price it; reset the key |
| No pages, no release messages, though chat works | `adapters["operator-telegram"].options.chatId` is unset ("no chat to deliver to") | Set it, redeploy |

### Webhooks

| Symptom | Likely cause | Check |
|---|---|---|
| `/api/webhooks/operator` answers 503 | The operator channel is not wired, or `TELEGRAM_WEBHOOK_SECRET` is unset (`verification_unavailable`) | The secret, in this environment |
| `/api/webhooks/email` answers 503 | `email_provider_not_configured`, or `RESEND_WEBHOOK_SECRET` is unset or not a valid signing secret (`verification_unavailable`) | The secret, in this environment |
| `/api/webhooks/mail` answers 503 | `push_not_configured` (`MAIL_PUSH_SECRET` unset) or `inbox_not_configured` (no mailbox wired) | The secret; `inbox` in `src/index.ts` |
| `/api/...` answers 503 `auth_not_configured` | `GATEWAY_TOKEN` is unset | Set it |
| `/u/<token>` answers 503 | `UNSUBSCRIBE_SIGNING_KEY` is unset or shorter than 32 characters | Set a longer key |
| A webhook answers 401 | The secret differs from the one the sender uses: the Telegram `secret_token`, the Resend endpoint's signing secret (from another endpoint or environment), or the push subscription's `token` | Re-register or re-copy the secret |

### Sourcing and the cold batch

| Symptom | Likely cause | Check |
|---|---|---|
| Discovery: "enrich skipped (no approved personas in the brain, ...)" | No approved, locked, uploaded `personas` | Approve, `--write-lock`, upload |
| Discovery: "search skipped (no active queries: add keyword-portfolio items to the brain)" | No `keyword-portfolio` | Add and upload it |
| Discovery: "the brain could not be read whole ..." | An approved file was edited after locking, or the upload is incomplete | `gtm brain validate --write-lock`, `gtm brain upload` |
| Discovery promotes nobody | Titles do not match persona `titles`; addresses are not deliverable under the `strict` policy; the budget stopped it ("stopped: ...") | The cycle summary; `candidates` by status; [SOURCING.md](SOURCING.md) |
| Cold batch drafts nothing | Its run row says why: "the cold batch is switched off", "cold outreach is paused (...)", "no approved cold_intro template is uploaded", "the brain could not be read whole, ...", "the account weekly cap is 0 or could not be read", "the warm-up volume for today is 0", "no room today (...)", "the suppression list could not be read", "no eligible contacts (skipped: ...)" | `q "SELECT status, summary, started_at FROM execution_runs WHERE task_name = 'cold_batch' ORDER BY started_at DESC LIMIT 5"` |
| Cold batch "held: no draft passed the gate (...)" or "readiness RED: ..." | Every draft was held or blocked (a missing variable, an unapproved claim, the reviewer unavailable), or readiness failed | `quality_checks` codes; [OUTREACH.md](OUTREACH.md#the-quality-gate) |
| A release sends nothing: `[SEND BLOCKED:disabled]` | `delivery:enabled` is off | Turn it on, send the command again |
| A release sends nothing: `[SEND BLOCKED:not_configured]` | `UNSUBSCRIBE_SIGNING_KEY`, `AGENT_BASE_URL` or the email provider is missing | `gtm doctor --remote` |
| Sends deferred: `outside_window`, `domain_cap`, `account_cap`, `circuit_open`, `cold_paused`, `halted` | The send window, a cap, the breaker, a pause or the halt | They go later through the deferred queue; [SENDING.md](SENDING.md) |

### Follow-ups

| Symptom | Likely cause | Check |
|---|---|---|
| Follow-ups are held: "inbox:enabled is off, so replies are not being recorded and the reply check would be blind" | The inbox is off | Turn on `inbox:enabled` |
| "the latest inbox poll did not list the mailbox and record everything it saw (...)" | No Gmail mailbox wired (Email Routing only), a missing secret, or a message it could not record | With Email Routing only, set `sequences:reply_intake` to `routed`; otherwise check `inbox_poll` rows |
| "the inbox poll last completed more than 10 minutes ago, ..." or "the latest inbox poll was failed, ..." | The poll is failing, halted or stopped | `inbox_poll` rows and their errors |
| `sequences:reply_intake is "...", which is neither poll nor routed` | A typo in the flag | Set `poll` or `routed`, or unset it |
| Steps wait with no release message | No servable template for the step, or a Message-ID the provider cannot return yet | The daily template notice; the Saturday stale report; [SEQUENCES.md](SEQUENCES.md#threading) |

### Inbox and replies

| Symptom | Likely cause | Check |
|---|---|---|
| Replies aren't detected | `inbox:enabled` off; `sending.replyTo` is not the watched mailbox; the poll fails with an auth error (`invalid_grant`: the refresh token was revoked, or expired after 7 days because the OAuth app is External in testing); no Email Routing rule to the Worker | `inbox_poll` rows; `npx wrangler tail`; the routing rule |
| Detected, but recorded as `ignored` with `[own_mail]` | The sender is on your company domain or is the support address | Test from an outside address |
| Replies recorded but never triaged or drafted | `replies:triage_enabled` or `replies:drafting_enabled` off; the `triage` or `writer` model unpriced; the triage job's cap reached | `replies_triage` summary and skips |
| An approved reply is not sent | `replies:send_enabled` or `delivery:enabled` off; a mailbox draft exists for it (send it from the mailbox); a newer message arrived on the thread | `replies_send` summary; [REPLIES.md](REPLIES.md#approving-and-sending) |
| Routed mail bounces back to senders | `inbox:enabled` is off and no `forwardTo` is set | Turn the inbox on, or set `forwardTo` |

## 12. Go-live checklist

Tick every item before you turn on `delivery:enabled` in production.

**Domain and provider**
- [ ] Cold mail goes from a subdomain (`sending.domain`), and `sending.from` is on it.
- [ ] SPF, DKIM, the return-path records and DMARC (`p=none` with a reporting address, to start) resolve for the sending subdomain, and the provider shows the domain verified.
- [ ] The Resend webhook endpoint for production is registered for delivered, bounced, complained and failed events, and an unsigned request to it answers 401.
- [ ] `usdPerEmail` matches your plan.

**Compliance**
- [ ] `sending.postalAddress` is your real postal address.
- [ ] `AGENT_BASE_URL` is the production origin you will keep, and `/u/<anything>` answers 400 (not 503).
- [ ] A test send to your own inbox is plain text, carries the footer and a working unsubscribe link, and replies land in `sending.replyTo`.
- [ ] The inbox is recording (stage 3), so a reply saying "unsubscribe" suppresses the sender.

**Configuration and content**
- [ ] `gtm doctor --remote` passes in production, with the halt flag and both kill-switch keys unset.
- [ ] The brain and templates are approved, locked and uploaded to production, and `gtm brain diff` shows no differences.
- [ ] Templates use only variables you have data for; a sample batch's drafts read well.
- [ ] Every model you use is priced from the provider's current price list.

**Controls**
- [ ] `budget:daily_limit_cents` and `budget:monthly_limit_cents` are set to what you will spend, and `budget:enforcement` is `hard`.
- [ ] `outreach:ramp_level` is 0, `outreach:ramp_auto` is off, and `cold_batch:auto_approve` is off.
- [ ] Your chat receives pages (`options.chatId` is set), and you know how to halt (`gtm flags set system:halt ...`) and pause cold outreach.
- [ ] Staging has run every stage for at least a few days, and staging's `delivery:enabled` is off.
- [ ] You keep a copy of every secret, the `gtm flags list` output, and the brain in git.

## 13. Reference: scheduled jobs

Every job the template registers, its schedule (UTC), the flag that gates it and its ceilings. Critical jobs are watched by the cron health check. Schedules change through each `create*Jobs` factory's `options`; a job that calls a model refuses a schedule more often than every 15 minutes.

| Job | Schedule (UTC) | Flag | Critical | Ceilings | Spends on |
|---|---|---|---|---|---|
| `discovery_cycle` | 09:00, Monday to Friday | `discovery:enabled` | Yes | 10 min, 500 new rows, 300 cents a day | Search, lookups, verification |
| `account_prescore` | 04:00 daily | `fit:prescore_enabled` | | 2 min, 5,000 accounts | Nothing |
| `account_fit_scoring` | Every 15 minutes | `fit:scoring_enabled` | | 5 min, 100 accounts, 100 cents a day | `classifier` model |
| `cold_batch` | 13:00, Monday to Thursday | `cold_batch:enabled` | Yes | 5 min, 1,500 drafts, 50 cents a day | `judge` model (reviewer on) |
| `delivery_replay` | 00:00, 08:00, 13:00, 20:00, Monday to Friday | `delivery:enabled` | | 4 min, 200 rows | Emails |
| `delivery_bounce_monitor` | 09:00 daily | `delivery:enabled` | Yes | 1 min | Nothing |
| `delivery_ramp` | 09:30, Monday to Friday | `outreach:ramp_auto` | | 30 s | Nothing |
| `delivery_liveness` | 21:00, Monday to Friday | `cold_batch:enabled` | | 30 s | Nothing |
| `inbox_poll` | Every minute | `inbox:enabled` | | 50 s | Nothing |
| `inbox_sweep` | Every 15 minutes | `inbox:enabled` | Yes | 2 min | Nothing |
| `inbox_watch_renewal` | 06:20 daily | `inbox:enabled` | Yes | 30 s | Nothing |
| `replies_triage` | Every 15 minutes | `replies:triage_enabled` | | 5 min, 10 messages, 100 cents a day | `triage` and `writer` models |
| `replies_mirror` | Every 15 minutes | `replies:mirror_enabled` | | 2 min, 20 rows | Nothing |
| `replies_send` | Every 5 minutes | `replies:send_enabled` | | 2 min, 10 drafts | Nothing |
| `replies_reminders` | Every 5 minutes | `replies:reminders_enabled` | | 1 min, 50 rows | Nothing |
| `sequence_sweep` | 08:30, 12:30, 16:30, 20:30, Monday to Friday | `sequences:enabled` | Yes | 4 min, 200 rows, 25 cents a day | `judge` model (reviewer on), emails |
| `sequence_stale_check` | 10:00, Saturdays | `sequences:enabled` | | 30 s, 500 rows | Nothing |
| `daily_scorecard` | 12:00, Monday to Friday | `ops:daily_scorecard` | | 1 min, one message | Nothing |
| `funnel_digest` | 09:00, Mondays | `ops:funnel_digest` | | 1 min, one message | Nothing |
| `cost_digest` | 14:00, Monday to Friday | `ops:cost_digest` | | 30 s, one message | Nothing |
| `calendar_sync` | Every 15 minutes | `convert:calendar_enabled` | Yes | 2 min, 500 events | Nothing |
| `meeting_followups` | 5, 20, 35 and 50 past each hour | `convert:calendar_enabled` | | 1 min, 200 meetings | Nothing |
| `deal_handoffs` | 10 past each hour | `convert:handoff_enabled` | | 30 s, 20 deals | Nothing |
| `event_sweep` | Every 5 minutes | none (it retries deletions whatever the flags; each source's own flag holds everything else) | | 2 min, 100 rows | Nothing |
| `lifecycle_checks` | 20 past each hour | `lifecycle:enabled` | | 2 min, 400 rows | Nothing |
| `lifecycle_reconcile` | 03:15 daily | `lifecycle:reconcile_enabled` | | 10 min, 1,800 rows | Nothing |
| `mrr_snapshot` | 23:55 daily | `lifecycle:enabled` | | 30 s, 1 row | Nothing |
| `event_retention` | 03:50 daily | `lifecycle:enabled` | | 2 min, 500 rows | Nothing |
| `autonomy_review` | 06:00, Mondays | `autonomy_review:enabled` | | Proposals only | Nothing |
| `autonomy_watch` | 15 past each hour | none (demotion always runs) | | Incidents, rate checks, notices | Nothing |
| `run_retention` | 03:40 daily | `ops:retention_enabled` | | 2 min, 20,000 rows | Nothing |
| `cron_health` | 10:30 and 15:30 daily (`cronHealth.schedule`) | none | | 2 min | Nothing |

Chat turns are not scheduled jobs; each writes a run row with `task_name` `operator_chat` and trigger `chat`. `gtm doctor` prints every flag with its default, and `gtm flags list` prints the deployed values.

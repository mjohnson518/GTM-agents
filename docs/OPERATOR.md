# The operator chat

This page is for deployers who want to talk to their agent from a chat app: it covers creating the Telegram bot, the secrets, wiring and registering the webhook, the allowlist, the commands, approvals, sessions and taint, and the flag that turns the agent on. Contributors writing another channel adapter should read [INTERFACES.md](INTERFACES.md#operatorchannel) for the port; the security reasoning behind sessions and taint is in [SECURITY-MODEL.md](SECURITY-MODEL.md).

## How a message is handled

```
Telegram -> POST /api/webhooks/operator
              1. the adapter verifies the secret-token header (constant time); bad: 401
              2. core checks the allowlist; a stranger gets 200 and no reply
              3. the update id is claimed in the effects ledger; a redelivery is a no-op
              4. operator:agent_enabled off: "the agent is turned off"
              5. a message is rate limited per chat and goes to CHAT_QUEUE;
                 a button tap is handled at once
CHAT_QUEUE -> the chat consumer
              a command (/clean, /status, /help) runs without the model
              anything else runs one hub agent turn, replies, and sends an
              approval request for every draft the turn created
```

Nothing touches the database before the update is verified. The agent never sends email from chat: approving a draft marks it approved, and sending is a separate path with its own gates.

## 1. Create the bot

1. In Telegram, open a chat with @BotFather and send `/newbot`. Pick a name and a username.
2. BotFather answers with a bot token. Treat it as a password.
3. Optional: send `/setprivacy` and keep privacy mode on, so the bot only sees messages addressed to it in groups.

## 2. Set the secrets

Secrets never go in `gtm.config.ts`, `wrangler.jsonc` or the repository. Set each with Wrangler, from your deployment directory:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN        # the token from BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # a random string, for example: openssl rand -hex 32
npx wrangler secret put ANTHROPIC_API_KEY         # the model gateway's provider key
npx wrangler secret put GATEWAY_TOKEN             # bearer token for /api/*, for example: openssl rand -hex 32
```

`TELEGRAM_WEBHOOK_SECRET` may hold only letters, digits, underscores and hyphens, up to 256 characters; hex output qualifies. For local development, put the same names in `.dev.vars`, which is gitignored.

| Secret | Used for | When it is unset |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Sending replies and approval requests | Replies fail; updates are still verified |
| `TELEGRAM_WEBHOOK_SECRET` | Verifying every update | The webhook answers 503 to everything |
| `ANTHROPIC_API_KEY` | The hub agent's model calls | Tasks fail with an auth error; commands still work |
| `AI_GATEWAY_TOKEN` (optional) | Authenticating to Cloudflare AI Gateway | Calls go through the gateway unauthenticated, or directly |
| `GATEWAY_TOKEN` | Bearer auth on every `/api/*` route except webhooks | Those routes answer 503 |

## 3. Wire the worker

Give `createWorker` the operator channel and the model gateway. Each factory builds the adapter from the Worker environment, so secrets are read per request and never copied into code:

```ts
// apps/worker/src/index.ts
import { createWorker } from "@gtm-agents/core";
import { createAdapterContext } from "@gtm-agents/core/adapters";
import { createAdapter as telegram } from "@gtm-agents/adapters/operator-telegram";
import { createAdapter as anthropic } from "@gtm-agents/adapters/llm-gateway";
import config from "../gtm.config.ts";

export { FollowupAgent, OperatorGateway } from "@gtm-agents/core/durable-objects";

export default createWorker(config, {
  jobs: [],
  queueConsumers: {},
  operator: (env) => telegram(createAdapterContext({ name: "operator-telegram", env: { ...env }, config })),
  model: (env) => anthropic(createAdapterContext({ name: "llm-gateway", env: { ...env }, config })),
  // The names of the queues bound as CHAT_QUEUE in wrangler.jsonc, one per environment. `gtm setup`
  // names them <worker name>-chat. A chat message arriving on an unlisted queue is still handled,
  // with a warning in the logs, so list your names to keep the logs clean.
  agent: { chatQueue: ["gtm-agent-chat", "gtm-agent-staging-chat"] },
});
```

The same `operator` channel also delivers job failure pages and cron health pages. Add `@gtm-agents/adapters` to the worker's dependencies.

In `gtm.config.ts`, enable the adapters, give the strategist role a model, and price it. A model without a price is never called, because its cost could not be recorded:

```ts
adapters: {
  "operator-telegram": { options: { chatId: "123456789" } },   // where job pages, release messages and alerts go
  "llm-gateway": { options: {} },
},
models: {
  roles: { strategist: "claude-opus-5-5" },
  pricing: { "claude-opus-5-5": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } },
},
```

`llm-gateway` options, none of them secret:

| Option | Meaning |
|---|---|
| `aiGatewayBaseUrl` | Route through Cloudflare AI Gateway: the gateway's provider URL ending in `/anthropic`. Run, turn and job ids are sent as gateway metadata |
| `byok` | With an authenticated gateway, leave the provider key out and let the gateway supply its stored key |
| `anthropicVersion` | The `anthropic-version` header. Defaults to `2026-10-21` |
| `promptCache` | Mark the system prompt for prompt caching. Defaults to `true` |
| `fallbacks` | `"default"` turns on the provider's server-side fallback for refused requests |
| `roles` | A model id per role, used only when core sends no model id |

`operator-telegram` options: `chatId`, the default chat for messages core sends without one, and `apiBaseUrl` for a self-hosted Bot API server. Set `chatId` in practice: without it, job failure pages, cron health pages, batch and sequence release messages and delivery alerts have no chat to go to and fail ("no chat to deliver to").

## 4. Register the webhook

Call the Bot API once after deploying, with your deployment's public URL (the CLI never reads your secrets, so it does not do this for you):

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d url="https://agent.acme.example/api/webhooks/operator" \
  -d secret_token="${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","callback_query"]'
```

Telegram then sends every update with the `X-Telegram-Bot-Api-Secret-Token` header, and the adapter rejects any update without the exact value. The adapter's `registerWebhook(url)` makes the same call.

## 5. Allow yourself in

Authorization is core's decision, not the channel's. A chat is served only when its chat id is in `operator.allowedChatIds` **and** its user id is in `operator.allowedUserIds`. Either list empty denies everyone, so a fresh deployment answers no one.

```ts
operator: { allowedChatIds: ["123456789"], allowedUserIds: ["123456789"] },
```

In a private chat with the bot, the chat id and your user id are the same number, so list it in both. To find it, message the bot and watch the Worker's logs (`npx wrangler tail`): an update from a chat that is not allowlisted is logged with its `chatId` and `userId`, and otherwise ignored. In a group, the chat id is the group's (a negative number) and each person who may command the agent needs their own user id listed.

## 6. Turn the agent on

The agent runs only while the `operator:agent_enabled` flag is on. It defaults to off, and a value that cannot be read counts as off. While it is off, the webhook still verifies updates, and an allowlisted operator is told the agent is turned off.

```bash
npx gtm flags set operator:agent_enabled true
```

`npx gtm flags unset operator:agent_enabled` turns it off again. `gtm doctor` lists the flag with every other flag.

## Commands

| Command | What it does |
|---|---|
| `/clean` | Starts a clean session: deletes this chat's history and resets its taint, together |
| `/status` | The session's taint, how many messages it holds, drafts waiting for approval, today's chat spend, the strategist model |
| `/help` (or `/start`) | What the agent can do and how sessions, taint and approvals work |

The other capabilities add their own commands, documented with them. `/help` lists every one:

| Command | What it does |
|---|---|
| `/replies` | Replies waiting on you, oldest first ([REPLIES.md](REPLIES.md)) |
| `/reply_done <id>`, `/reply_ignore <id>` | Mark a reply answered by hand, or as needing no answer |
| `/reply_send <draft id>`, `/reply_draft <id>` | Send an approved reply now, or show its draft again for approval |
| `/scorecard` | The daily scorecard, as of now ([MEASUREMENT.md](MEASUREMENT.md)) |
| `/report conversion [template\|subject\|cohort\|segment\|persona]`, `/report funnel`, `/report cost`, `/report holdout` | Read-only reports, from the same metric definitions as the scorecard |
| `batch-release-<id>-<code>` | Release the day's cold batch ([OUTREACH.md](OUTREACH.md)) |
| `sequence-release-<id>-<code>` | Release the follow-ups a sweep put up ([SEQUENCES.md](SEQUENCES.md)) |
| `sequence-resume-<contact id>` | Resume a contact's paused sequence |
| `channel-done-<id> [linkedin\|x]`, `channel-skip-<id>` | Record or skip the optional manual touch before the last step |
| `/meetings`, `prep-<contact id or email>` | Meetings the calendar shows, and a one-page brief on any contact ([CONVERT.md](CONVERT.md)) |
| `meeting-held-<code>`, `meeting-noshow-<code>`, `meeting-notes-<code> <notes>` | Record how a meeting went, and keep notes |
| `meeting-link-<code> <contact>`, `meeting-unlink-<code>` | Attribute an ambiguous meeting to a contact, or make a meeting inert |
| `autonomy-status` | Every action class with its level and evidence ([AUTONOMY.md](AUTONOMY.md)) |
| `autonomy-set <class> <0-3>`, then `autonomy-confirm-<id>-<code>` | Propose a level change, then confirm it within 30 minutes; permanently human-only classes stay at 1 or below |
| `autonomy-dismiss-<id> [reason]` | Drop an open autonomy proposal (yours or the weekly review's) so it can never be confirmed; no level changes |
| `experiment-create`, `experiment-update <id>`, `experiment-show <id>`, `experiment-list`, `experiment-stop <id>`, then `experiment-start <id>` and `experiment-start-<id>-<code>` | Pre-register, amend, start (two-step) and stop experiments ([EXPERIMENTS.md](EXPERIMENTS.md)) |
| `subject-test-create`, `subject-test-stop <id>` | A subject-line test on one template |
| `exp-list`, `exp-approve-<id>`, `exp-reject-<id>`, `ab-dashboard`, `sample-size <baseline> <mde>` | Copy-change and self-review proposals, the A/B report, and the sample-size helper |
| `learning-list [kind]`, `learning-show <id>`, `learning-approve-<id>-<code>`, `learning-reject-<id>`, `learnings` | Proposals from the self-improvement loops, and the learnings document ([LEARNING.md](LEARNING.md)) |
| `objection-list`, `objection-answer <id> <answer>`, `voice-build <thread id> ...`, `voice-status`, `fitness [days]` | Objection answers, the voice profile and the fitness trend |
| `fu-approve-<id>`, `fu-reject-<id>` | Lifecycle follow-ups waiting for a person ([LIFECYCLE.md](LIFECYCLE.md)) |

The optional ship module adds `ship-themes`, `ship-spec-<id>`, `ship-approve-<id> <code>`, `ship-decline-<id>`, `ship-note-approve-<id> <code>` and `ship-note-decline-<id>` when it is wired ([SHIP.md](SHIP.md)). Most of these actions can also be taken from the dashboard ([DASHBOARD.md](DASHBOARD.md)), with the same checks.

Commands never reach the model, and each runs once per message even if the channel redelivers it. `/clean@YourBot` forms work in groups. Anything that is not a command is a task for the hub agent.

## What the agent can do

The hub agent has three tools:

| Tool | What it does | Class |
|---|---|---|
| `web_fetch` | Reads one public web page as text: http and https only, every redirect validated, at most 512 KB, HTML and plain text only | Full taint; allowed in any session |
| `contacts_search` | Looks people up in your contact records: at most 20 rows | Metadata taint; allowed in any session |
| `drafts_create` | Writes one plain-text draft that waits for your approval | Refused once the session has read a web page |

A draft's recipient must be exactly one valid address, or the draft is refused: the agent asks you rather than guessing. Drafts written in chat are one-offs you asked for; cold sequence steps are assembled from your templates, never written by the model.

## Sessions and taint

Each chat has one session. Its **taint** is the least trusted text the session has read: `none`, `metadata` (contact records, snippets), `structured` or `full` (a raw web page). Taint only rises, and it persists across turns until you send `/clean`, because the text is still in the conversation the model sees.

Once a session has read a web page, `drafts_create` is refused for the rest of that session, mechanically, whatever the model asks for. A page can hide instructions; this is what keeps a page from turning into a draft. The reply tells you when this happens.

So "research and a draft" takes two steps, and you are the bridge between them:

1. Ask for the research: "look at https://acme.example/pricing and draft a short intro to jane@acme.example". The agent reads the page and replies with what it found, and with a note that drafting is refused in this session.
2. Send `/clean`, then ask for the draft with the facts you want used: "Draft a short intro to jane@acme.example. Facts: three plans, setup takes under an hour." The clean session can look Jane up and write the draft.

Nothing carries the research into the clean session for you. Retyping or pasting the facts is the point: a person reads the untrusted text and decides what is true. A task that needs no web page (a draft from facts you give, or from your contact records) works in one message.

## Approvals

Every draft a turn creates comes back as an approval request showing the whole draft, with Approve and Reject buttons. Each button carries the draft's id and the digest of exactly the text you were shown.

- **Approve** re-reads the draft from the database, checks that its current digest matches the button and the record of what you were shown, and marks it approved. Nothing is sent.
- If the draft changed after you saw it, the tap is refused and a fresh approval request shows the current text.
- **Reject** marks the draft rejected.
- A draft too long to show in one message is never shown truncated; the request fails and the draft stays pending.

## Costs and limits

| Limit | Default | Change it with |
|---|---|---|
| Spend per chat turn, checked before every model call and every tool | $0.50 | `chat:turn_max_cents` |
| Spend per day for all chat turns | none | `budget:job:operator_chat:daily_cents` |
| Global daily and monthly limits (in `hard` mode) | $20, $500 | `budget:*` flags |
| Model rounds per turn | 8 | `agent.maxRounds` in `createWorker` |
| Messages per chat | 30 a minute | Fixed: the `chat` category in `RATE_LIMITS` (`packages/core/src/security/rate-limiter.ts`) |
| Page fetches | 40 an hour | Fixed: the `web` category in `RATE_LIMITS` |

Every model call writes a row to the cost ledger with the turn, its run and the job `operator_chat`, priced from `models.pricing`. Each turn writes one row to `execution_runs` with trigger `chat`. A turn is never retried automatically: ask again instead.

## When something is wrong

| Symptom | Likely cause |
|---|---|
| The bot never answers, and logs show nothing | The webhook is not registered, or Telegram is calling another URL |
| Logs show "not allowlisted" | Add the logged chat id and user id to both lists |
| Webhook answers 401 | `TELEGRAM_WEBHOOK_SECRET` differs from the `secret_token` you registered |
| Webhook answers 503 | The operator channel is not wired, or `TELEGRAM_WEBHOOK_SECRET` is unset |
| "The operator agent is turned off" | Set `operator:agent_enabled` to `true` |
| "No model gateway is configured" | Pass `model` to `createWorker` |
| "has no valid price in models.pricing" | Price the strategist model in `gtm.config.ts` |
| "drafting is refused" | The session read a web page; send `/clean` and give the facts |
| `/api/...` answers 503 | `GATEWAY_TOKEN` is unset |

Every route under `/api/webhooks/` skips the bearer token and must verify its own signature. If you mount your own route there, verify the request before reading or writing anything.

Forwarded messages and messages sent through an inline bot are ignored: they carry someone else's text, not your instructions. Paste the text into a message of your own instead.

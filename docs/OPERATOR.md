# The operator chat

This page is for deployers who want to talk to their agent from a chat app: it covers creating the Telegram bot, the secrets, wiring and registering the webhook, the allowlist, the commands, approvals, sessions and taint, timers the agent sets for itself, notes it keeps across sessions, quiet hours and pacing for the notices the system sends you, and the flag that turns the agent on. Contributors writing another channel adapter should read [INTERFACES.md](INTERFACES.md#operatorchannel) for the port; the security reasoning behind sessions and taint is in [SECURITY-MODEL.md](SECURITY-MODEL.md).

## How a message is handled

```
Telegram -> POST /api/webhooks/operator
              1. the adapter verifies the secret-token header (constant time); bad: 401
              2. core checks the allowlist; a stranger gets 200 and no reply
              3. the update id is claimed in the effects ledger; a redelivery is a no-op
              4. operator:agent_enabled off: "the agent is turned off"
              5. a message is rate limited per chat and goes to CHAT_QUEUE;
                 a button tap is handled at once
CHAT_QUEUE -> the chat consumer, one delivery at a time
              a command (/clean, /status, /timers, /help) runs without the model
              anything else runs one hub agent turn, replies, and sends an
              approval request for every draft the turn created
              (with operator:chat_batching on, messages sent in a row share
              one turn: see below)
              a timer the agent set runs one hub agent turn in the session
              that set it ([Timers](#timers))
```

Nothing touches the database before the update is verified. The agent never sends email from chat: approving a draft marks it approved, and sending is a separate path with its own gates. Replies to your messages always come at once; the notices the system starts itself (reports, sweeps, reminders) can wait out quiet hours with the outbox on ([Quiet hours and the outbox](#quiet-hours-and-the-outbox)).

### Messages sent in a row

The chat consumer runs one delivery at a time (`max_concurrency: 1`), so whatever you send while a turn is running waits in the queue. The template takes one message per delivery (`max_batch_size: 1`), so every message gets its own turn, its own reply and its own invocation.

To let messages sent in a row share one turn, raise `max_batch_size` on the chat queue's consumer in `wrangler.jsonc` (3 to 5 is plenty), deploy, then turn on `operator:chat_batching`. Adjacent messages for the model in one delivery, from you in the same chat and session, then share one turn:

- They are joined in the order you sent them, separated by a blank line, and the agent answers once. "Find contacts at acme.example", then "and at globex.example too", is one task with one reply.
- A command is never joined. It runs on its own, in its place: "summarize the pipeline", `/status`, "now list the open drafts" is a turn, the status, then a second turn.
- The queue does not keep order, so before anything runs, each chat's messages in a delivery are put back in the order you sent them (by Telegram's message id). A `/clean` between two tasks stays between them. Messages that arrive in different deliveries are answered in the order they arrive, so when the order matters across a pause, wait for the reply before sending the next message.
- Another person in a group chat, another chat, or a joined text over 8,000 characters (what the session history keeps of one message) starts a new turn.
- The shared turn is one turn for every limit: one `chat:turn_max_cents` ceiling, one run row, at most `agent.maxRounds` model rounds.
- Each message is still claimed on its own, so a redelivered message is never answered twice, whether it arrives alone or with others.

```bash
npx gtm flags set operator:chat_batching true
```

The flag changes nothing while `max_batch_size` is 1; `npx gtm doctor --remote` warns when it is on but cannot merge anything, and when the consumer's `max_concurrency` is not 1. Keep `max_batch_timeout` at 0: a message that arrives while nothing is running is delivered at once, never held back to wait for others.

Know the trade-off of a larger batch: every run in one delivery shares that invocation's 15-minute wall time. Commands are quick and merged messages are one turn, but several long tasks in separate sessions, or with the flag off, run one after another. So the consumer starts no run once 10 minutes of a delivery have passed: the messages it has not reached go back to the chat queue, unanswered and unclaimed, and a later delivery answers each of them once. They go to the back of the queue, so a message sent after them can be answered first. A single turn that itself runs past the invocation's limit is still cut off; `agent.maxRounds` and the turn ceiling bound it. That is why the template keeps 1. Off, or unreadable, every message is its own turn.

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

The same `operator` channel also delivers job failure pages and cron health pages. Add `@gtm-agents/adapters` to the worker's dependencies. The template wraps the channel in the outbox, which holds notices for quiet hours once you turn it on ([Quiet hours and the outbox](#quiet-hours-and-the-outbox)).

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
| `/clean` | Starts a clean session: deletes this chat's history and resets its taint, together, and cancels its waiting timers |
| `/status` | The session's taint, how many messages it holds, drafts waiting for approval, today's chat spend, the strategist model |
| `/notes`, `/notes forget <id>`, `/notes forget all` | The notes the agent saved for the deployment, with the taint each keeps, and forgetting them ([Notes](#notes)); works in the dashboard too |
| `/timers`, `/timers cancel <id>`, `/timers cancel all` | The timers the agent set in this chat, with when each is due and the taint it carries, and cancelling them ([Timers](#timers)) |
| `/outbox`, `/outbox send` | The notices held for quiet hours, the hourly limit or a Telegram error, with why each waits, and releasing them all to arrive with the next outbox run ([Quiet hours and the outbox](#quiet-hours-and-the-outbox)) |
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
| `watch-add <domain>`, `watch-remove <domain>`, `watch-list` | Pin an existing account so the weekly account watch always covers it, unpin it, and see every pinned account and what the next watch covers ([SIGNALS.md](SIGNALS.md#account-watch)) |
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

The hub agent has three tools, plus `timer_set` while `operator:timers_enabled` is on and the note tools while `operator:notes_enabled` is on:

| Tool | What it does | Class |
|---|---|---|
| `web_fetch` | Reads one public web page as text: http and https only, every redirect validated, at most 512 KB, HTML and plain text only | Full taint; allowed in any session |
| `contacts_search` | Looks people up in your contact records: at most 20 rows | Metadata taint; allowed in any session |
| `drafts_create` | Writes one plain-text draft that waits for your approval | Refused once the session has read a web page |
| `timer_set` | Sets a timer that starts a later turn in this chat ([Timers](#timers)) | Refused once the session has read a web page |
| `note_save` | Saves a short note that later sessions see ([Notes](#notes)) | Refused once the session has read a web page; the note keeps the session's taint |
| `notes_read` | Reads saved notes by id | Allowed in any session; raises it to at least `metadata` |

A draft's recipient must be exactly one valid address, or the draft is refused: the agent asks you rather than guessing. Drafts written in chat are one-offs you asked for; cold sequence steps are assembled from your templates, never written by the model.

## Sessions and taint

Each chat has one session. Its **taint** is the least trusted text the session has read: `none`, `metadata` (contact records, snippets), `structured` or `full` (a raw web page). Taint only rises, and it persists across turns until you send `/clean`, because the text is still in the conversation the model sees.

Once a session has read a web page, `drafts_create` is refused for the rest of that session, mechanically, whatever the model asks for. A page can hide instructions; this is what keeps a page from turning into a draft. The reply tells you when this happens.

So "research and a draft" takes two steps, and you are the bridge between them:

1. Ask for the research: "look at https://acme.example/pricing and draft a short intro to jane@acme.example". The agent reads the page and replies with what it found, and with a note that drafting is refused in this session.
2. Send `/clean`, then ask for the draft with the facts you want used: "Draft a short intro to jane@acme.example. Facts: three plans, setup takes under an hour." The clean session can look Jane up and write the draft.

Nothing carries the research into the clean session for you. Retyping or pasting the facts is the point: a person reads the untrusted text and decides what is true. A task that needs no web page (a draft from facts you give, or from your contact records) works in one message.

## Timers

With `operator:timers_enabled` on, the agent can set a timer for itself. Ask "check the reply queue tomorrow at 9 UTC" or "in two hours, look at the Globex thread again", and it calls `timer_set` with a time and a short note saying what to do. When the timer is due, the note starts a new turn in the same chat, and the reply comes to you headed with the timer's id. Nothing else about the turn is special: it has the same tools, gates, approvals and limits as a turn you started.

To turn timers on:

1. Make sure the Worker registers the timer job. The template does (`createOperatorTimerJobs` in `apps/worker/src/index.ts`); an entry written before timers existed adds `...createOperatorTimerJobs<Env>({ operator })` from `@gtm-agents/core/operator` to its `jobs`, passing the same `operator` channel factory the other jobs take, so timers that expire are reported. Without the job the agent never offers `timer_set`, whatever the flag says.
2. Apply the migrations (`npx gtm migrate`), which create `operator_timers`.
3. Turn the flag on:

```bash
npx gtm flags set operator:timers_enabled true
```

How a timer runs:

```
timer_set, in a chat turn     writes a pending timer: the chat, you, the note, the due time,
                              and the session's taint and last /clean at that moment
operator_timers, every minute no model call: expires timers too late to fire, then sends
                              each due timer to CHAT_QUEUE carrying only its id
CHAT_QUEUE consumer           reads the timer, checks it can still fire, claims it once,
                              and runs one hub agent turn in the session that set it
```

Timers follow the session's taint:

- A timer remembers the session's taint when it was set, and the turn it starts begins at least that tainted. A timer set after a contact lookup starts a turn at `metadata` or higher, whatever happened in the chat since: higher when the session read more since.
- `timer_set` is refused once the session has read a web page, like `drafts_create`, so a page can never schedule work.
- A timer that carries taint cannot set another: its turn is not offered `timer_set`. A repeating check ("every morning") works from a clean session only, so text picked up from a record can never keep scheduling turns.
- `/clean` cancels the session's waiting timers, and a timer never runs in a session cleared after it was set, even one that was somehow not cancelled: its note belongs to the conversation `/clean` ended.
- The note is text the agent wrote. When the timer carries taint, the turn sees the note fenced as untrusted data, as it would see a tool result at that taint.
- A timer's message is never read as a command and never shares a turn with your messages, whatever `operator:chat_batching` says.

| Bound | Value |
|---|---|
| When it can be due | 5 minutes to 14 days after it is set; an exact time must carry a timezone |
| Timers waiting per chat | 5 |
| Note | 500 characters |
| Timers fired per day, across the deployment | 20, set with `operator:timers_daily_max` (at most 200; a value that cannot be read is 0) |
| Late | A timer more than 6 hours late (the agent was off, an outage) expires instead of firing, and so does one queued whose message never arrived |
| Spend | A timer's turn is a chat turn: `chat:turn_max_cents` and `budget:job:operator_chat:daily_cents` apply |

What stops a timer: `/timers cancel <id>`, `/timers cancel all` and `/clean`. While `operator:agent_enabled` is off nothing fires, and timers wait until they become too late. While `operator:timers_enabled` is off, `timer_set` is not offered and nothing fires, but `/timers` still lists and cancels. A timer whose operator was removed from the allowlist is cancelled when it comes due, and the halt flag stops the job like any job. A timer that expires without running is reported to its chat as a notice: its id, when it was due, why it expired (too late, its message never arrived, or no model gateway is configured) and the first line of its note, so you can ask again if it still matters. One notice per chat covers every timer that expired at once, and like any notice it waits out quiet hours with the outbox on. A timer the system cancels (its operator was removed, or its session was cleared) is not announced; it leaves `/timers`. The job leaves a run row every minute, a skipped one while the flag is off; `ops:retention_enabled` deletes skipped rows after 7 days.

## Notes

With `operator:notes_enabled` on, the agent keeps short notes across sessions and `/clean`: "remember that I want drafts under 80 words", "the Globex pilot started on 3 November and Sam is the champion". Notes belong to the deployment, so a note saved in the operator chat is there in the dashboard's chat too. The agent saves one only when you ask it to remember something or state a lasting preference.

```bash
npx gtm migrate                                  # creates operator_notes
npx gtm flags set operator:notes_enabled true
```

A note keeps the taint of the session that saved it, and that decides how later turns see it:

- **A note saved with no taint** was written from your words, the approved brain and the deployment's own data only. Every turn sees it at the start of your message, as a fact or preference an operator gave, with where it was saved (the operator chat or the dashboard), including the first turn after `/clean`.
- **A note saved after reading third-party text** (a contact lookup, say) is never shown on its own. A turn sees only its id, date and taint, and reads its text with `notes_read` only when you name the note or ask for what it holds. Reading any note raises that turn's session to at least `metadata` (higher for a note saved at `structured`), exactly as reading the record again would.
- `note_save` is refused once the session has read a web page, like `drafts_create`, so a page can never leave a note behind. Saving a note after reading a tainted one keeps the higher taint, so a note can never become cleaner by being copied.

So `/clean` still starts a clean session: clean notes are clean, and nothing tainted comes in unless the agent reads it on purpose. If you want a tainted note's fact treated as clean, tell the agent the fact yourself in a clean session and forget the old note.

| Bound | Value |
|---|---|
| Notes kept | 50, for the deployment, of which at most 10 saved after reading third-party text; `note_save` is refused when full, never replacing an old note |
| Saved in one turn | 3 |
| One note | 500 characters |
| Shown in each turn | Clean notes, newest first, up to 4,000 bytes (about eight full-length notes); the rest are listed by id (up to 20). Forget old notes to keep the ones that matter shown |
| Read at once | 5 notes per `notes_read` call |

`/notes` lists every note with the taint it keeps, and `/notes forget <id>` or `/notes forget all` deletes them; both work whether the flag is on or not. Erasing a person deletes every note that names one of their addresses. While the flag is off, no note is read or saved.

## Quiet hours and the outbox

With `operator:outbox_enabled` on, the messages the system starts itself (reports and digests, sweep, batch and booking notices, reply reminders, a timer's reply) go through an outbox, so they can wait for a better moment and arrive together:

- **Quiet hours.** During `operator.quietHours` in `gtm.config.ts`, notices are held. When the quiet hours end they arrive as one message per chat, oldest first, each with the time it was written.
- **The hourly limit.** Once a chat has had `operator:outbox_hourly_max` notices (12 by default) in the current UTC hour, later ones that hour are held and arrive together at the next hour. Notices folded into one message count once. At 0, every notice arrives in one message an hour.
- **Retries.** A notice Telegram refuses with a retryable error (rate limited, unavailable) is kept and tried again after about 5, 10, 20 and 40 minutes, then hourly. A notice is dropped a day after it was written and a page after a week, with an error in the logs. Any other error is reported to the code that sent it, as without the outbox.

Some messages are never held:

| Message | With the outbox on |
|---|---|
| Replies to your messages and commands, including the preview `fu-approve` shows of a changed lifecycle follow-up | Delivered at once, always |
| Pages: job failure, escalation, cron health and dead-letter pages; delivery pages (circuit breaker, bounces and complaints, the deferred queue, liveness); a cold batch held at readiness RED; autonomy demotions and the autonomy watch's failures; the alert for an opt-out that could not be written | Delivered at once, silently (no sound) during quiet hours, and retried when Telegram refuses them |
| Approval requests | Delivered at once, silently during quiet hours. An approval binds to exactly what you were shown, so a request is never held |
| A message with buttons | Delivered at once |
| Everything else | Held during quiet hours and over the hourly limit |

To turn it on:

1. Wrap the channel and register the delivery job. The template does both in `apps/worker/src/index.ts`. An entry written before the outbox existed changes its `operator` factory and adds the job:

   ```ts
   import { createOperatorOutboxJobs, withOperatorOutbox } from "@gtm-agents/core/operator";

   const operator = (env: Env) =>
     withOperatorOutbox(createTelegram(context(env, "operator-telegram")), { db: env.DB, flags: kvFlagReader(env.KV), quietHours: config.operator.quietHours });
   const outbox = createOperatorOutboxJobs<Env>({ operator });
   // jobs: [..., ...outbox]
   ```

   Pass the same wrapped `operator` to `createWorker` and to every job factory. The job always delivers through the channel inside the wrapper, never back through the outbox.
2. Set quiet hours in `gtm.config.ts`, if you want them: whole hours in your own time zone, start inclusive and end exclusive. The window may cross midnight. Without them, notices are held only over the hourly limit.

   ```ts
   operator: {
     allowedChatIds: ["123456789"],
     allowedUserIds: ["123456789"],
     quietHours: { start: 22, end: 7, timeZone: "America/New_York" },
   },
   ```

3. Apply the migrations, which create `operator_outbox`, and turn the flag on:

   ```bash
   npx gtm migrate
   npx gtm flags set operator:outbox_enabled true
   ```

A lifecycle follow-up's preview that the outbox holds does not count as shown: `fu-approve` then shows it to you first, as it does for one you never saw.

`/outbox` lists what is held and why, and `/outbox send` releases all of it, quiet hours or not, to arrive with the next outbox run. The `operator_outbox` job runs every five minutes, makes no model call, and has no flag of its own, so turning the outbox off never strands a notice: anything still held goes out with the next run. The outbox never loses a notice to its own failures either: one that cannot be held or counted goes to Telegram at once. The table keeps a notice's text only while it waits. Delivered and dropped rows are deleted after two days, and erasing a person deletes every held notice that names one of their addresses. With the flag off, or unreadable, every message goes straight to Telegram; while it is unreadable the job keeps quiet hours for what is already held, and only a flag that reads off releases everything at once. The halt flag stops the job like any job, so held messages wait out a halt. Two things to know: a held notice is not ordered against one delivered at once (a notice sent in the minute a fold goes out can arrive first), and the hourly limit is counted per chat id as the sender passes it, so messages to the default chat and to the same chat named by id are counted apart.

## Approvals

Every draft a turn creates comes back as an approval request showing the whole draft, with Approve and Reject buttons. Each button carries the draft's id and the digest of exactly the text you were shown.

- **Approve** re-reads the draft from the database, checks that its current digest matches the button and the record of what you were shown, and marks it approved. Nothing is sent.
- If the draft changed after you saw it, the tap is refused and a fresh approval request shows the current text.
- **Reject** marks the draft rejected.
- A draft too long to show in one message is never shown truncated; the request fails and the draft stays pending.

### Decisions in the session

You decide on a draft outside any turn, with a button or in the dashboard, so by default the agent does not learn what you decided: ask it about the draft and it may still say the draft is waiting. With `operator:decision_lines_enabled` on, every approval or rejection of a draft that a chat turn created while the flag was on is written back into the session that created it, as one line:

```bash
npx gtm flags set operator:decision_lines_enabled true
```

```
[Decision from the system: at 2026-11-15 12:40 UTC the operator approved draft dr_1a2b3c4d5e6f7a8b (warm_intro to jane@globex.example). Approving does not send it.]
```

- The next turn in that session sees the line in front of your message, and later turns see it in the history, where it happened. No model call is made when you decide: the agent reads the line the next time you write, or when a timer of its own fires.
- The line goes to the session whose turn created the draft, wherever you tap. A draft written from the dashboard is approved in the operator chat, and its line goes back to your dashboard session, not to the chat's.
- A session you cleared with `/clean` after the draft was created gets no line: that conversation is over.
- Only drafts a turn created write a line. Replies drafted from inbound mail, meeting follow-ups and other drafts the system writes on its own never do, because their recipients came from mail and records the session never read.
- The line carries no taint. Core writes it from the draft's row, and the recipient it names is one the same session already wrote, after the session's taint covered whatever it read to find it.
- A line that cannot be written (for example, before migration 0034 is applied) is logged and skipped. The decision itself is never affected.
- A decision made while the turn that created the draft is still running is written when that turn ends. Its line is stored before that turn's messages, so a later turn may read it in front of a reply that did not know about it yet.
- Lines never count against the 40 messages of conversation a turn loads. A turn loads at most 20 of them; when more are waiting, the first line says how many earlier decisions are not shown.
- The dashboard's chat history, its history search and `/status` count only what you and the agent said, not these lines.

Turning the flag off stops new lines. Lines already written stay in the history until `/clean`.

## Costs and limits

| Limit | Default | Change it with |
|---|---|---|
| Spend per chat turn, checked before every model call and every tool (a turn shared by messages sent in a row has one ceiling) | $0.50 | `chat:turn_max_cents` |
| Spend per day for all chat turns | none | `budget:job:operator_chat:daily_cents` |
| Global daily and monthly limits (in `hard` mode) | $20, $500 | `budget:*` flags |
| Model rounds per turn | 8 | `agent.maxRounds` in `createWorker` |
| Messages per chat | 30 a minute | Fixed: the `chat` category in `RATE_LIMITS` (`packages/core/src/security/rate-limiter.ts`) |
| Timers fired per day, each one a chat turn | 20 | `operator:timers_daily_max` ([Timers](#timers)) |
| Saved notes shown in each turn | 4,000 bytes | Fixed: `NOTES_PROMPT_MAX_BYTES` ([Notes](#notes)) |
| Notices delivered on their own to one chat in one UTC hour, with the outbox on | 12 | `operator:outbox_hourly_max` ([Quiet hours and the outbox](#quiet-hours-and-the-outbox)) |
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
| A report or notice arrives hours late, or several arrive in one message | The outbox held them for quiet hours or the hourly limit; `/outbox` shows what is waiting |
| The agent says a draft is still waiting after you approved or rejected it | `operator:decision_lines_enabled` is off, the draft was created before it was turned on, or you sent `/clean` since ([Decisions in the session](#decisions-in-the-session)) |

Every route under `/api/webhooks/` skips the bearer token and must verify its own signature. If you mount your own route there, verify the request before reading or writing anything.

Forwarded messages and messages sent through an inline bot are ignored: they carry someone else's text, not your instructions. Paste the text into a message of your own instead.

# The operator dashboard

This page is for deployers who want the operator dashboard at `/admin`: it covers putting Cloudflare Access in front of it, the `admin` section of `gtm.config.ts`, the `admin:enabled` flag, what each view shows and which actions it can take, the security model and the limits. Contributors adding a view or a method should read `packages/core/src/gateway/protocol.ts`, the contract between the Worker and `apps/admin`.

## How a connection is admitted

```
browser -> Cloudflare Access (login, policy) -> GET /admin/*   static files (ASSETS), framing forbidden
                                             -> GET /ws        WebSocket upgrade
  /ws, in the Worker, default-deny:
    1. no admin section in gtm.config.ts           503 dashboard_not_configured
    2. admin:enabled off or unreadable             503 dashboard_disabled
    3. Origin not this deployment (or listed)      403
    4. no valid Access token                       403
    5. valid token, email not on allowedEmails     upgrade accepted, closed at once with 4403
    6. not a WebSocket upgrade                     426
    7. otherwise the upgrade goes to the OperatorGateway Durable Object with the verified identity
  on the socket:
    connect first; until it succeeds only connect and health answer ("unauthenticated")
```

The Worker verifies the `Cf-Access-Jwt-Assertion` header itself, with WebCrypto: an RS256 signature by one of the team's keys from `https://<team domain>/cdn-cgi/access/certs` (cached in memory for an hour, fetched again on an unknown key id at most every 30 seconds), the issuer `https://<team domain>`, the application's AUD tag, expiry and not-before (60 seconds of clock leeway), and an email on `admin.allowedEmails` (compared case-insensitively). Service tokens carry no email and are refused. There is no bearer token on `/ws`: Access is the authentication, and the allowlist is the authorization.

A socket keeps the identity it was admitted with. When the Access token expires, the next request closes the socket with code 4001 and the dashboard reconnects through Access; an email removed from the allowlist, or `admin:enabled` turned off (or unreadable), closes it with 4003 on its next request. A subscribed socket that sends nothing is checked the same way before every activity push, so a quiet open tab is closed within one poll.

## Setting it up

1. **Create an Access application** in Cloudflare One (Access controls, Applications, self-hosted) for your deployment's hostname, with two paths: `/admin` and `/ws`. Give it a policy that admits only your operators (emails, or an identity provider group). Copy the **Application Audience (AUD) tag** from its settings, and note your team domain (`<team>.cloudflareaccess.com`).
2. **Add the admin section** to `gtm.config.ts`:

   ```ts
   admin: {
     accessTeamDomain: "acme.cloudflareaccess.com",
     accessAud: "<the application's AUD tag>",
     allowedEmails: ["ops@acme.example"],
     // allowedOrigins: ["http://localhost:5173"], // only for a local dev server
   },
   ```

   The allowlist is checked in addition to the Access policy: someone Access admits but who is not listed sees "not allowed" (close code 4403) and nothing else.
3. **Deploy**, then turn the dashboard on: `gtm flags set admin:enabled true`. `gtm doctor` lists the flag.
4. Open `https://<your host>/admin/`. The dashboard connects to `/ws` on the same origin.

The static files under `/admin/*` hold no data, but put them behind the same Access application anyway so the dashboard is not served to strangers. The Worker serves them with `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other page can frame the dashboard. It does not verify the Access token on `/admin/*`: every piece of data comes over `/ws`, which does.

A deployment that keeps a `CHANGELOG.md` in its static assets directory (`public/CHANGELOG.md`, next to the built dashboard, not under `/admin/`) gets it in the Changelog view; it is read through the ASSETS binding and is not served publicly. The view reads the first 256 KB in the Keep a Changelog style: `## [1.2.0] - 2026-11-01` (or `## 1.2.0 (2026-11-01)`) starts a release, `### Area` starts an area, and each `- ` line is one entry.

## Views and actions

Every action runs through the module that owns it, with the same gates, digests and effects-ledger claims as the operator chat or the job that normally does it. The dashboard is never a second path around them.

| View | Shows | Actions |
|---|---|---|
| Overview | System status (the halt flag and kill switch, flags that are on, failing jobs, measurement health), active agents, the contact base, pipeline value, cost today, security posture, infrastructure checks, the fitness trend over 30 days | |
| GTM cockpit | Cold pause, cold batch and delivery switches, per-domain and per-account caps, the deferred queue by status, sends and replies over 7 days, discovery over 14 days | Pause (a critical pause, which automation never lifts), resume (lifts both levels), drain (cancels up to 1,000 queued deferred sends; it can only stop mail), replay (up to 50 due deferred sends through the send function, only while `delivery:enabled` is on) |
| Pipeline | Deals by stage, value, weighted forecast (value times probability, open deals), win rate | Create a deal for a contact, update its value or notes, move it forward (or to closed_lost) through `transitionDeal` |
| Inbound | Mail, its triage, its reply draft | Done, ignore, archive (through the reply commands' code, so drafts, reminders and evidence close the same way); approve, reject or send a reply draft |
| Proposals | Autonomy level proposals, experiment proposals, learnings | Approve (autonomy needs its confirm code), reject. Rejecting an autonomy proposal dismisses it, as `autonomy-dismiss-<id>` does in the operator chat: no level changes, and it can never be confirmed afterwards |
| Learning | The learnings document, pending learning proposals, a search of the last 90 days of operator chat history | Approve or reject, search |
| Contacts | Search, details, history, a plain summary, who to look at next | Edit first name, last name, job title and notes only |
| Agents | Model roles and their models; every registered job with its schedule, flag and last run | |
| Chat | The hub agent, in a session of its own per operator | Send, abort |
| Activity | The audit log, live while subscribed | Export a CSV (at most 31 days, 5,000 rows or 512 KB) |
| Link triage | The link-intake module's state, or that it is not installed | Refresh |
| Settings | Redacted configuration, the cron schedule, capabilities, flags, the security audit | Set or unset a flag, run the audit |
| Changelog | The deployment's `CHANGELOG.md`, release by release | Search, filter by area |

**Drafts.** The gateway's `drafts.approve` approves a draft (nothing is sent) and `drafts.reject` drops it. A draft of kind `lifecycle` (a lifecycle follow-up, or mail an optional module sends to product users, such as the ship module's "it is live" notes) is approved or dropped in the operator chat instead, with the command shown when it was drafted (`fu-approve-<id>` or `fu-reject-<id>` for a follow-up), which checks the contact again and closes the module's record; the dashboard refuses both for one.

**Approvals are bound to what was shown.** Every draft the dashboard receives carries the digest of exactly its recipient, subject and body, and the server records that it showed that content. Approving or sending echoes the digest back; the server re-reads the draft and refuses when the current content has another digest or is not what it showed. A refused approval leaves the draft pending: reload it and review it again. A reply send then goes through `sendApprovedReply`, which checks the approval digest, the thread and every send gate again. Proposals work the same way: the digest covers the source, the id and the exact detail text, and the source approves the content digest of the very read the gateway checked, never a fresh one.

**Flags.** `flags.set` takes the same keys and values as `gtm flags set`, except:
- `autonomy:<class>`: levels change only with `autonomy-set` and `autonomy-confirm` in the operator chat (or by approving a proposal with its confirm code), which check the evidence first. A permanently human-only class never goes above 1, anywhere;
- `system:halt`: set and lift it with `gtm flags`;
- the kill switch keys: use the cockpit;
- switches that let mail go out without a person (`inbound:auto_send_tier`, `cold_batch:auto_approve`, `signal_response:auto_send`): use `gtm flags`;
- state flags that jobs write.

`flags.list` marks each entry `editable` accordingly.

**Chat.** The same hub turn as the operator chat: the same tools, taint rules and budgets, while `operator:agent_enabled` is on. `/clean`, `/status` and `/help` work. Every other command (release, sequence, meeting, autonomy, experiment, lifecycle follow-up and learning commands, and any command an optional module adds) does not run here and is never passed to the model as a task: it is refused, because those commands are shown with their codes in the operator chat. To dismiss an autonomy proposal or decide a learning from the dashboard, use the Proposals view. Drafts a turn creates wait for approval, and the reply names their ids.

When the model gateway streams (`llm-gateway` does), the answer appears as the model writes it:

- the Worker batches the text into `chat.delta` events, one at most every 100 ms or every 2,048 characters, so a frame stays far under the 64 KB limit;
- when a later model call in the same turn (after a tool) starts writing, its first delta carries `reset`, and its answer replaces the text written before the tool call;
- at the end of the turn the dashboard is brought to exactly the final reply, then `chat.done` arrives. `chat.history` keeps only final replies, never the pieces;
- tool calls, the turn ceiling, the budget checks and the cost records run exactly as for a call that does not stream;
- abort stops the model's stream and every further delta. The turn then ends with the reply it recorded, marked aborted.

A gateway without streaming answers in one `chat.delta` carrying the whole reply. The Telegram channel always gets the whole reply in one message.

## The security model

- **Identity** comes from the verified Access token at the upgrade, never from a request. Every params object is strict: an unknown field (an email, an approver, a status) is refused before any handler runs.
- **Every id is re-resolved** from the database before anything is written.
- **Every mutation writes an audit row** (`audit_log`, action `dashboard.<method>`, agent `operator:<email>`) with its outcome, ids and enum values, whether it succeeded or was refused. Exports are audited too.
- **Outside text** (mail subjects and previews, draft bodies, chat history, activity summaries) is returned as plain strings. The dashboard renders it as text, never as HTML.
- **No secret leaves the Worker.** `config.get` reports each secret as set or not set, adapter options as key names, and the allowlists as counts. The security audit reports secret presence and length, the flags that fail closed, the permanently human-only cap and the webhook secrets, never a value.
- **Rate limits** per connection: 120 requests, 30 mutations and 10 chat messages a minute; past twice the request limit the socket is closed (1008). A frame over 64 KB closes it (1009). An operator may hold 5 sockets at once; a sixth upgrade is refused (429).
- **Pings** are answered by the runtime: send the text frame `ping` and receive `pong` without waking the object.

## Limits and what is not here yet

- One OperatorGateway instance serves every dashboard; a chat turn runs one at a time per operator.
- The activity stream polls the audit log every 10 seconds while a dashboard subscribes; between polls, `activity.list` is the source.
- Learnings, fitness scores and link triage appear when their sources are passed to `createWorker` as `dashboard: { proposals, fitness, learning, linkTriage }`. The worker template passes `learningDashboard()` from the learning module, so learnings and fitness appear; link triage needs the link-intake module, which has not shipped, so its view reports `installed: false`. Without the learning sources, pending learnings are listed read-only and fitness is empty.
- The dashboard lists only reply drafts, in Inbound. The gateway's `drafts.list` returns drafts of every kind, but no view shows it, so a draft a dashboard chat turn creates waits as `pending_approval`, named by id in the reply, without a view that lists it.
- Contact summaries are built from the database, without a model call.
- A model call aborted part way records no cost row, streamed or not: usage comes back only with a finished call. The vendor may still bill the tokens it produced before the abort.

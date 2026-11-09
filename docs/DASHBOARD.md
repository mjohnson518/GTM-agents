# The operator dashboard

This page is for deployers who want the web dashboard at `/admin`: it covers putting Cloudflare Access in front of it, the `admin` section of `gtm.config.ts`, the `admin:enabled` flag, what each view shows and which actions it can take, the security model and the limits. Contributors adding a view or a method should read `packages/core/src/gateway/protocol.ts`, the contract between the Worker and `apps/admin`.

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

A deployment that keeps a `CHANGELOG.md` in its static assets directory (next to the built dashboard, at the root, not under `/admin/`) gets it in the Changelog view; it is read through the ASSETS binding and is not served publicly.

## Views and actions

Every action runs through the module that owns it, with the same gates, digests and effects-ledger claims as the operator chat or the job that normally does it. The dashboard is never a second path around them.

| View | Shows | Actions |
|---|---|---|
| Overview | Halt and kill switch state, flags on, failing jobs, measurement health | |
| Cockpit | Cold pause, cold batch and delivery switches, per-domain and per-account caps, the deferred queue by status, sends and replies over 7 days, discovery over 14 days | Pause (a critical pause, which automation never lifts), resume (lifts both levels), drain (cancels up to 1,000 queued deferred sends; it can only stop mail), replay (up to 50 due deferred sends through the send boundary, only while `delivery:enabled` is on) |
| Pipeline | Deals by stage, value, weighted forecast (value times probability, open deals), win rate | Create a deal for a contact, update its value or notes, move it forward (or to closed_lost) through `transitionDeal` |
| Contacts | Search, details, history, a plain summary, who to look at next | Edit first name, last name, job title and notes only |
| Inbound | Mail, its triage, its reply draft | Done, ignore, archive (through the reply commands' code, so drafts, reminders and evidence close the same way); send a reply draft |
| Drafts | Drafts waiting for approval, of any kind | Approve (nothing is sent), reject. A lifecycle follow-up is approved with `fu-approve-<id>` (or dropped with `fu-reject-<id>`) in the operator chat instead, which checks the contact again and closes the follow-up record; the dashboard refuses both for one |
| Proposals | Autonomy level proposals, experiment proposals, learnings | Approve (autonomy needs its confirm code), reject (experiments and learnings) |
| Agents | Model roles and their models; every registered job with its schedule, flag and last run | |
| Chat | The hub agent, in a session of its own per operator | Send, abort |
| Activity | The audit log, live while subscribed | Export a CSV (at most 31 days, 5,000 rows or 512 KB) |
| Settings | Redacted configuration, flags, the security audit, cost | Set or unset a flag |

**Approvals are bound to what was shown.** Every draft the dashboard receives carries the digest of exactly its recipient, subject and body, and the server records that it showed that content. Approving or sending echoes the digest back; the server re-reads the draft and refuses when the current content has another digest or is not what it showed. A refused approval leaves the draft pending: reload it and review it again. A reply send then goes through `sendApprovedReply`, which checks the approval digest, the thread and every send gate again. Proposals work the same way: the digest covers the source, the id and the exact detail text, and the source approves the content digest of the very read the gateway checked, never a fresh one.

**Flags.** `flags.set` takes the same keys and values as `gtm flags set`, except:
- `autonomy:<class>`: levels change only with `autonomy-set` and `autonomy-confirm` in the operator chat (or by approving a proposal with its confirm code), which check the evidence first. A permanently human-only class never goes above 1, anywhere;
- `system:halt`: set and lift it with `gtm flags` or the operator chat;
- the kill switch keys: use the cockpit;
- switches that let mail go out without a person (`inbound:auto_send_tier`, `cold_batch:auto_approve`, `signal_response:auto_send`): use `gtm flags`;
- state flags that jobs write.

`flags.list` marks each entry `editable` accordingly.

**Chat.** The same hub turn as the operator chat: the same tools, taint rules and budgets, while `operator:agent_enabled` is on. `/clean`, `/status` and `/help` work; release and confirm commands do not run here, because their codes are shown in the operator chat. Drafts a turn creates wait in the Drafts view. The model gateway does not stream, so an answer arrives in one piece.

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
- Autonomy proposals are not rejected from the dashboard: one that is not confirmed expires.
- Learnings, fitness scores and link triage appear when their modules are installed and passed to `createWorker` as `dashboard: { proposals, fitness, learning, linkTriage }`. Until then, pending learnings are listed read-only, fitness is empty and link triage reports `installed: false`.
- Contact summaries are built from the database, without a model call.

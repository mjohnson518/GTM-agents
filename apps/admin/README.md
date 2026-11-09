# @gtm-agents/admin

The operator dashboard, built with Lit and Vite. The Worker serves it as static assets at `/admin`. This page is for deployers who want to run the dashboard and for contributors adding a view or changing how it talks to the Worker.

## What it is

A single-page app that talks to the Worker over one WebSocket, `wss://<your deployment>/ws`. The protocol is defined in [`packages/core/src/gateway/protocol.ts`](../../packages/core/src/gateway/protocol.ts): every request is `{ id, method, params }`, every answer is `{ id, result }` or `{ id, error }`, and the Worker pushes `{ event, data }` for chat tokens, live activity and status changes. The dashboard imports those types with `import type`, so nothing from core ships in the browser bundle.

The dashboard holds no credentials of its own. Cloudflare Access sits in front of the deployment, its session cookie authenticates the socket upgrade, and the Worker admits only operators on its allowlist. The first request is always `connect`; the gateway refuses everything else until it succeeds. Every action the dashboard offers runs through the same function, gates and audit row as the equivalent operator command, so the dashboard is never a second path around them.

| View | What it shows | What it does |
|---|---|---|
| Overview | System status, active agents, contact base, pipeline value, cost today, security posture, infrastructure checks, the fitness trend | |
| GTM cockpit | Cold outreach state and every cockpit panel (send caps, deferred queue, monitor hits, outreach and discovery counts, recommendations, today's moves) | Pause with a reason, resume, drain monitor hits, replay deferred |
| Pipeline | A kanban across deal stages, total, weighted forecast, win rate | Create, update, move between stages |
| Inbound | Totals, the email list, reply drafts | Archive, ignore, mark done, send or approve a draft, reject a draft |
| Proposals | Pending proposals from every source | Approve or reject; two-step proposals need their confirm code |
| Learning | The learning summary, pending learning proposals, session search | Approve or reject, search |
| Contacts | The contact base, who to contact next, search by text and warmth; a contact's record, activity and summary | Edit first name, last name, job title and notes |
| Agents | Agents grouped by role with model and tool count; every job with its schedule, flag and last run | |
| Chat | A streaming conversation with the hub agent | Send, abort |
| Activity | The audit trail | Live stream on or off, export a date range as CSV |
| Link triage | The link-intake module's state, or that it is not installed | Refresh |
| Settings | Configuration (read only), cron schedule, capabilities, feature flags, the security audit | Set or unset a flag, run the audit |
| Changelog | Every release | Search, filter by area |

### How actions are kept safe

- **Every action asks first.** Each change opens a confirmation dialog that says what will happen. Pausing outreach and draining monitor hits require a reason.
- **Approvals bind to what was shown.** Sending or approving a draft, and approving a proposal, echoes the `digest` that came with the exact text on screen as `shownDigest`. If the stored text changed in between, the Worker refuses and the dashboard asks you to reload and review it again.
- **Two-step changes stay two steps.** An autonomy change or an experiment start shows its full record first, then asks for the record's confirm code before anything is sent.
- **Autonomy is not a flag toggle.** Autonomy keys are read only in the flags list; change a level with `autonomy-set` in the operator chat.
- **Server text is text.** Inbound mail, web content and feedback come from outside. The dashboard renders every string the server sends as text (Lit's default escaping), never as HTML. The only links built from server data are `https:` URLs that pass a URL check; they are shown as text with a separate "Open" link that opens without an opener or referrer.

## Connection states

| State | What you see | What to do |
|---|---|---|
| Connecting, reconnecting | A banner; reconnects back off exponentially up to 30 seconds | Wait, or press Retry now |
| Not configured | The Worker answered 503 for `/ws` | Put the deployment behind Cloudflare Access, give the gateway its Access settings and operator allowlist, redeploy |
| Not allowed | The Worker answered 401 or 403, or refused `connect` | Sign in with an allowed account; press Sign in again |
| Version mismatch | `connect` was refused as invalid | Rebuild and deploy the dashboard and the Worker from the same release |

A browser does not expose the HTTP status of a refused WebSocket upgrade, so after an upgrade fails the dashboard sends one plain same-origin `GET /ws` to read it. The Access cookie rides along as it does for any same-origin request; the dashboard adds nothing.

## Build

```bash
npm run build --workspace @gtm-agents/admin
```

The build lands in `apps/worker/public/admin` (gitignored), which the Worker serves through its `ASSETS` binding. Wrangler runs this build before every deploy, so `npx wrangler deploy` from `apps/worker` always ships a current dashboard.

## Local development against a deployment

Run the Worker locally and the Vite dev server next to it:

```bash
cd apps/worker && npx wrangler dev        # the Worker on http://localhost:8787
npm run dev --workspace @gtm-agents/admin # the dashboard on http://localhost:5173/admin/
```

Vite proxies `/ws` and `/health` to the local Worker (see `vite.config.ts`). The local Worker still decides who is allowed: configure its Access settings and allowlist in `.dev.vars` (gitignored), never in code. To point the dev server at a deployed Worker instead, change the proxy target in `vite.config.ts` on your machine; the deployment's Access policy still applies, so sign in to it in the same browser first.

## Content security policy

`index.html` carries a strict policy:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

`connect-src 'self'` covers the same-origin `wss:` socket, so the page cannot open a socket to any other host. There are no inline scripts, no inline style attributes, no external fonts and no CDNs. Component styles are Lit constructed stylesheets and the page theme is adopted the same way, so no `unsafe-inline` is needed. A test scans the source for raw HTML sinks (`unsafeHTML`, `innerHTML` and the like) and inline styles, and checks the policy in `index.html`. A meta policy cannot set `frame-ancestors`, so serve `/admin` with a `Content-Security-Policy` header carrying `frame-ancestors 'none'` (or `X-Frame-Options: DENY`) to stop other sites framing the dashboard; keep that header at least this strict.

## Themes and accessibility

Colors are CSS variables on the document root, with a dark set chosen by the system setting or the theme switch in the header (remembered in local storage when it is available). Every control is a native button, link, input or select with a label; dialogs are native modal dialogs, so focus stays inside them and Escape cancels; focus moves to the heading of each view you open. The layout collapses its navigation into a scrolling row below 900 pixels wide. Charts are inline SVG with a text summary for screen readers.

## Tests

```bash
npx vitest run --project admin
```

The tests run in Node and cover the parts that hold logic: the RPC client (handshake, request ids, timeouts, events, reconnect, the not-configured and not-allowed outcomes), state reducers (activity feed, streaming chat, kanban grouping, flag rules), routes, formatting and URL checks, and the page hygiene scan. The Lit views render that state and are exercised against a running Worker.

## Adding a view

1. Add the method's params and result to `protocol.ts` (additive changes only) and implement it in the gateway.
2. Create `src/views/<name>.ts` extending `GtmView`: implement `load()`, render sections with `section()` so an unreadable source says so instead of showing zero, and run every change through `confirmAction()` and `perform()`.
3. Register the route in `src/router.ts` and the element in `src/main.ts`.
4. Put any logic worth testing in a pure module and test it in `test/`.

# @gtm-agents/admin

The operator dashboard, built with Lit and Vite. The Worker serves it as static assets at `/admin`.

The dashboard talks to the Worker over an authenticated WebSocket RPC that denies by default: only `connect` and `health` work before authentication. Every action it offers goes through the same gates as an operator command. Sending a draft binds to the exact text shown, and pausing outreach records a reason.

## Status

A minimal shell that shows deployment health exists today. `npm run build --workspace @gtm-agents/admin` builds it into `apps/worker/public/admin`, and Wrangler runs that build before every deploy. The full views (GTM cockpit, pipeline, inbound, agents, chat, activity, learnings, settings) are planned in [docs/ROADMAP.md](../../docs/ROADMAP.md).

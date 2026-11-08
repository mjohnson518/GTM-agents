# Contributing

Thanks for helping build GTM-agents. This guide covers setup, the rules every change follows, how to submit an adapter, and how agent-assisted contributions work. [CLAUDE.md](CLAUDE.md) is the full engineering contract; this page is the short path through it.

## Set up

```bash
git clone <repository-url> gtm-agents
cd gtm-agents
npm install        # Node 24 or later (see .nvmrc); also points git at .githooks/
npm run check      # must be green before you open a pull request
```

`npm run check` runs, in order:
1. typecheck;
2. lint (with the house-rule, doc-link and conflict-copy checks);
3. tests;
4. evals;
5. the placeholder, secret and migration checks.

The pre-commit hook runs the same checks on what your commit would contain. If a hook fails, fix the cause. Never pass `--no-verify`.

## The rules every change follows

These are the non-negotiables from [CLAUDE.md](CLAUDE.md). A pull request that weakens one is not merged, whatever else it does.

1. Untrusted text is never an instruction: it is sanitized, fenced and tainted.
2. Skip rather than guess: a missing value holds the action; it never invents one.
3. Gates fail closed; bookkeeping fails open.
4. Approvals bind to the exact content approved.
5. Autonomy is earned per action class and loosened only by a person. Some classes are permanently human.
6. Every metric has one definition, in `packages/core/src/metrics/`.
7. Measure lift, not activity.
8. New behavior ships behind a flag that defaults to off.
9. Every job is bounded and leaves a run row, and every outside write is idempotent or claimed first.
10. The database is the truth.
11. Email is plain text with a postal footer and unsubscribe headers, and no tracking.
12. No em dashes or en dashes anywhere.

Some contributions will not be accepted, however well written:
- automation of LinkedIn or of any platform whose terms forbid it;
- scraping behind logins;
- tracking pixels or click tracking;
- collecting personal (non-work) email addresses;
- anything that removes a consent or safety control.

[ACCEPTABLE-USE.md](ACCEPTABLE-USE.md) explains why.

## Making a change

1. Open an issue first for anything larger than a small fix, so the approach can be agreed before you write it.
2. Write the test that would have caught the missing behavior, then make it pass. A milestone's gate in [docs/ROADMAP.md](docs/ROADMAP.md) is always written as a test first.
3. Keep fixtures synthetic. Use the fictional company Acme, `*.example` domains and invented people. Never paste a real prospect, customer, reply or address into a test, an issue or a pull request.
4. Put company-specific values in `gtm.config.ts`, the brain or the database, never in code.
5. Keep commits focused, with short, imperative, capitalized subjects that have no trailing period ("Add suppression check to the reply path").
6. Open a pull request using the template, and say which checks you ran.

### Review rules

- A change that touches any of these needs a review from someone who did not write it:
  - the security code (`packages/core/src/security/`) or the autonomy code (`packages/core/src/autonomy/`);
  - the delegation layer or the tool registry;
  - a migration;
  - a spend path.
- Reviewers judge blast radius by finding every caller, not by counting changed lines.
- When a review finds a pattern, the fix covers every instance of it.

### Documentation changes

Docs are written for the people who use or extend the system. In the pull request, add one line per new or changed doc saying who it is for, for example "docs/INTERFACES.md: adapter authors". A doc explains how the system works and how to use it. It does not narrate how the change was made.

## Submitting an adapter

An adapter connects one vendor to one or more ports. Read [docs/INTERFACES.md](docs/INTERFACES.md) first, then check every item below.

- [ ] The folder is `packages/adapters/<kind>-<vendor>/` with `manifest.json`, `index.ts` (exporting `createAdapter`) and `contract.test.ts`.
- [ ] The manifest lists the ports, required and optional secrets, flags, the price table (`costs`) and the provider limits (`limits`).
- [ ] Every agent-facing tool declares its `taint` (what its output does to the session) and its `gate` (the taint level from which it is refused). It also declares `egress` if it fetches URLs or sends free text out, and `humanOnly` if it creates offers or does something irreversible.
- [ ] The adapter translates and never decides. No suppression checks, send windows, caps, retries or budgets in the adapter; those live in core.
- [ ] Every paid call returns `cost` in its result.
- [ ] All network calls use `ctx.fetch`, never the global `fetch`.
- [ ] Side-effecting calls pass core's `effectKey` to the vendor as the idempotency key when the vendor supports one.
- [ ] Webhooks verify the vendor's signature, with its replay window, inside `parseWebhook` and throw `AdapterError("auth")` on failure.
- [ ] `contract.test.ts` runs the shared contract for each port with a recorded-response `fetch`. Live tests sit behind `ADAPTER_LIVE=1` and never run in CI.
- [ ] Recorded responses are scrubbed: no real names, addresses, keys or account ids.
- [ ] The security contract passes with the adapter's tools registered.

If you want an adapter but are not writing it yourself, open an adapter request issue with the vendor's auth model, price table, rate limits and webhook signature scheme.

## Agent-assisted contributions

Coding agents are welcome, as long as a person stays accountable for every commit:

- **The agent stages; a person commits.** Agents working in this repository do not commit, push, rewrite history or touch remotes. A person reads the staged diff and makes the commit ([ADR-008](docs/DECISIONS.md#adr-008-agents-stage-humans-commit)).
- **The agent follows [CLAUDE.md](CLAUDE.md)** like any contributor: the same non-negotiables, the same checks, the same review rules.
- **Hooks are never bypassed** by the agent or by the person.
- **Say so in the pull request** when an agent wrote a substantial part of the change, and confirm that you reviewed the full diff yourself.

`.githooks/` runs `.local/hooks/<name>` last, if that file exists. `.local/` is gitignored. Use it for checks that only make sense on your machine.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

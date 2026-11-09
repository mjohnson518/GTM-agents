# Repository checks

These scripts keep the repository and the worker template safe to publish and safe to deploy from placeholders. `npm run check` runs all of them, together with typecheck, lint, tests and evals. The pre-commit hook in `.githooks/` runs them on what a commit would contain, and CI runs them on every push.

Each check accepts the same inputs: no flag (tracked files plus untracked files that are not ignored), `--staged` (staged contents only), or `--files <paths...>`.

| Script | Fails on |
|---|---|
| `check-placeholders.mjs` | UUID-shaped strings outside synthetic fixtures; real `*.workers.dev` hostnames (placeholders such as `<worker>.<subdomain>.workers.dev` pass); concrete resource ids in a Wrangler config; secret-shaped values assigned to keys like `api_key` or `token` |
| `secrets-scan.sh` | Well-known credential formats: model vendor keys, git host tokens, cloud keys, payment live keys, chat bot tokens, private key blocks. It prints the location and kind, never the value |
| `check-migration-order.mjs` | Migration names out of order or with gaps; CREATE without `IF NOT EXISTS`; DROP without `IF EXISTS`; seeds without `INSERT OR IGNORE`; an unguarded `ADD COLUMN` (precede it with a `-- once:` comment); a table without `created_at` |
| `check-house-rules.mjs` | Em dashes and en dashes anywhere in tracked text |
| `check-conflict-copies.mjs` | Duplicates left by file-sync tools, such as `index 2.ts` or `notes (1).md` |
| `check-doc-links.mjs` | Relative Markdown links that point at missing files |
| `check-licenses.mjs` | A production dependency of any workspace whose license is not on the permissive allowlist (MIT, ISC, Apache-2.0, BSD, 0BSD, BlueOak, CC0, Unlicense). Development tooling is not shipped and is not checked |
| `generate-brain-schema.ts` | Not a check. It regenerates the brain's JSON Schemas in `packages/core/brain/schema/` after a schema change; a test fails if they are out of date |
| `check-commit-msg.mjs` | A commit subject that is empty, not capitalized, longer than 72 characters, or ends with a period (run by `.githooks/commit-msg`) |
| `install-hooks.mjs` | Not a check. It points git at `.githooks/` when you run `npm install` |
| `release/` | Not checks. `pack.mjs` builds each publishable package (JS and types) into `.release/` and packs it; `smoke.mjs` installs those tarballs in a temporary directory and proves `gtm init`, `npm install` and a Wrangler dry run work; `publish.mjs` publishes the tested tarballs (the release workflow runs it on a `v*` tag); `version.mjs` moves every package to one version. [docs/RELEASING.md](../docs/RELEASING.md) |

## Synthetic fixtures

A test fixture that needs UUID-shaped values declares itself synthetic on its first line:

```
// gtm:synthetic-fixture
```

## Machine-local hooks

Both hooks in `.githooks/` run `.local/hooks/<name>` last, if that file exists and is executable. `.local/` is gitignored. Use it for checks that only make sense on your machine, such as a list of names that must never appear in your commits.

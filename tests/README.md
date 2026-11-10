# Cross-package tests

This page is for contributors adding or running tests. Tests that cover more than one package live here. Tests for a single package live next to its code.

| Folder | What it covers |
|---|---|
| `tests/security/` | The security contract: every tool is classified, gates never loosen as taint rises, untrusted text is fenced, gates fail closed, effects happen exactly once, budgets stop spend. Adapters and modules run the same contract in CI. |
| `tests/evals/` | Deterministic behavior evals for the outbound writers, templates, automatic replies and the learning loops. Run with `npm run eval`. No network. |
| `tests/contract/` | Published test vectors for the host event contract (its signatures and the SDK's), checked against the code. Run with `npx vitest run --project contract`. |

## Fixtures are synthetic

Every person, company, address and reply in a fixture is invented. Use the fictional company Acme and `*.example` domains. A fixture that needs a UUID declares itself synthetic on its first line with `gtm:synthetic-fixture`. Otherwise `npm run check:placeholders` rejects it.

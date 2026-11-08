# Cross-package tests

Tests that cover more than one package live here. Tests for a single package live next to its code.

| Folder | What it covers |
|---|---|
| `tests/security/` | The security contract: every tool is classified, gates never loosen as taint rises, untrusted text is fenced, gates fail closed, effects happen exactly once, budgets stop spend. Adapters and modules run the same contract in CI. |
| `tests/evals/` | Deterministic behavior evals for outbound writers and decisions. Run with `npm run eval`. No network. |
| `tests/contract/` | Published test vectors, such as the host event contract's signatures, checked against the code. |

## Fixtures are synthetic

Every person, company, address and reply in a fixture is invented. Use the fictional company Acme and `*.example` domains. A fixture that needs a UUID declares itself synthetic on its first line with `gtm:synthetic-fixture`. Otherwise `npm run check:placeholders` rejects it.

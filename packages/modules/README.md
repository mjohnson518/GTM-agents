# @gtm-agents/modules

Optional features. Each module sits behind a flag that defaults to off, and a deployment that never enables one carries no cost from it.

| Module | What it does |
|---|---|
| `ship` | Turns product feedback into code. It groups feedback into themes, writes a spec for a theme with enough demand, has a coding agent build it in a sandbox with no credentials, applies a path policy, and opens a pull request. It never merges; a person does. |
| `link-intake` | The operator sends a link. The module fetches it safely, analyzes it with a single schema-bound model call, and routes it to a learning proposal, a bounded configuration change, or a code-change request. Every step needs approval. |
| `classifier-tier` | Small hosted classifiers for yes/no decisions and typed extraction, rolled out per call site as `off`, `shadow` or `on`. A call site moves to `on` only after shadow mode shows high agreement with the model it replaces. |
| `code-mode` | Gives the model a typed API and two tools (search the API, run a short script against it) instead of dozens of tool schemas. Scripts run in an isolate with no network, and every API call passes the same gates as a tool call. |

## Status

This package is a scaffold. Modules arrive after the core loop they extend.

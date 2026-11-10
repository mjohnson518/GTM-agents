# Examples

This page is for deployers and contributors looking for a starting point to copy. Everything here is fictional: the company is Acme, and every address is on an `.example` domain.

| Folder | What it shows |
|---|---|
| [`brains/`](brains/) | Complete example brains. `brains/acme` is a fictional developer-tools company, written to the brain schema and locked, with a three-step cold sequence (cold intro, follow-up, breakup) and the lifecycle follow-up templates. |
| [`host-nextjs/`](host-nextjs/) | A host application (the product being sold) wired to the event contract in Next.js. This release ships its README, which describes what the example covers; [packages/sdk](../packages/sdk/README.md) shows the same wiring in code. |
| [`packs/`](packs/) | What a domain pack for a vertical is: extra discovery sources, a domain wiki or a vertical-specific adapter, each registered through the same ports as the core ones. No pack ships with this release. |
| [`ship/`](ship/) | A Worker with the optional ship module wired in ([docs/SHIP.md](../docs/SHIP.md)): the sandbox and Workflow bindings in `wrangler.jsonc`, the two adapters in `gtm.config.ts`, and both sides of the module joined in `src/index.ts`. |
| [`overlay/`](overlay/) | How a real deployment keeps its private brain, config and secrets outside this repository while still tracking upstream. |

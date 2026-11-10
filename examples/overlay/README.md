# Private overlay

This page is for deployers running a real deployment who want to keep tracking this repository without publishing anything private. A real deployment has material that must never live in a public repository:
- its brain and templates, which describe its market and voice;
- its `gtm.config.ts`, with addresses, the postal footer and operator chat ids;
- its resource ids;
- its secrets.

An overlay keeps that material in a private repository that consumes this kit, instead of in a fork you have to keep scrubbing.

The recommended shape is the directory `gtm init` creates, kept in a private repository:

```
my-gtm-deployment/            private repository
  package.json                depends on @gtm-agents/core, @gtm-agents/adapters and @gtm-agents/cli
  wrangler.jsonc              real resource ids (filled by gtm setup)
  gtm.config.ts               your company, sending addresses, adapters, models
  brain/                      your approved brain files and lock
  templates/                  your templates
  src/index.ts                createWorker(config), with the adapters and jobs wired
  public/admin/               the built dashboard
```

Secrets go in `wrangler secret put` and, for local development, in `.dev.vars`, which is gitignored. They never go in the overlay's files.

If you work in a fork instead, keep an ignored folder for anything that names your company or its infrastructure, and check every commit against it with a local pre-commit hook. `.githooks/` runs `.local/hooks/pre-commit` and `.local/hooks/commit-msg` when they exist and are executable.

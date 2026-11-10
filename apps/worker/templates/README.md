# Templates

Your email templates: one Markdown file per template, with frontmatter (id, kind, status, step, angle, subject, targeting) and a plain-text body that uses `{{variables}}`. Cold copy is assembled from these by substitution; no model writes a first touch.

Start with a cold intro, a follow-up and a breakup. Lifecycle follow-ups to product users read one template of kind `lifecycle` per follow-up, by id: `lifecycle-first-use`, `lifecycle-last-first-use`, `lifecycle-usefulness`, `lifecycle-upgrade-offer`, `lifecycle-reengage`, `lifecycle-at-risk` and `lifecycle-win-back`; a follow-up with no approved template waits. [docs/BRAIN-SCHEMA.md](../../../docs/BRAIN-SCHEMA.md) lists every field, variable and rule, and `examples/brains/acme/templates` has a complete set for a fictional company. `npx gtm brain validate` checks them. This README is ignored by the validator.

# Brain

Your company's brain: one Markdown file per component (`personas.md`, `icp.md`, `facts.md` and the rest), plus `brain.lock.json` once you have approved and locked them. Prompts read short, typed slices of these files, and only files marked `status: approved` whose hash matches the lock are ever served.

The folder starts empty. That is valid: tasks are told which components are unknown and work without them. Add components one at a time:

1. Write a component, following [docs/BRAIN-SCHEMA.md](../../../docs/BRAIN-SCHEMA.md).
2. Run `npx gtm brain validate` to check it against the schema and the byte budgets.
3. When it is right, set `status: approved` and run `npx gtm brain validate --write-lock`.

`examples/brains/acme` is a complete example for a fictional company. This README is ignored by the validator.

## What this changes

<!-- One or two sentences: the behavior before, the behavior after, and why. Link the issue if there is one. -->

## How it was tested

<!-- The test that would have caught the missing behavior, and anything you checked by hand. -->

## Checklist

- [ ] `npm run check` passes (typecheck, lint, tests, evals, placeholder, secret and migration checks)
- [ ] A test covers the new behavior, and would fail without this change
- [ ] New behavior is behind a flag that defaults to off, or this change needs no flag
- [ ] Fixtures and examples are synthetic (Acme, `*.example`), with no real people, replies, keys or resource ids
- [ ] Company-specific values come from `gtm.config.ts`, the brain or the database, not from code
- [ ] No em dashes or en dashes

## Review rule

- [ ] This change does **not** touch security, autonomy, delegation, the tool registry, migrations or a spend path
- [ ] It **does**, and was reviewed by someone who did not write it: <!-- who -->

## Docs

<!-- One line per new or changed doc: the file, and who it is for. Example: "docs/INTERFACES.md: adapter authors". Write "None" if no docs changed. -->

## Agent assistance

- [ ] No coding agent wrote a substantial part of this change
- [ ] A coding agent helped, and I reviewed the full diff myself before committing

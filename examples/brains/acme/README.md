# Acme: a complete example brain

Acme is a fictional developer-tools company. It sells Acme Quarantine, which detects flaky tests in CI and quarantines them automatically. Its buyers are software companies with 30 to 300 engineers. Every company, person, number and price here is invented, and the domains use the reserved `.example` top-level domain.

The folder is a complete brain written to [docs/BRAIN-SCHEMA.md](../../../docs/BRAIN-SCHEMA.md):

- all fourteen components, from `market-profile.md` to `commercial.md`, each approved;
- `brain.lock.json`, which locks the approved files so the runtime serves exactly what was approved;
- `templates/`, with a cold intro, a follow-up and a breakup that thread together as a three-step sequence, and one `lifecycle` template for each lifecycle follow-up: the first-use nudge (`lifecycle-first-use`), the last first-use nudge (`lifecycle-last-first-use`), the usefulness check (`lifecycle-usefulness`), the upgrade offer (`lifecycle-upgrade-offer`), the re-engage note (`lifecycle-reengage`), the at-risk check-in (`lifecycle-at-risk`) and the win-back offer (`lifecycle-win-back`). The lifecycle templates use only `{{first_name}}`, `{{last_name}}`, `{{sender_name}}` and `{{booking_url}}`, the variables the follow-up writer fills, and state no figure. The upgrade and win-back offers stay permanently human-only: a person approves each one ([LIFECYCLE.md](../../../docs/LIFECYCLE.md#lifecycle-follow-ups)).

## Try it

```bash
npx gtm brain validate examples/brains/acme
```

It reports 14 components, 10 templates and no errors. Edit any approved file and validation fails until you re-lock it with `--write-lock`. That is the mechanism that keeps unreviewed text out of prompts.

## Use it as a starting point

Copy the folder into your deployment as `brain/` (moving `templates/` next to it), then replace every item with your own company's market, buyers and voice. Keep the shape: short items, one or two sentences each, with prices only in `commercial.md`, links only in the `url` fields of `facts.md` and `commercial.md`, and nothing copied from the web or from a prospect's email.

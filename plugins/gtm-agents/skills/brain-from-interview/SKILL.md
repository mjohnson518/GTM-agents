---
name: brain-from-interview
description: Interview the person about their company in chat and write a draft GTM-agents brain with `gtm brain init` (personas, ICP, message pillars, the proof fact and voice, plus a gtm.config.ts snippet). Use when they want to write, start or fill in their brain.
---

# A draft brain from an interview

The questions, and what each answer writes, come from the CLI. Ask them as printed; the CLI writes and checks the files.

## Steps

1. Work in the deployment directory (the one holding `gtm.config.ts` and `brain/`). Run `npx gtm brain init --questions`. If it prints a usage error instead of JSON, the CLI is older than 0.3.0: the person updates the `@gtm-agents` packages, or you write the brain with them by hand from BRAIN-SCHEMA.md. Otherwise it prints seven batches as JSON: each question has an `id`, a `prompt`, sometimes a `help` line, and what it `writes`.
2. Ask one batch at a time. Give the batch's `intro`, then its questions, using the prompts and help as printed. Do not add questions or turn them into leading ones.
3. Record each answer in the person's own words. You may tighten the wording; never add anything they did not say.
4. Write the answers as one JSON object, `{"<id>": "<answer>"}`, to a file outside the deployment directory (a temporary directory). Leave out every skipped id.
5. Run `npx gtm brain init --answers <file>`.
   - Exit 2 lists the answers it refused, and nothing was written. Ask the person again for those, fix the file and rerun.
   - Exit 0 lists the files written, the ones left alone, the components not written, and a snippet for `gtm.config.ts`.
   - Exit 1 means either nothing was written (an `ERROR` line names the problem before "nothing was written") or the files were written and the folder's validation then failed, usually on a file that was already there. Read the output and tell the person which.
6. Delete the answers file.
7. Show the person each file and the snippet. They paste the snippet into `gtm.config.ts`; edit it for them only if they ask, then run `npx gtm doctor`.

## Rules

- **A skip stays a skip.** "Skip", "not sure" and "later" leave the answer out of the file; never write them as an answer (init refuses them). Never fill one from their website, from memory or from a guess. Init writes what was skipped as missing, or as an ICP `unknown` item, so tasks know it is unknown.
- **Figures only in the proof answers,** and only one the person can show, with its public https link when there is one. A figure in the pain or difference answer belongs in the proof answers instead.
- **Batch 1 holds addresses, not secrets.** No question asks for a key or a password; if the person offers one, do not write it anywhere and tell them to set it in their own terminal with `npx wrangler secret put`.
- **Never-contact domains are domains** (`initech.example`), not company names: the list is enforced by domain, so ask for the domain.
- **Approval is the person's.** Every file is written `status: draft`, and nothing is served until it is approved and locked. Set `status: approved` only on a file the person has read and told you to approve. Then they run `npx gtm brain validate --write-lock` and `npx gtm brain upload --env staging`.
- **Init never overwrites a component file.** To redo one, the person deletes or renames it first.

## After the interview

- To tie the customer result to the pillar it backs up, add `- proof: customer-result` to that pillar in `message-pillars.md`, with the person's say.
- `product.md` and `icp.md` can be drafted from the person's website on the dashboard's Product and ICP page ([TARGETING.md](https://github.com/mjohnson518/GTM-agents/blob/main/docs/TARGETING.md)), then brought into the folder with `npx gtm brain pull`.
- The other components (objections, competitors, keyword portfolio, signals and the rest) are written with the person from [BRAIN-SCHEMA.md](https://github.com/mjohnson518/GTM-agents/blob/main/docs/BRAIN-SCHEMA.md), under the same rules. `npx gtm brain validate` checks every change.

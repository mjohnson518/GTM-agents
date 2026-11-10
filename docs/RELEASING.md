# Releasing

This page is for anyone publishing the GTM-agents packages to npm, including a fork publishing under its own scope: what the release build produces and why, how to prove a release works without publishing anything, the tag-triggered workflow, how it signs in to npm (a token for the first release, trusted publishing after) and the scope it needs, lockstep versioning, and how to check a release once it is out. Deployers installing the packages should read [DEPLOYING.md](DEPLOYING.md); contributors changing the CLI should read [packages/cli/README.md](../packages/cli/README.md).

## Why there is a build

The repository is source-first ([ADR-009](DECISIONS.md#adr-009-source-first-typescript-on-node-24)): every package exports `.ts` files, Wrangler, Vite and Vitest consume them directly, and Node 24 runs the CLI's TypeScript with native type stripping. That stops at `node_modules`. Node refuses to strip types from a file inside it (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `gtm` CLI installed from npm as TypeScript could not start. Bundlers would cope with TypeScript in `node_modules`, but the CLI runs in Node, and so does the core code it imports (configuration, flags, the brain validator) and the deployer's `gtm.config.ts`, which imports `@gtm-agents/core/config`.

So every published package ships compiled JavaScript, and the libraries ship declarations next to it. The build exists only for publishing: nothing in day-to-day development runs it, and nothing in the source tree changes.

- **One `tsconfig.build.json` per publishable package.** It extends the package's own `tsconfig.json`, turns emit on with `rewriteRelativeImportExtensions` (so `import "./x.ts"` compiles to `import "./x.js"`), and writes to `.release/stage/<dir>/dist`. Packages that import core resolve `@gtm-agents/core` through `paths` to core's freshly built declarations, so each build also type-checks against exactly what will publish. Declarations keep `.ts` in their relative imports; TypeScript resolves those to the `.d.ts` files beside them, with or without `allowImportingTsExtensions` in the consumer.
- **The source manifests stay as they are.** Each `packages/*/package.json` keeps `"private": true` and its source exports map, so a stray `npm publish` inside a workspace fails instead of publishing TypeScript. The published manifest is generated at pack time.
- **`.release/` holds everything the release scripts write.** It is gitignored, and the scripts clear it at the start of each pack.

### What each package publishes

| Package | Contents | Used by |
|---|---|---|
| `@gtm-agents/core` | `dist/` (JavaScript and declarations), `migrations/` (the D1 migrations), `brain/schema/` (the brain's JSON Schemas) | Wrangler, bundling it into a deployment's Worker; the CLI, in Node; the deployment's `wrangler.jsonc`, whose `migrations_dir` is `node_modules/@gtm-agents/core/migrations` |
| `@gtm-agents/adapters` | `dist/`, plus each adapter's `manifest.json` at `<adapter>/manifest.json` | The Worker; `gtm doctor`, which reads the manifests from `node_modules`. The contract runners (`@gtm-agents/adapters/_contract/<port>.ts`) import Vitest, which is an optional peer dependency |
| `@gtm-agents/sdk` | `dist/` | Host applications ([EVENT-CONTRACT.md](EVENT-CONTRACT.md)) |
| `@gtm-agents/cli` | `dist/` (JavaScript only, `gtm` is `dist/bin.js`), and `dist/template/`: the worker template and the built operator dashboard | Deployers. `gtm init` copies `dist/template/` into a new deployment |
| `@gtm-agents/modules` | Not published yet | A package publishes once it has an exports map or a bin; it then needs a `tsconfig.build.json`, and the pack fails until it has one |
| `apps/worker`, `apps/admin` | Never published | The template and the dashboard reach deployers inside the CLI package |

The generated manifest:
- maps every `.ts` export to `{ "types": "./dist/....d.ts", "default": "./dist/....js" }`, and `bin` to the compiled file;
- maps a pattern over a directory of TypeScript (`./_contract/*`) to its compiled files for both `.ts` and `.js` requests, so the import specifiers that work in this repository keep working from npm;
- publishes non-TypeScript exports (migrations, schemas, manifests) as they are and lists them in `files`;
- pins every dependency on another workspace package to exactly the release version, and keeps third-party ranges as they are;
- adds `engines` (from the root), `license`, `repository` (with the package's directory), `homepage`, `bugs`, `publishConfig.access: public` and `./package.json` as an export;
- drops `private`, `scripts` and `devDependencies`.

The README is copied with its relative links made absolute (pointing at the release tag), and the root `LICENSE` is added.

## Prove a release works, without publishing

```bash
npm ci --ignore-scripts                     # the pack needs no dependency install scripts
node scripts/release/pack.mjs               # builds and packs into .release/tarballs, writes .release/release.json
node scripts/release/smoke.mjs              # installs the tarballs and uses them as a deployer would
node scripts/release/publish.mjs --dry-run  # npm publish --dry-run for each tarball
```

**`pack.mjs`** fails unless every package is at one version with internal dependencies pinned to it. It builds the dashboard (skip with `--skip-admin-build` if it is already built), then compiles, stages and packs each package in dependency order. It then checks every tarball:
- every export and bin target is inside it;
- every relative import in the compiled JavaScript and declarations resolves to a file inside it, and none still ends in `.ts`;
- every bare import is a Node or Workers builtin, a declared dependency, or a subpath the internal package it names actually exports;
- every `@gtm-agents` import in the CLI's bundled template is exported by the package it names.

It writes each tarball's SHA-256 into `.release/release.json` and prints the SHA-256 of `release.json` itself. Building needs only TypeScript, Vite and `npm pack`, none of which needs an install script, so the release workflow packs after `npm ci --ignore-scripts`: no third-party install script runs where the tarballs are made.

The `repository` field comes from `--repository <owner/repo>`, then `GITHUB_REPOSITORY` in GitHub Actions, then the `origin` remote.

**`smoke.mjs`** and **`publish.mjs`** first check every tarball against the SHA-256 in `release.json`, and `release.json` against `--record-sha256 <hex>` when it is given. `smoke.mjs` works in a temporary directory and needs the network for third-party packages (Wrangler, TypeScript, hono, zod):
1. It installs every tarball (each also an `overrides` entry), checks that the packages are files under `node_modules` with no TypeScript source left for Node to run, runs `gtm --help`, and loads the SDK in Node and typechecks it under `nodenext` and `bundler` resolution, as a host application would.
2. It runs `gtm init` from the installed CLI, in npm mode, and checks that the new project depends on every package at exactly the packed version and carries the built dashboard.
3. It points the project's `@gtm-agents` dependencies at the tarballs, copies in the example brain ([examples/brains/acme](../examples/brains/acme/)) and runs `npm install`.
4. In the project it runs `wrangler deploy --dry-run` for production and staging, `tsc` against the published declarations, `gtm brain validate` (which loads `gtm.config.ts` through the installed core) and an offline `gtm doctor`.
5. It repeats steps 3 and 4 for `gtm init --local <this checkout>`. Skip that with `--skip-local`; keep the temporary directory with `--keep`.

CI runs all three on every push to the default branch and every pull request (the `release-smoke` job in `.github/workflows/ci.yml`, which also installs with `--ignore-scripts`), so packaging breaks show up long before a release.

## Versioning

Every package, both apps and the root share one version, and every dependency between them names exactly that version. Adopters only ever match one number: `gtm init` pins the packages to the CLI's own version.

```bash
node scripts/release/version.mjs 0.2.0          # sets the version everywhere and syncs package-lock.json
node scripts/release/version.mjs 0.2.0-rc.1     # a prerelease; it publishes under the "next" dist-tag
node scripts/release/version.mjs --check        # fails if anything is out of step
node scripts/release/version.mjs --check --tag v0.2.0
```

The bump rewrites only the `version` fields and the internal dependency ranges, then runs `npm install --package-lock-only` (pass `--no-lockfile` to skip that). Review the diff and run `npm run check` before you commit it.

## Publishing a release

### One-time setup

1. **Own the npm scope.** The packages publish as `@gtm-agents/*`, so whoever publishes must own the `gtm-agents` organization on npm, or be a member of it with permission to publish. A fork that does not own it publishes under its own scope ([below](#publishing-from-a-fork)).
2. **Create the `npm` environment** (Settings, Environments; the first workflow run creates it, or create it yourself). Limit it to `v*` tags and add required reviewers, so no workflow on another branch can publish and a person approves every publish. The `publish` job runs in it, whichever way it signs in.
3. **Keep the repository public.** npm provenance links each version to the public repository, commit and workflow run that built it.

### How the workflow signs in to npm

The `publish` job uses the `NPM_TOKEN` secret of the `npm` environment when one is set, and otherwise npm's trusted publishing: an OIDC exchange between GitHub Actions and npm, so there is no stored token to leak or renew. Trusted publishing needs the job's `id-token: write` permission, which it has, and npm 11.5.1 or later, which `publish.mjs` checks before anything is published. Provenance is attached either way.

npm can only attach a trusted publisher to a package that already exists, so the first release publishes with a token and every later one without:

1. **First release, with a short-lived token.** On npmjs.com, create a granular access token with read and write permission on the `gtm-agents` organization's packages (the packages do not exist yet, so grant it on the organization), with "bypass two-factor authentication" enabled so CI can use it, and the shortest expiry that covers the release. Store it as the secret `NPM_TOKEN` of the `npm` environment, never in a file or as a repository secret. Then release as below.
2. **Remove the token** once the release is out: delete the `NPM_TOKEN` secret, and revoke the token on npmjs.com.
3. **Configure trusted publishing on each package** when you prepare the next release. For each of `@gtm-agents/core`, `adapters`, `cli`, `modules` and `sdk`, open the package's settings on npmjs.com, add a trusted publisher for GitHub Actions, and enter the repository's owner and name, the workflow file name `release.yml`, and the environment `npm`. A trusted publisher that has not published within two days of being added expires and must be added again, which is why this step waits for the next release.
4. **Disallow tokens.** In each package's Publishing access settings, choose "Require two-factor authentication and disallow tokens". Trusted publishing keeps working, and a leaked token can no longer publish.

### Each release

1. **Bump on a branch:** `node scripts/release/version.mjs <version>`, then `npm run check`, then open a pull request and merge it once CI is green.
2. **Tag the merge commit on the default branch** with `v<version>` and push the tag:
   ```bash
   git tag v0.2.0 <merge-commit>
   git push origin v0.2.0
   ```
3. **The Release workflow runs** (`.github/workflows/release.yml`):
   - `preflight` decides whether the run publishes and checks that the tag is `v<version>` for every package;
   - `pack` runs `npm ci --ignore-scripts` and the pack, uploads the tarballs and `release.json` as a workflow artifact, and reports the SHA-256 of `release.json` as a job output;
   - `verify` runs a normal `npm ci` (Wrangler's runtime needs its install scripts) and `npm run check`, then downloads the artifact and runs the smoke test and `npm publish --dry-run` against it, after checking every hash against the pack job's output;
   - `publish` runs in the `npm` environment, signs in with `NPM_TOKEN` when it is set and otherwise through trusted publishing ([above](#how-the-workflow-signs-in-to-npm)), refuses at once when neither is possible, downloads the same artifact, checks every hash against the pack job's output again and each tarball's `package.json` against the tag, and runs `npm publish --provenance --access public` for each, in dependency order (core, then the packages that depend on it).
4. **If a run fails halfway,** fix the cause and re-run the failed jobs. A version already on the registry is skipped when its integrity matches the local tarball, and stops the run when it does not, so nothing publishes twice and a different build never hides behind a skip. The dry run makes the same check, so CI stays green while the default branch is at a released version. A version that is out cannot be replaced; release a new patch version instead.

A manual run (Actions, Release, Run workflow) is a dry run by default: it does everything except publish. To publish from a manual run, choose the tag under "Use workflow from" and turn `dry_run` off; a publishing run started on a branch fails.

What stops a bad publish:

| Guard | Where |
|---|---|
| Publishes only for a pushed `v*` tag, or a manual run on a `v*` tag with `dry_run` off | `on:` triggers, the `preflight` decision and the `publish` job's `if:` |
| The tag must equal `v<version>` for every package | `version.mjs --check --tag` in `preflight`, then `publish.mjs` against the tarballs |
| A way to sign in: the `NPM_TOKEN` secret, or trusted publishing with the job's OIDC token and npm 11.5.1 or later | `publish.mjs`, before anything is published |
| `latest` never moves backwards | A prerelease publishes under `next`; a stable version older than the registry's `latest` (a patch on an older line) publishes under `maintenance` |
| Only the tarballs that were built without install scripts, and then tested, publish | `pack` builds after `npm ci --ignore-scripts`; `verify` and `publish` use its artifact, never a fresh build, and check every tarball's SHA-256 through `release.json` against the hash `pack` reported as a job output, which no later job can change. A compromised dependency in `verify` can neither touch the tarballs as they are made nor get anything else published |
| A real publish only from GitHub Actions | `publish.mjs` refuses elsewhere, because provenance needs the Actions identity |
| Least privilege | Workflow permissions are `contents: read`; only the `publish` job adds `id-token: write`, and only its sign-in and publish steps see the token, when there is one; after the first release there is none. Every third-party action is pinned to a commit SHA, checkouts keep no credentials, and the release build uses no dependency cache |
| A person in front of the publish | The `publish` job runs in the `npm` environment, which trusted publishing names and which holds the first release's token; give it required reviewers and allow only `v*` tags |

## Verifying a release

```bash
npm view @gtm-agents/cli@0.2.0 version dist.integrity
npx @gtm-agents/cli@0.2.0 --help
npx @gtm-agents/cli@0.2.0 init /tmp/check-agent && cd /tmp/check-agent && npm install
npx wrangler deploy --dry-run && npx gtm doctor
npm audit signatures        # checks registry signatures and provenance attestations
```

Each package page on npmjs.com shows a provenance badge that links to the commit and the workflow run that published it. If anything is wrong, deprecate the version (`npm deprecate @gtm-agents/<pkg>@0.2.0 "<reason>"`) and publish a fixed patch; npm does not let a published version be replaced, and unpublishing is limited.

## Publishing from a fork

A fork that does not own `@gtm-agents` publishes under a scope it owns:

1. Replace the scope everywhere in the source, then refresh the lockfile and links:
   ```bash
   git grep -lz '@gtm-agents' -- ':!package-lock.json' | xargs -0 sed -i.bak 's#@gtm-agents#@your-scope#g'
   find . -name '*.bak' -not -path './node_modules/*' -delete
   npm install && npm run check
   ```
   The release scripts read package names from the workspace manifests; the few places that name the scope (`gtm init`, the smoke test, the docs) are covered by the replacement.
2. Create the npm organization for the scope, and follow [How the workflow signs in to npm](#how-the-workflow-signs-in-to-npm) in the fork: a short-lived `NPM_TOKEN` for its first release, then trusted publishing naming the fork's repository.
3. Run the pack and smoke test locally, then tag. The `repository` field, and therefore provenance, follows the repository that runs the workflow, so nothing else changes.

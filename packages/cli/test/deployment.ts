// GTM-agents: builds a throwaway deployment for CLI tests: the worker template copied by `gtm init`,
// a plain synthetic gtm.config.ts for Acme, a migrations folder where the installed core package
// would put it, and optionally the Acme example brain and templates.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.ts";
import { setupCommand } from "../src/commands/setup.ts";
import type { FakeAccount } from "./fake-wrangler.ts";
import { REPO_ROOT, captureIo } from "./helpers.ts";

export const ADAPTERS_DIR = join(REPO_ROOT, "packages/cli/test/fixtures/adapters");

const CONFIG = `// GTM-agents: a synthetic test deployment's configuration.
export default {
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Example product." } },
  agent: { name: "Avery" },
  sending: { postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000" },
  adapters: { "email-example": { enabled: true, options: {} } },
};
`;

export function makeDeployment(options: { name?: string; brain?: boolean } = {}): string {
  const parent = mkdtempSync(join(tmpdir(), "gtm-deployment-"));
  if (initCommand(["agent", "--name", options.name ?? "acme-gtm"], captureIo(parent)) !== 0) throw new Error("gtm init failed");
  const dir = join(parent, "agent");
  writeFileSync(join(dir, "gtm.config.ts"), CONFIG);
  const migrations = join(dir, "node_modules/@gtm-agents/core/migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, "0001_baseline.sql"), "CREATE TABLE IF NOT EXISTS example (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);\n");
  writeFileSync(join(migrations, "0002_more.sql"), "CREATE TABLE IF NOT EXISTS other (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);\n");
  if (options.brain) {
    const acme = join(REPO_ROOT, "examples/brains/acme");
    for (const name of readdirSync(acme)) {
      if (statSync(join(acme, name)).isFile()) cpSync(join(acme, name), join(dir, "brain", name));
    }
    cpSync(join(acme, "templates"), join(dir, "templates"), { recursive: true });
  }
  return dir;
}

/** A deployment whose production resources gtm setup has created in `account`. Clears the recorded calls. */
export async function setUpDeployment(account: FakeAccount, options: { name?: string; brain?: boolean; env?: string } = {}): Promise<string> {
  const dir = makeDeployment(options);
  const code = await setupCommand(["--yes", "--base-url", "https://agent.acme.example", ...(options.env ? ["--env", options.env] : [])], captureIo(dir), { runner: account.runner, adaptersDir: ADAPTERS_DIR });
  if (code !== 0) throw new Error("gtm setup failed in the test helper");
  account.calls = [];
  return dir;
}

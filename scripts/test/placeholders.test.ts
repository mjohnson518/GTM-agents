// GTM-agents: tests for the template hygiene check. Values that the check must reject are
// assembled at runtime so this file itself stays clean under the same check.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_MARKER, scanPlaceholders } from "../check-placeholders.mjs";

const uuid = ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-");
const realHost = ["acme-agent", "acct"].join(".") + ".workers" + ".dev";
const hex32 = "0123456789abcdef".repeat(2);
const secretValue = "Zx9Qw7Er5Ty3Ui1Op0As";

describe("check-placeholders", () => {
  it("rejects a UUID-shaped string in an ordinary file", () => {
    const findings = scanPlaceholders("src/config.ts", `const id = "${uuid}";`);
    expect(findings.map((f) => f.rule)).toEqual(["uuid"]);
  });

  it("allows UUIDs in a fixture that declares itself synthetic on its first line", () => {
    const text = `// ${SYNTHETIC_MARKER}\nexport const ids = ["${uuid}"];`;
    expect(scanPlaceholders("tests/fixtures/ids.ts", text)).toEqual([]);
  });

  it("allows the nil UUID anywhere", () => {
    expect(scanPlaceholders("README.md", "id: 00000000-0000-0000-0000-000000000000")).toEqual([]);
  });

  it("rejects a real workers.dev hostname and accepts placeholders", () => {
    expect(scanPlaceholders("README.md", `visit https://${realHost}/health`).map((f) => f.rule)).toEqual(["workers-dev"]);
    expect(scanPlaceholders("README.md", "visit https://<worker>.<subdomain>.workers.dev/health")).toEqual([]);
    expect(scanPlaceholders("README.md", "visit https://${WORKER_NAME}.example.workers.dev")).toEqual([]);
  });

  it("rejects a concrete resource id inside a Wrangler config only", () => {
    const line = `"id": "${hex32}"`;
    expect(scanPlaceholders("apps/worker/wrangler.jsonc", line).map((f) => f.rule)).toEqual(["resource-id"]);
    expect(scanPlaceholders("src/hash.ts", line)).toEqual([]);
    expect(scanPlaceholders("apps/worker/wrangler.jsonc", '"id": "${KV_ID}"')).toEqual([]);
  });

  it("rejects a secret-shaped assignment and accepts obvious placeholders", () => {
    expect(scanPlaceholders("src/x.ts", `const api_key = "${secretValue}";`).map((f) => f.rule)).toEqual(["secret"]);
    expect(scanPlaceholders("src/x.ts", 'const api_key = "test-secret-do-not-use";')).toEqual([]);
    expect(scanPlaceholders("src/x.ts", 'token: "<your-telegram-bot-token>"')).toEqual([]);
  });

  it("never prints the secret value in a finding", () => {
    const [finding] = scanPlaceholders("src/x.ts", `password = "${secretValue}"`);
    expect(finding?.detail).not.toContain(secretValue);
  });

  it("exits non-zero from the command line when a file has a problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtm-placeholders-"));
    const bad = join(dir, "bad.ts");
    const good = join(dir, "good.ts");
    writeFileSync(bad, `export const id = "${uuid}";\n`);
    writeFileSync(good, "export const id = 1;\n");
    const run = (file: string) => {
      try {
        execFileSync("node", ["scripts/check-placeholders.mjs", "--files", file], { stdio: "pipe" });
        return 0;
      } catch (err) {
        return (err as { status: number }).status;
      }
    };
    expect(run(bad)).toBe(1);
    expect(run(good)).toBe(0);
  });
});

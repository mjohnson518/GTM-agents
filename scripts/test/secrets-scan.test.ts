// GTM-agents: tests for the secrets scan. Credential-shaped values are assembled at runtime so
// this file never contains one.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fakeAwsKey = "AKIA" + "Q".repeat(16);
const fakeAnthropicKey = "sk-" + "ant-" + "a1B2c3D4e5F6g7H8i9J0k1L2";

function scan(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "gtm-secrets-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, content);
  const result = spawnSync("bash", ["scripts/secrets-scan.sh", "--files", file], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("secrets-scan", () => {
  it("flags a credential and names its kind", () => {
    const { status, output } = scan(`const key = "${fakeAwsKey}";\n`);
    expect(status).toBe(1);
    expect(output).toContain("possible AWS access key id");
  });

  it("never prints the credential itself", () => {
    const { output } = scan(`ANTHROPIC_API_KEY=${fakeAnthropicKey}\n`);
    expect(output).toContain("possible Anthropic API key");
    expect(output).not.toContain(fakeAnthropicKey);
  });

  it("skips a line that carries the allow marker", () => {
    const { status } = scan(`const example = "${fakeAwsKey}"; // secrets-scan:allow\n`);
    expect(status).toBe(0);
  });

  it("passes a clean file", () => {
    const { status, output } = scan("export const answer = 42;\n");
    expect(status).toBe(0);
    expect(output).toContain("secrets-scan: clean");
  });
});

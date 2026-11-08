// GTM-agents: tests for defineConfig() and the configuration schema.
import { describe, expect, it } from "vitest";
import { ConfigError, defineConfig } from "../src/config/index.ts";
import { acmeConfig } from "./fixtures.ts";

describe("defineConfig", () => {
  it("accepts a complete config and applies defaults", () => {
    const config = defineConfig(acmeConfig);
    expect(config.sending.windowDays).toEqual(["MON", "TUE", "WED", "THU"]);
    expect(config.sending.windowHours).toEqual({ start: 8, end: 15 });
    expect(config.sequences.cold.steps.map((s) => s.kind)).toEqual(["cold_intro", "follow_up", "breakup"]);
    expect(config.modules.ship.enabled).toBe(false);
    expect(config.operator.allowedChatIds).toEqual([]);
  });

  it("returns a frozen config", () => {
    const config = defineConfig(acmeConfig);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.sending)).toBe(true);
  });

  it("rejects an unknown key, so a typo fails loudly", () => {
    expect(() => defineConfig({ ...acmeConfig, agnet: { name: "Typo" } } as never)).toThrow(ConfigError);
  });

  it("requires the cold sender to be on the isolated sending domain", () => {
    const input = { ...acmeConfig, sending: { ...acmeConfig.sending, from: { email: "avery@acme.example" } } };
    expect(() => defineConfig(input)).toThrow(/sending domain/);
  });

  it("refuses to start a permanently human-only class above level 1", () => {
    const input = { ...acmeConfig, autonomy: { defaults: { offers: 2 } } };
    expect(() => defineConfig(input)).toThrow(/permanently human-only/);
    expect(() => defineConfig({ ...acmeConfig, autonomy: { defaults: { cold_batch: 2 } } })).not.toThrow();
  });

  it("rejects a non-https company URL and an uppercase domain", () => {
    expect(() => defineConfig({ ...acmeConfig, company: { ...acmeConfig.company, url: "http://acme.example" } })).toThrow(ConfigError);
    expect(() => defineConfig({ ...acmeConfig, company: { ...acmeConfig.company, domain: "Acme.example" } })).toThrow(ConfigError);
  });

  it("produces a readable error that names the field", () => {
    try {
      defineConfig({ ...acmeConfig, sending: { ...acmeConfig.sending, replyTo: "not-an-address" } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("replyTo");
    }
  });
});

// GTM-agents: tests for inbound body storage: the key format, the preview, and round trips through
// the blob binding.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deleteInboundBody, inboundBodyKey, inboundPreview, INBOUND_BODY_MAX_CHARS, INBOUND_PREVIEW_CHARS, putInboundBody, readInboundBody } from "../src/inbox/body.ts";

describe("inbound bodies", () => {
  it("keys a body by its row id and refuses ids that could escape the prefix", () => {
    expect(inboundBodyKey("inb_123")).toBe("inbound/inb_123.txt");
    for (const bad of ["", "../x", "a/b", "a.b", "x".repeat(101)]) expect(() => inboundBodyKey(bad)).toThrow(TypeError);
  });

  it("previews with collapsed whitespace, cut to the preview length", () => {
    expect(inboundPreview("  Hi Riley,\n\n  thanks  ")).toBe("Hi Riley, thanks");
    const long = inboundPreview("word ".repeat(200));
    expect(long.length).toBe(INBOUND_PREVIEW_CHARS);
    expect(long.endsWith("...")).toBe(true);
  });

  it("stores, reads and deletes a body, and reads a missing one as null", async () => {
    const key = await putInboundBody(env.BUCKET, "inb_roundtrip", "Thanks, tell me more.");
    expect(await readInboundBody(env.BUCKET, key)).toBe("Thanks, tell me more.");
    await deleteInboundBody(env.BUCKET, key);
    expect(await readInboundBody(env.BUCKET, key)).toBeNull();
    expect(await readInboundBody(env.BUCKET, null)).toBeNull();
  });

  it("keeps the head of an overlong body", async () => {
    const key = await putInboundBody(env.BUCKET, "inb_long", "a".repeat(INBOUND_BODY_MAX_CHARS + 50));
    expect((await readInboundBody(env.BUCKET, key))?.length).toBe(INBOUND_BODY_MAX_CHARS);
  });
});

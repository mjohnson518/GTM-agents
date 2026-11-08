// GTM-agents: approvals bind to the exact content approved. Editing an approved draft returns it to
// review, and a human-only tool runs only with an approval of its exact input.
import { executeToolCall } from "@gtm-agents/core/runtime";
import {
  applyEdit,
  approveDraft,
  canonicalJson,
  createToolRegistry,
  draftDigest,
  manifestCode,
  markShown,
  toolInputDigest,
  verifyApproval,
  wasShown,
  type ReviewableDraft,
  type ShownStore,
} from "@gtm-agents/core/security";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deps, session, spy } from "./helpers.ts";

const pending: ReviewableDraft = {
  status: "pending_approval",
  approved_digest: null,
  to: "jane.doe@acme.example",
  subject: "Flaky tests at Acme",
  body: "Hi Jane,\n\nDo flaky tests block your merges?\n\nAvery",
};

async function approved(): Promise<ReviewableDraft> {
  const result = await approveDraft(pending, await draftDigest(pending));
  if (!result.ok) throw new Error(result.reason);
  return result.draft;
}

const failingStore: ShownStore = {
  get: async () => {
    throw new Error("kv unavailable");
  },
  put: async () => {
    throw new Error("kv unavailable");
  },
};

describe("draft digests", () => {
  it("are stable hex SHA-256 values", async () => {
    const digest = await draftDigest(pending);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await draftDigest({ ...pending })).toBe(digest);
  });

  it("fold the recipient's case and spacing but keep subject and body exact", async () => {
    const digest = await draftDigest(pending);
    expect(await draftDigest({ ...pending, to: "  Jane.Doe@ACME.example " })).toBe(digest);
    expect(await draftDigest({ ...pending, subject: `${pending.subject} ` })).not.toBe(digest);
    expect(await draftDigest({ ...pending, body: `${pending.body}\n` })).not.toBe(digest);
  });

  it("do not let distinct recipients share a digest through Unicode case mapping or line breaks", async () => {
    const kate = await draftDigest({ ...pending, to: "kate@acme.example" });
    expect(await draftDigest({ ...pending, to: `${String.fromCodePoint(0x212a)}ate@acme.example` })).not.toBe(kate);
    expect(await draftDigest({ ...pending, to: "kate@acme.example\r\n" })).not.toBe(kate);
    expect(await draftDigest({ ...pending, to: "KATE@acme.example" })).toBe(kate);
  });

  it("cannot be shared by drafts whose fields differ only in where a boundary falls", async () => {
    const a = await draftDigest({ to: "jane.doe@acme.example", subject: "Hi\nthere", body: "Avery" });
    const b = await draftDigest({ to: "jane.doe@acme.example", subject: "Hi", body: "there\nAvery" });
    const c = await draftDigest({ to: "jane.doe@acme.example\nHi", subject: "there", body: "Avery" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("editing a draft", () => {
  it("returns an approved draft to review when its content changes", async () => {
    const draft = await approved();
    expect(await verifyApproval(draft)).toBe(true);
    const edited = await applyEdit(draft, { body: `${pending.body}\nP.S. One more thing.` });
    expect(edited.returnedToReview).toBe(true);
    expect(edited.draft.status).toBe("pending_approval");
    expect(edited.draft.approved_digest).toBeNull();
    expect(await verifyApproval(edited.draft)).toBe(false);
  });

  it("keeps the approval when the edit does not change the approved content", async () => {
    const draft = await approved();
    const same = await applyEdit(draft, { body: pending.body, to: "JANE.DOE@acme.example" });
    expect(same.returnedToReview).toBe(false);
    expect(same.draft.status).toBe("approved");
    expect(await verifyApproval(same.draft)).toBe(true);
  });

  it("takes only content from an edit, never a status or a digest", async () => {
    const forged = { body: "Rewritten", status: "approved", approved_digest: "f".repeat(64) } as never;
    const result = await applyEdit(pending, forged);
    expect(result.draft.status).toBe("pending_approval");
    expect(result.draft.approved_digest).toBeNull();
    expect(result.draft.body).toBe("Rewritten");
    expect(await verifyApproval(result.draft)).toBe(false);
  });

  it("refuses to edit a sent draft and leaves other statuses alone", async () => {
    await expect(applyEdit({ ...(await approved()), status: "sent" }, { body: "x" })).rejects.toThrow(/sent/);
    const stillPending = await applyEdit(pending, { subject: "New subject" });
    expect(stillPending).toMatchObject({ returnedToReview: false, draft: { status: "pending_approval", subject: "New subject" } });
  });

  it("catches a send path relying on an approval whose content was changed in storage", async () => {
    const draft = await approved();
    expect(await verifyApproval({ ...draft, subject: "Changed directly" })).toBe(false);
    expect(await verifyApproval({ ...draft, approved_digest: null })).toBe(false);
    expect(await verifyApproval(pending)).toBe(false);
  });
});

describe("approving a draft", () => {
  it("refuses when the draft changed after it was shown", async () => {
    const shown = await draftDigest(pending);
    const result = await approveDraft({ ...pending, body: "Swapped after the preview" }, shown);
    expect(result).toEqual({ ok: false, reason: "the draft changed after it was shown" });
  });

  it("refuses sent and rejected drafts", async () => {
    const shown = await draftDigest(pending);
    expect((await approveDraft({ ...pending, status: "sent" }, shown)).ok).toBe(false);
    expect((await approveDraft({ ...pending, status: "rejected" }, shown)).ok).toBe(false);
  });
});

describe("shown records", () => {
  it("bind a one-tap approval to the content the operator saw", async () => {
    const store = env.KV as unknown as ShownStore;
    expect(await wasShown(store, "draft-shown-1", pending)).toBe(false);
    expect(await markShown(store, "draft-shown-1", pending)).toBe(true);
    expect(await wasShown(store, "draft-shown-1", pending)).toBe(true);
    expect(await wasShown(store, "draft-shown-1", { ...pending, body: "Different text" })).toBe(false);
  });

  it("fail closed when checking and open when recording", async () => {
    expect(await wasShown(failingStore, "draft-shown-2", pending)).toBe(false);
    expect(await markShown(failingStore, "draft-shown-2", pending)).toBe(false);
  });
});

describe("batch manifest codes", () => {
  it("are six hex characters, independent of order, and change with any digest", async () => {
    const code = await manifestCode({ d1: "a".repeat(64), d2: "b".repeat(64) });
    expect(code).toMatch(/^[0-9a-f]{6}$/);
    expect(await manifestCode({ d2: "b".repeat(64), d1: "a".repeat(64) })).toBe(code);
    expect(await manifestCode({ d1: "a".repeat(64), d2: "c".repeat(64) })).not.toBe(code);
    expect(await manifestCode({ d1: "a".repeat(64) })).not.toBe(code);
  });

  it("refuse an empty manifest", async () => {
    await expect(manifestCode({})).rejects.toThrow(RangeError);
  });
});

describe("canonical JSON", () => {
  it("sorts keys at every level and drops undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined], c: "x" }, e: undefined })).toBe('{"a":{"c":"x","d":[1,null]},"b":1}');
  });

  it("refuses values it cannot represent faithfully", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, Symbol("s"), cycle, new Map(), new Set([1]), new Date(0)]) {
      expect(() => canonicalJson({ value })).toThrow(TypeError);
    }
  });
});

describe("human-only tools", () => {
  const input = { contact_id: "contact-acme-0001", reason: "erasure request" };

  it("run only with an approval of their exact input", async () => {
    const erase = spy("erased");
    const d = deps({ contact_erase: erase.handler });
    const refused = await executeToolCall(d, session(), { name: "contact_erase", input });
    expect(refused).toMatchObject({ status: "blocked", code: "human_only" });

    const reordered = { reason: input.reason, contact_id: input.contact_id };
    const approval = { digest: await toolInputDigest("contact_erase", reordered) };
    const ok = await executeToolCall(d, session(), { name: "contact_erase", input }, { approval });
    expect(ok.status).toBe("ok");
    expect(erase.calls).toHaveLength(1);
  });

  it("refuse an approval made for a different input or a different tool", async () => {
    const erase = spy("erased");
    const d = deps({ contact_erase: erase.handler });
    const other = { digest: await toolInputDigest("contact_erase", { ...input, contact_id: "contact-acme-0002" }) };
    const wrongTool = { digest: await toolInputDigest("repo_pr_merge", input) };
    for (const approval of [other, wrongTool]) {
      const result = await executeToolCall(d, session(), { name: "contact_erase", input }, { approval });
      expect(result).toMatchObject({ status: "blocked", code: "human_only" });
    }
    expect(erase.calls).toEqual([]);
  });

  it("stay human-only when nobody declared them", async () => {
    const merge = spy("merged");
    const registry = createToolRegistry({ core: {} });
    const result = await executeToolCall({ registry, handlers: { repo_pr_merge: merge.handler } }, session(), { name: "repo_pr_merge", input: { pr: 1 } });
    expect(result).toMatchObject({ status: "blocked", code: "human_only" });
    expect(merge.calls).toEqual([]);
  });

  it("are still refused in a tainted session, approval or not", async () => {
    const erase = spy("erased");
    const approval = { digest: await toolInputDigest("contact_erase", input) };
    const result = await executeToolCall(deps({ contact_erase: erase.handler }), session("metadata"), { name: "contact_erase", input }, { approval });
    expect(result).toMatchObject({ status: "blocked", code: "tainted" });
    expect(erase.calls).toEqual([]);
  });
});

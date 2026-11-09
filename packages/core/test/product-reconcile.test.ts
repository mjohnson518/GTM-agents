// GTM-agents: the nightly pull, against a host served by the SDK's own read handler (so the agent's
// signing and the SDK's verification are proven together): deletions first, missed sign-ups and
// activations repaired, feedback filed once, high-water marks that only advance when a pass ends,
// at most 3 pages of 200 a run, a weekly full re-read. Every person and company is invented.
import { beforeEach, describe, expect, it } from "vitest";
import { createReadHandler, type ReadQuery } from "../../sdk/src/index.ts";
import { memoryKv, type MemoryKvNamespace } from "../src/agents/testing.ts";
import { pullStateKey } from "../src/lifecycle/flags.ts";
import { flagReader, silentLogger } from "../src/outreach/testing.ts";
import { fileFeedback } from "../src/product-bridge/feedback.ts";
import { reconcileProduct, type ReconcileDeps } from "../src/product-bridge/reconcile.ts";
import { addressHash } from "../src/sending/suppression.ts";
import { bucket, count, db, person, READ_SECRET, resetLifecycle, state, urlOf } from "./lifecycle-fixtures.ts";

const NOW = new Date("2026-11-04T03:15:00.000Z");
const APP = "https://app.acme.example";

type Row = Record<string, unknown>;

/** A host: three tables, paged by (stamp, id) after `since` and the cursor, like a real read endpoint. */
function host(data: { users?: Row[]; feedback?: Row[]; deletions?: Row[] }, options: { secret?: string; failing?: string[] } = {}) {
  const seen: Array<{ resource: string; since: string | null; cursor: string | null }> = [];
  const page = (rows: Row[], stamp: string, idKey: string) => async (q: ReadQuery) => {
    const sorted = [...rows].sort((a, b) => String(a[stamp]).localeCompare(String(b[stamp])) || String(a[idKey]).localeCompare(String(b[idKey])));
    const after = sorted.filter((r) => q.since === null || String(r[stamp]) >= q.since);
    const start = q.cursor === null ? 0 : after.findIndex((r) => r[idKey] === q.cursor) + 1;
    const items = after.slice(start, start + q.limit);
    return { items, hasMore: start + q.limit < after.length };
  };
  const handler = createReadHandler({
    secret: options.secret ?? READ_SECRET,
    users: page(data.users ?? [], "updated_at", "id"),
    feedback: page(data.feedback ?? [], "created_at", "id"),
    deletions: page(data.deletions ?? [], "deleted_at", "user_id"),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(urlOf(input), init);
    const url = new URL(request.url);
    const resource = url.pathname.split("/").pop() ?? "";
    seen.push({ resource, since: url.searchParams.get("since"), cursor: url.searchParams.get("cursor") });
    if (options.failing?.includes(resource)) return new Response("down", { status: 500 });
    return handler(request);
  };
  return { fetch: fetchImpl, seen };
}

function deps(fetchImpl: typeof fetch, kv: MemoryKvNamespace, overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return { db, kv, bucket, appUrl: APP, readSecret: READ_SECRET, flags: flagReader({ "outreach:ref_tokens_enabled": "true" }), now: NOW, log: silentLogger, fetch: fetchImpl, ...overrides };
}

const user = (id: string, email: string, extra: Row = {}): Row => ({ id, email, name: "Ada Lovelace", created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-02T10:00:00Z", signup_ref: null, org: { id: "org_1", name: "Acme", plan_tier: "free", usage_this_period: 0 }, ...extra });

beforeEach(resetLifecycle);

describe("the pull", () => {
  it("repairs a missed sign-up with its attribution, and an activation from usage", async () => {
    const ada = await person({ email: "ada@globex.example" });
    await db.prepare("INSERT INTO ref_tokens (token, contact_id, campaign_id, created_at) VALUES ('ref_spring', ?1, 'cmp_spring', '2026-10-20T00:00:00.000Z')").bind(ada.id).run();
    const h = host({ users: [user("usr_ada", "ada@globex.example", { signup_ref: "ref_spring", org: { id: "org_g", name: "Globex", plan_tier: "pro", usage_this_period: 3 } }), user("usr_new", "new@initech.example")] });
    const report = await reconcileProduct(deps(h.fetch, memoryKv()));
    expect(report).toMatchObject({ status: "ok", rows: 2, signups: 2, activations: 1, refused: 0, recordErrors: 0 });
    expect(await state(ada.id)).toMatchObject({ state: "activated", product_user_id: "usr_ada", attribution_method: "ref_token", attributed_campaign_id: "cmp_spring", signup_ref: "ref_spring", plan_tier: "pro", product_org_id: "org_g", signed_up_at: "2026-11-01T10:00:00.000Z" });
    expect(JSON.parse(String((await state(ada.id))?.usage))).toEqual({ usage_this_period: 3 });
    // Read again: nothing moves twice.
    const again = await reconcileProduct(deps(h.fetch, memoryKv()));
    expect(again).toMatchObject({ signups: 0, activations: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1", ada.id)).toBe(2);
  });

  it("applies deletions first, so a deleted user in the same night's users read is refused", async () => {
    const ada = await person({ email: "ada@vandelay.example" });
    const hash = await addressHash("ada@vandelay.example");
    const h = host({ deletions: [{ user_id: "usr_v", email_sha256: hash, deleted_at: "2026-11-03T09:00:00Z" }], users: [user("usr_v", "ada@vandelay.example")] });
    const report = await reconcileProduct(deps(h.fetch, memoryKv()));
    expect(report).toMatchObject({ deletions: 1, refused: 1, signups: 0 });
    expect(h.seen.map((s) => s.resource)).toEqual(["deletions", "users", "feedback"]);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1 OR email = 'ada@vandelay.example'", ada.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM erasure_tombstones WHERE email_sha256 = ?1 AND source = 'reconciliation'", hash)).toBe(1);
  });

  it("files feedback once, recognizing a copy the push already filed, and only for an author who is a contact", async () => {
    const ada = await person({ email: "pm@hooli.example" });
    await fileFeedback(db, { text: "Exports are slow.", authorSha256: await addressHash("pm@hooli.example"), productUserId: "usr_pm", contactId: ada.id, createdAt: "2026-11-02T10:00:00.000Z" });
    const h = host({
      feedback: [
        { id: "fb_1", created_at: "2026-11-02T10:00:00Z", author_email: "PM@hooli.example", author_name: "Pat", context: "report:9", text: "Exports are slow.", rating: 2 },
        { id: "fb_2", created_at: "2026-11-02T11:00:00Z", author_email: "stranger@nowhere.example", text: "Dark mode please." },
      ],
    });
    const report = await reconcileProduct(deps(h.fetch, memoryKv()));
    expect(report.feedback).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM feedback_items WHERE source = 'product'")).toBe(1);
    // A stranger's words are not kept: nothing could find them again for an erasure.
    expect(await count("SELECT COUNT(*) AS n FROM feedback_items WHERE text = 'Dark mode please.'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE email = 'stranger@nowhere.example'")).toBe(0);
    const other = await person({ email: "dev@hooli.example" });
    const more = host({ feedback: [{ id: "fb_3", created_at: "2026-11-02T12:00:00Z", author_email: "dev+fb@hooli.example", text: "Faster exports." }] });
    expect((await reconcileProduct(deps(more.fetch, memoryKv()))).feedback).toBe(1);
    expect(await db.prepare("SELECT contact_id, product_user_id FROM feedback_items WHERE text = 'Faster exports.'").first()).toEqual({ contact_id: other.id, product_user_id: null });
  });

  it("asks for pages of 200 by default", async () => {
    const requested: string[] = [];
    const h = host({});
    const spy: typeof fetch = async (input, init) => {
      requested.push(new URL(urlOf(input)).searchParams.get("limit") ?? "");
      return h.fetch(input, init);
    };
    await reconcileProduct(deps(spy, memoryKv()));
    expect(requested).toEqual(["200", "200", "200"]);
  });

  it("reads at most 3 pages a run, resumes where it stopped, and advances its mark only when the pass ends", async () => {
    // Pages of 4 here stand in for pages of 200: the same rule at a size a test can afford.
    const limits = { pageSize: 4 };
    const users = Array.from({ length: 14 }, (_, i) => user(`usr_${String(i).padStart(4, "0")}`, `u${i}@bulk.example`, { updated_at: `2026-10-${String(1 + i).padStart(2, "0")}T00:00:00Z` }));
    const kv = memoryKv();
    const h = host({ users });
    const first = await reconcileProduct(deps(h.fetch, kv, { limits }));
    expect(first.rows).toBe(12);
    const mid = JSON.parse(kv.map.get(pullStateKey("users")) ?? "{}") as Record<string, unknown>;
    expect(mid).toMatchObject({ since: null, cursor: "usr_0011", done: null });
    expect(h.seen.filter((s) => s.resource === "users")).toHaveLength(3);
    const second = await reconcileProduct(deps(h.fetch, kv, { limits, now: new Date(NOW.getTime() + 86_400_000) }));
    expect(second.rows).toBe(2);
    const done = JSON.parse(kv.map.get(pullStateKey("users")) ?? "{}") as Record<string, unknown>;
    expect(done).toMatchObject({ cursor: null, done: "2026-10-14T00:00:00.000Z" });
    expect(await count("SELECT COUNT(*) AS n FROM contact_lifecycle WHERE state = 'signed_up'")).toBe(14);
    // The next night reads from the mark; a week after the full read started, from nothing.
    const third = host({ users });
    await reconcileProduct(deps(third.fetch, kv, { limits, now: new Date(NOW.getTime() + 2 * 86_400_000) }));
    expect(third.seen.find((s) => s.resource === "users")?.since).toBe("2026-10-14T00:00:00.000Z");
    const weekly = host({ users });
    await reconcileProduct(deps(weekly.fetch, kv, { limits, now: new Date(NOW.getTime() + 8 * 86_400_000) }));
    expect(weekly.seen.find((s) => s.resource === "users")?.since).toBeNull();
  });

  it("stops a resource whose read fails and keeps the others, but reads nothing after failed deletions", async () => {
    const h = host({ users: [user("usr_ok", "ok@acme.example")] }, { failing: ["feedback"] });
    const report = await reconcileProduct(deps(h.fetch, memoryKv()));
    expect(report.status).toBe("partial");
    expect(report.errors[0]).toMatch(/^feedback: the feedback read answered 500/);
    expect(report.signups).toBe(1);
    const blocked = host({ users: [user("usr_later", "later@acme.example")] }, { failing: ["deletions"] });
    const stopped = await reconcileProduct(deps(blocked.fetch, memoryKv()));
    expect(stopped.errors[0]).toMatch(/^deletions: the deletions read answered 500/);
    expect(blocked.seen.map((s) => s.resource)).toEqual(["deletions"]);
    expect(stopped.signups).toBe(0);
  });

  it("never passes a deletion row by: one that fails is read again next run before the mark moves", async () => {
    const ada = await person({ email: "ada@initrode.example" });
    const hash = await addressHash("ada@initrode.example");
    const kv = memoryKv();
    const h = host({ deletions: [{ user_id: "usr_i", email_sha256: hash, deleted_at: "2026-11-03T09:00:00Z" }] });
    const broken = { ...deps(h.fetch, kv), bucket: null };
    // Without blob storage the erasure cannot delete stored payloads, so make it need to.
    await db.prepare("INSERT INTO events (id, source, type, occurred_at, received_at, contact_id, payload_key, taint) VALUES ('product:old', 'product', 'user.signed_up', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?1, 'events/product/old.json', 'structured')").bind(ada.id).run();
    const first = await reconcileProduct(broken);
    expect(first.deletions).toBe(0);
    // The failed page was not saved: the next run reads it again.
    expect(kv.map.get(pullStateKey("deletions"))).toBeUndefined();
    const second = await reconcileProduct(deps(h.fetch, kv));
    expect(second.deletions).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1", ada.id)).toBe(0);
  });

  it("is refused by the host when signed with another secret", async () => {
    const h = host({ users: [user("usr_x", "x@acme.example")] }, { secret: "z".repeat(40) });
    const report = await reconcileProduct(deps(h.fetch, memoryKv()));
    expect(report.status).toBe("partial");
    expect(report.errors.every((e) => e.includes("answered 401"))).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM contacts")).toBe(0);
  });

  it("skips without an https PRODUCT_APP_URL and a read secret, reading nothing", async () => {
    const h = host({});
    expect((await reconcileProduct(deps(h.fetch, memoryKv(), { appUrl: "http://app.acme.example" }))).status).toBe("skipped");
    expect((await reconcileProduct(deps(h.fetch, memoryKv(), { readSecret: undefined }))).status).toBe("skipped");
    expect((await reconcileProduct(deps(h.fetch, memoryKv(), { appUrl: "https://user:pw@app.acme.example" }))).status).toBe("skipped");
    expect(h.seen).toHaveLength(0);
  });
});

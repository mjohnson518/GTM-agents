// GTM-agents: what the CRM mirror may send out of the deployment. Inbound text (a reply's body,
// preview, subject, sender name, headers or triage notes, and the subject of a reply we sent, which
// can repeat theirs) never reaches a CRM sink, whatever it says. An erased person is never written
// again: their link is deleted and the operator is told which CRM record to delete, without their
// address. A suppressed contact gets no activity.
import { runCrmMirror } from "@gtm-agents/core/crm";
import { fakeCrmSink, seedCrmCursors } from "@gtm-agents/core/crm/testing";
import { contactEmailFields, eraseContact } from "@gtm-agents/core/data";
import { addSuppression } from "@gtm-agents/core/sending";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { INJECTED_PAGE, uid } from "./helpers.ts";

const db = env.DB;
const CANARY = "CANARY-7f3a";
let hour = 0;

async function window() {
  hour += 1;
  const start = Date.UTC(2032, 5, 1) + hour * 3_600_000;
  const sink = fakeCrmSink(uid("crm"));
  await seedCrmCursors(db, sink.name, new Date(start));
  return { sink, at: (m: number) => new Date(start + m * 60_000).toISOString(), now: new Date(start + 50 * 60_000) };
}

async function contact(at: string): Promise<{ id: string; email: string }> {
  const fields = await contactEmailFields(`${uid("riley").replace(/_/g, ".")}@${uid("initech").replace(/_/g, "-")}.example`);
  if (!fields) throw new Error("bad synthetic address");
  const id = uid("contact");
  await db
    .prepare("INSERT INTO contacts (id, first_name, email, email_sha256, mailbox_sha256, warmth, created_at, updated_at) VALUES (?1, 'Riley', ?2, ?3, ?4, 'engaged', ?5, ?5)")
    .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, at)
    .run();
  return { id, email: fields.email };
}

describe("crm mirror: untrusted text never leaves", () => {
  it("no inbound field, and no subject of a reply we sent, reaches the sink", async () => {
    const { sink, at, now } = await window();
    const c = await contact(at(1));
    const text = `${CANARY} ${INJECTED_PAGE}`;
    await db
      .prepare(
        `INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, sender_name, subject, body_preview, received_at, classification, intent, contact_id, notes, headers, triage, created_at, updated_at)
         VALUES (?1, 'test', ?1, ?2, ?3, ?3, ?3, ?4, 'reply', 'interested', ?5, ?3, json_object('x', ?3), json_object('reason', ?3), ?4, ?4)`,
      )
      .bind(uid("inbound"), c.email, text, at(2), c.id)
      .run();
    await db
      .prepare("INSERT INTO outreach_sends (id, contact_id, subject, send_path, provider, sent_at, created_at) VALUES (?1, ?2, ?3, 'reply', 'test', ?4, ?4)")
      .bind(uid("send"), c.id, `Re: ${text}`, at(3))
      .run();
    const deal = uid("deal");
    await db.prepare("INSERT INTO deals (id, contact_id, name, notes) VALUES (?1, ?2, 'Initech pilot', ?3)").bind(deal, c.id, text).run();
    await db.prepare("INSERT INTO deal_stage_history (id, deal_id, from_stage, to_stage, reason, created_at) VALUES (?1, ?2, 'contacted', 'engaged', ?3, ?4)").bind(uid("stage"), deal, text, at(4)).run();

    const result = await runCrmMirror({ db, sink, now, perRun: 100 });
    expect(result.error).toBeUndefined();
    const summaries = sink.calls.filter((x) => x.kind === "activity").map((x) => (x.args as { summary: string }).summary);
    expect(summaries).toEqual(["Reply sent", "Reply received: interested", "Deal moved to engaged"]);
    expect(JSON.stringify(sink.calls)).not.toContain(CANARY);
  });

  it("an intent the mirror does not know is not passed through", async () => {
    const { sink, at, now } = await window();
    const c = await contact(at(1));
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, intent, contact_id, created_at, updated_at) VALUES (?1, 'test', ?1, ?2, ?3, ?4, ?5, ?3, ?3)")
      .bind(uid("inbound"), c.email, at(2), CANARY, c.id)
      .run();
    await runCrmMirror({ db, sink, now, perRun: 100 });
    expect(sink.calls.filter((x) => x.kind === "activity")).toHaveLength(0);
    expect(JSON.stringify(sink.calls)).not.toContain(CANARY);
  });
});

describe("crm mirror: erasure and suppression", () => {
  it("erasure deletes the link, sends nothing to the CRM, and tells the operator which record to delete", async () => {
    const { sink, at, now } = await window();
    const c = await contact(at(1));
    await runCrmMirror({ db, sink, now, perRun: 100 });
    expect(sink.calls).toHaveLength(1);
    const before = sink.calls.length;

    await eraseContact(db, c.email, { source: "operator", now, bucket: env.BUCKET });
    expect(sink.calls).toHaveLength(before);
    const link = await db.prepare("SELECT 1 FROM crm_links WHERE local_kind = 'contact' AND local_id = ?1").bind(c.id).first();
    expect(link).toBeNull();
    const { results } = await db.prepare("SELECT text, status, kind FROM operator_outbox WHERE text LIKE ?1").bind(`%(${sink.name})%`).all<{ text: string; status: string; kind: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "held", kind: "notice" });
    expect(results[0]?.text).toContain("rec-1");
    expect(results[0]?.text).not.toContain(c.email);
    // The record id is kept for good, even if the notice is never delivered.
    expect(await db.prepare("SELECT external_id FROM crm_erasures WHERE sink = ?1").bind(sink.name).first()).toEqual({ external_id: "rec-1" });

    // Activity about them recorded before the erasure is never mirrored afterwards.
    await runCrmMirror({ db, sink, now, perRun: 100 });
    expect(sink.calls).toHaveLength(before);
  });

  it("a suppressed contact gets no activity, whatever the stream", async () => {
    const { sink, at, now } = await window();
    const c = await contact(at(1));
    await runCrmMirror({ db, sink, now, perRun: 100 });
    await addSuppression(db, { email: c.email, reason: "manual", source: "test" });
    await db.prepare("INSERT INTO outreach_sends (id, contact_id, subject, send_path, provider, sent_at, created_at) VALUES (?1, ?2, 'Hello', 'cold', 'test', ?3, ?3)").bind(uid("send"), c.id, at(5)).run();
    await runCrmMirror({ db, sink, now, perRun: 100 });
    expect(sink.calls.filter((x) => x.kind === "activity")).toHaveLength(0);
  });
});

// GTM-agents: the shared contract for OperatorChannel adapters.
//
// Call it from an adapter's contract.test.ts with recorded vendor responses:
//
//   runOperatorChannelContract((ctx) => createAdapter(ctx), fixtures);
//
// It checks what core relies on, whatever the channel:
//   - a correctly signed message is accepted and reports chat, user and message ids and the text;
//   - a tampered webhook (wrong secret) and an unsigned one are rejected with an auth AdapterError;
//   - updates the agent does not handle come back as "ignored";
//   - text is delivered as plain text, with no markup interpretation;
//   - approval buttons carry the approval id and the digest of the content shown, and a tap returns
//     them exactly: core can match the tap to the current content, and refuses it when the content
//     changed (a stale digest) or when the digest in a tap was altered.
import { draftDigest } from "@gtm-agents/core/security";
import { parseApprovalPayload, payloadMatchesDigest } from "@gtm-agents/core/operator";
import type { AdapterContext, OperatorChannel } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";

export interface ContractMessage {
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
}

export interface ContractCallback {
  chatId: string;
  userId: string;
  messageId: string;
  callbackId: string;
  /** The data a button carries, exactly as buttonsSent reported it. */
  data: string;
}

export interface OperatorChannelFixtures {
  /** A context with the channel's secrets and a recorded fetch for its outbound calls, and the requests it saw. */
  context(): { ctx: AdapterContext; calls: Request[] };
  /** A webhook request for a text message, signed with the configured secret. */
  signedMessage(message: ContractMessage): Request;
  /** The same message signed with the wrong secret. */
  tamperedMessage(message: ContractMessage): Request;
  /** The same message with no signature at all. */
  unsignedMessage(message: ContractMessage): Request;
  /** A signed update the agent does not handle, such as an edited message. */
  signedUnsupported(): Request;
  /** A signed button tap carrying `data`. */
  signedCallback(callback: ContractCallback): Request;
  /** The buttons in an outbound request: each label and the data a tap returns. */
  buttonsSent(request: Request): Promise<Array<{ label: string; data: string }>>;
  /** The text in an outbound request, and whether it asked the vendor to interpret markup. */
  textSent(request: Request): Promise<{ text: string; markup: boolean } | null>;
  /** A chat id the context's channel can deliver to. */
  chatId: string;
}

const message: ContractMessage = { chatId: "100200300", userId: "100200300", messageId: "41", text: "Look at https://acme.example/pricing" };
const draftA = { to: "jane@acme.example", subject: "Faster CI at Acme", body: "Hi Jane, we cut setup to under an hour." };
const draftB = { ...draftA, body: "Hi Jane, we cut setup to under ten minutes." };

async function rejection(promise: Promise<unknown>): Promise<{ code: unknown; retryable: unknown }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: unknown; retryable?: unknown };
    return { code: e.code, retryable: e.retryable };
  }
  throw new Error("expected the update to be rejected");
}

export function runOperatorChannelContract(create: (ctx: AdapterContext) => OperatorChannel, fixtures: OperatorChannelFixtures): void {
  describe("OperatorChannel contract", () => {
    it("accepts a signed message and reports its chat, sender, id and text", async () => {
      const { ctx } = fixtures.context();
      expect(await create(ctx).parseUpdate(fixtures.signedMessage(message))).toEqual({ type: "command", ...message });
    });

    it("rejects a tampered webhook with a non-retryable auth error", async () => {
      const { ctx } = fixtures.context();
      expect(await rejection(create(ctx).parseUpdate(fixtures.tamperedMessage(message)))).toEqual({ code: "auth", retryable: false });
    });

    it("rejects an unsigned webhook with a non-retryable auth error", async () => {
      const { ctx } = fixtures.context();
      expect(await rejection(create(ctx).parseUpdate(fixtures.unsignedMessage(message)))).toEqual({ code: "auth", retryable: false });
    });

    it("reports an update the agent does not handle as ignored", async () => {
      const { ctx } = fixtures.context();
      expect(await create(ctx).parseUpdate(fixtures.signedUnsupported())).toMatchObject({ type: "ignored" });
    });

    it("delivers text as plain text, without interpreting markup", async () => {
      const { ctx, calls } = fixtures.context();
      const text = "Plans: <b>Team</b> *$400* [details](https://acme.example/pricing) _soon_";
      const sent = await create(ctx).notify({ text, chatId: fixtures.chatId });
      expect(sent.messageId.length).toBeGreaterThan(0);
      expect(await fixtures.textSent(calls.at(-1) as Request)).toEqual({ text, markup: false });
    });

    it("binds approval buttons to the approval id and digest, and a tap returns them exactly", async () => {
      const { ctx, calls } = fixtures.context();
      const channel = create(ctx);
      const digest = await draftDigest(draftA);
      await channel.requestApproval({ approvalId: "dr_contract01", chatId: fixtures.chatId, kind: "send", digest, summary: "Approve this draft?", preview: draftA.body, actions: ["approve", "reject"] });
      const buttons = await fixtures.buttonsSent(calls.at(-1) as Request);
      expect(buttons.map((b) => b.label)).toEqual(["Approve", "Reject"]);
      const approve = buttons[0]?.data ?? "";
      const update = await channel.parseUpdate(fixtures.signedCallback({ chatId: fixtures.chatId, userId: fixtures.chatId, messageId: "77", callbackId: "cb-contract-1", data: approve }));
      expect(update).toMatchObject({ type: "callback", action: "approve", chatId: fixtures.chatId, messageId: "77", callbackId: "cb-contract-1" });
      const payload = parseApprovalPayload(update.type === "callback" ? update.payload : "");
      expect(payload?.approvalId).toBe("dr_contract01");
      expect(await payloadMatchesDigest(payload?.digest ?? "", digest)).toBe(true);
      const reject = await channel.parseUpdate(fixtures.signedCallback({ chatId: fixtures.chatId, userId: fixtures.chatId, messageId: "77", callbackId: "cb-contract-2", data: buttons[1]?.data ?? "" }));
      expect(reject).toMatchObject({ type: "callback", action: "reject" });
    });

    it("returns a stale digest unchanged, so an approval of content that has since changed is refused", async () => {
      const { ctx, calls } = fixtures.context();
      const channel = create(ctx);
      await channel.requestApproval({ approvalId: "dr_contract02", chatId: fixtures.chatId, kind: "send", digest: await draftDigest(draftA), summary: "Approve?", preview: draftA.body, actions: ["approve"] });
      const [approve] = await fixtures.buttonsSent(calls.at(-1) as Request);
      const update = await channel.parseUpdate(fixtures.signedCallback({ chatId: fixtures.chatId, userId: fixtures.chatId, messageId: "78", callbackId: "cb-contract-3", data: approve?.data ?? "" }));
      const payload = parseApprovalPayload(update.type === "callback" ? update.payload : "");
      // The draft was edited after it was shown: the tap still names the old content.
      expect(await payloadMatchesDigest(payload?.digest ?? "", await draftDigest(draftB))).toBe(false);
      // A tap whose digest was altered does not match the content that was shown.
      const forged = (approve?.data ?? "").replace(/[0-9a-f]$/, (c) => (c === "0" ? "1" : "0"));
      const altered = await channel.parseUpdate(fixtures.signedCallback({ chatId: fixtures.chatId, userId: fixtures.chatId, messageId: "78", callbackId: "cb-contract-4", data: forged }));
      const alteredPayload = parseApprovalPayload(altered.type === "callback" ? altered.payload : "");
      expect(await payloadMatchesDigest(alteredPayload?.digest ?? "", await draftDigest(draftA))).toBe(false);
    });

    it("acknowledges a tap and edits a message without failing", async () => {
      const { ctx } = fixtures.context();
      const channel = create(ctx);
      await expect(channel.acknowledgeCallback("cb-contract-5", "Approved. Nothing was sent.")).resolves.toBeUndefined();
      await expect(channel.editMessage("77", { text: "Approved draft dr_contract01.", chatId: fixtures.chatId })).resolves.toBeUndefined();
    });
  });
}

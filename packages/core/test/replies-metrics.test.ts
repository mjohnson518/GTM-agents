// GTM-agents: the one definition of a reply and a positive reply. Pure functions; every input is
// synthetic.
import { describe, expect, it } from "vitest";
import { NON_REPLY_INTENTS, POSITIVE_INTENTS, REPLY_INTENTS, countsAsReply, isPositiveReply, meetingCountsAsPositive, positiveReplyAt } from "../src/metrics/index.ts";

const SENT = "2026-11-01T10:00:00.000Z";

describe("a reply", () => {
  it("never counts opt-outs, unsubscribes, automatic replies, spam or noise", () => {
    for (const intent of NON_REPLY_INTENTS) expect(countsAsReply({ intent, classification: "reply" }), intent).toBe(false);
    for (const classification of ["unsubscribe", "auto_reply", "out_of_office", "spam", "bounce"]) {
      expect(countsAsReply({ intent: "interested", classification }), classification).toBe(false);
    }
  });

  it("counts every other intent, not a fit included", () => {
    for (const intent of REPLY_INTENTS.filter((i) => !NON_REPLY_INTENTS.includes(i))) expect(countsAsReply({ intent, classification: "reply" }), intent).toBe(true);
    expect(countsAsReply({ intent: "not_a_fit", classification: "new_inquiry" })).toBe(true);
  });

  it("counts an untriaged message only when a person wrote it, and never an unknown intent", () => {
    expect(countsAsReply({ intent: null, classification: "reply" })).toBe(true);
    expect(countsAsReply({ intent: null, classification: "unclassified" })).toBe(false);
    expect(countsAsReply({ intent: "delighted", classification: "reply" })).toBe(false);
  });
});

describe("a positive reply", () => {
  it("is interested, question or referral, and nothing else by intent", () => {
    expect([...POSITIVE_INTENTS].sort()).toEqual(["interested", "question", "referral"]);
    for (const intent of REPLY_INTENTS) expect(isPositiveReply({ intent, classification: "reply" }), intent).toBe(POSITIVE_INTENTS.includes(intent));
  });

  it("is never positive when the message is not a reply", () => {
    expect(isPositiveReply({ intent: "interested", classification: "auto_reply" })).toBe(false);
  });

  it("is a non-cancelled, attributed meeting first seen after the send", () => {
    const meeting = { status: "confirmed", attributed: true, firstSeenAt: "2026-11-03T09:00:00.000Z" };
    expect(meetingCountsAsPositive(meeting, SENT)).toBe(true);
    expect(isPositiveReply({ intent: "not_a_fit", classification: "reply", meeting, sentAt: SENT })).toBe(true);
    expect(meetingCountsAsPositive({ ...meeting, status: "cancelled" }, SENT)).toBe(false);
    expect(meetingCountsAsPositive({ ...meeting, attributed: false }, SENT)).toBe(false);
    expect(meetingCountsAsPositive({ ...meeting, firstSeenAt: "2026-10-30T09:00:00.000Z" }, SENT)).toBe(false);
    expect(meetingCountsAsPositive(meeting, null)).toBe(false);
  });

  it("takes its time from the reply or the meeting, never from the clock", () => {
    expect(positiveReplyAt({ intent: "question", classification: "reply", receivedAt: "2026-11-02T08:00:00.000Z" })).toBe("2026-11-02T08:00:00.000Z");
    expect(positiveReplyAt({ intent: "warm", classification: "reply", receivedAt: "2026-11-02T08:00:00.000Z" })).toBeNull();
    const meeting = { status: "tentative", attributed: true, firstSeenAt: "2026-11-01T12:00:00.000Z" };
    expect(positiveReplyAt({ intent: "interested", classification: "reply", receivedAt: "2026-11-02T08:00:00.000Z", meeting, sentAt: SENT })).toBe("2026-11-01T12:00:00.000Z");
  });
});

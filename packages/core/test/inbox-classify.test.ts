// GTM-agents: tests for structural classification, return-date parsing and bounce report parsing.
// Pure functions over synthetic messages; every sender is invented on a *.example domain.
import { describe, expect, it } from "vitest";
import { parseBounce } from "../src/inbox/bounce.ts";
import { classifyStructural, isBillingAlert, isOptOut, ownText, type StructuralInput } from "../src/inbox/classify.ts";
import { OOO_DEFAULT_HOLD_DAYS, outOfOfficeHoldUntil, parseReturnDate } from "../src/inbox/dates.ts";
import { parseMessageIds, pickInboundHeaders } from "../src/inbox/headers.ts";
import { htmlToText } from "../src/inbox/text.ts";

const input = (overrides: Partial<StructuralInput> = {}): StructuralInput => ({
  from: "riley@prospect.example",
  subject: "Question about Acme",
  text: "Hi Avery, how does the trial work?",
  headers: {},
  repliesToUs: false,
  ...overrides,
});
const classify = (overrides: Partial<StructuralInput> = {}) => classifyStructural(input(overrides)).classification;

describe("structural classification", () => {
  it("reads delivery reports as bounces, by sender, report type, failed-recipients header or an anchored subject with a report", () => {
    expect(classify({ from: "mailer-daemon@googlemail.example", subject: "Delivery Status Notification (Failure)" })).toBe("bounce");
    expect(classify({ from: "postmaster@prospect.example" })).toBe("bounce");
    expect(classify({ from: "relay@prospect.example", headers: { "content-type": 'multipart/report; report-type=delivery-status; boundary="x"' } })).toBe("bounce");
    expect(classify({ from: "relay@prospect.example", headers: { "x-failed-recipients": "a@prospect.example" } })).toBe("bounce");
    expect(classify({ from: "microsoftexchange329e71@prospect.example", subject: "Undeliverable: Flaky builds" })).toBe("bounce");
    expect(classify({ from: "relay@prospect.example", subject: "Undeliverable: Flaky builds", deliveryReport: "Final-Recipient: rfc822; a@prospect.example" })).toBe("bounce");
    // A person whose subject merely starts like a bounce is not one.
    expect(classify({ subject: "Undeliverable packages are our biggest cost" })).toBe("new_inquiry");
  });

  it("tells a person's out-of-office responder from machine mail", () => {
    expect(classify({ subject: "Automatic reply: Flaky builds" })).toBe("out_of_office");
    expect(classify({ subject: "Out of Office: back Monday" })).toBe("out_of_office");
    expect(classify({ subject: "Re: Flaky builds", headers: { "auto-submitted": "auto-replied" } })).toBe("out_of_office");
    expect(classify({ subject: "Re: Flaky builds", headers: { "x-autoreply": "yes" } })).toBe("out_of_office");
    expect(classify({ headers: { precedence: "auto_reply" } })).toBe("out_of_office");
    expect(classify({ headers: { "auto-submitted": "auto-generated" } })).toBe("auto_reply");
    expect(classify({ headers: { "auto-submitted": "no" } })).toBe("new_inquiry");
    expect(classify({ from: "no-reply@vendor.example" })).toBe("auto_reply");
    expect(classify({ from: "notifications@vendor.example" })).toBe("auto_reply");
    expect(classify({ subject: "Report domain: acme.example Submitter: mail.example" })).toBe("auto_reply");
  });

  it("anchors out-of-office subjects, so a real reply that mentions being away stays a reply", () => {
    expect(classify({ subject: "Re: moving away from spreadsheets" })).toBe("reply");
    expect(classify({ subject: "Re: our out of office policy question" })).toBe("reply");
  });

  it("treats bulk and list mail as machine mail unless it answers ours", () => {
    expect(classify({ headers: { precedence: "bulk" } })).toBe("auto_reply");
    expect(classify({ headers: { "list-id": "<news.prospect.example>" } })).toBe("auto_reply");
    expect(classify({ headers: { "list-id": "<eng.prospect.example>" }, repliesToUs: true })).toBe("reply");
    expect(classify({ headers: { "list-id": "<eng.prospect.example>" }, subject: "Re: Flaky builds" })).toBe("reply");
  });

  it("reads a bare opt-out as an unsubscribe, and only a bare one", () => {
    expect(classify({ subject: "unsubscribe", text: "" })).toBe("unsubscribe");
    expect(classify({ subject: "Re: Flaky builds", text: "Unsubscribe" })).toBe("unsubscribe");
    expect(classify({ subject: "Re: Flaky builds", text: "Please remove me from your list. Thanks!" })).toBe("unsubscribe");
    expect(classify({ subject: "Re: Flaky builds", text: "Stop\n\nOn Mon, Nov 2, 2026 at 9:00 AM Avery <avery@acme.example> wrote:\n> Hi Riley" })).toBe("unsubscribe");
    expect(classify({ subject: "Re: Flaky builds", text: "take me off the mailing list" })).toBe("unsubscribe");
    expect(classify({ subject: "Re: Flaky builds", text: "Please remove me from the thread, but tell me more about pricing." })).toBe("reply");
    expect(classify({ subject: "Re: Flaky builds", text: "How do I unsubscribe my team from flaky test alerts?" })).toBe("reply");
  });

  it("reads a reply by its prefix or by answering our mail, and anything else as a new inquiry", () => {
    expect(classify({ subject: "RE: Flaky builds" })).toBe("reply");
    expect(classify({ subject: "AW: Flaky builds" })).toBe("reply");
    expect(classify({ subject: "Flaky builds", repliesToUs: true })).toBe("reply");
    expect(classify({ subject: "Fwd: Flaky builds" })).toBe("new_inquiry");
    expect(classify()).toBe("new_inquiry");
  });

  it("reads a mail client's unsubscribe as one even from an automated sender or with automated headers", () => {
    expect(classify({ from: "no-reply@mailclient.example", subject: "unsubscribe", text: "" })).toBe("unsubscribe");
    expect(classify({ subject: "Unsubscribe", headers: { "auto-submitted": "auto-generated", "list-id": "<x.example>" } })).toBe("unsubscribe");
  });

  it("reads a known thread as a reply, but never lets it make bulk mail a reply", () => {
    expect(classify({ subject: "Following up", knownThread: true })).toBe("reply");
    expect(classify({ subject: "Weekly digest", headers: { precedence: "bulk" }, knownThread: true })).toBe("auto_reply");
  });

  it("trusts X-Failed-Recipients only when asked to", () => {
    expect(parseBounce({ headers: { "x-failed-recipients": "a@initech.example" }, trustFailedHeader: false }).permanent).toEqual([]);
  });

  it("applies the rules in order: a bounce beats an auto reply, an auto reply beats an opt-out", () => {
    expect(classify({ from: "mailer-daemon@prospect.example", headers: { "auto-submitted": "auto-replied" } })).toBe("bounce");
    expect(classify({ subject: "Automatic reply: unsubscribe", text: "unsubscribe" })).toBe("out_of_office");
  });

  it("flags billing failures from automated or billing senders only", () => {
    expect(isBillingAlert("payments-noreply@cloud.example", "Your payment was declined", "")).toBe(true);
    expect(isBillingAlert("billing@vendor.example", "Action needed", "We were unable to charge your card.")).toBe(true);
    expect(isBillingAlert("billing@vendor.example", "Your invoice is available", "Invoice 42 is ready.")).toBe(false);
    expect(isBillingAlert("riley@prospect.example", "Our payment failed", "")).toBe(false);
    expect(classifyStructural(input({ from: "no-reply@cloud.example", subject: "Payment failed for your workspace" }))).toMatchObject({ classification: "auto_reply", billingAlert: true });
  });

  it("finds the sender's own words above quoted history and the signature", () => {
    expect(ownText("Sounds good.\n\nOn Tue, Nov 3, 2026 at 9:00 AM Avery <avery@acme.example> wrote:\n> Hello")).toBe("Sounds good.");
    expect(ownText("Yes\n-- \nRiley")).toBe("Yes");
    expect(ownText("Fine by me\n-----Original Message-----\nFrom: Avery")).toBe("Fine by me");
    expect(isOptOut("Re: x", "unsubscribe\n\n> quoted line saying hello")).toBe(true);
  });
});

describe("out-of-office return dates", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getTime();

  it("reads named months, ISO dates and unambiguous numeric dates after a return word", () => {
    expect(parseReturnDate("I am out of office until November 20.", now)?.getTime()).toBe(day("2026-11-20"));
    expect(parseReturnDate("Back on Monday, 23rd November 2026", now)?.getTime()).toBe(day("2026-11-23"));
    expect(parseReturnDate("I will return on the 1st of December", now)?.getTime()).toBe(day("2026-12-01"));
    expect(parseReturnDate("Returning 2026-11-30", now)?.getTime()).toBe(day("2026-11-30"));
    expect(parseReturnDate("back 23/11", now)?.getTime()).toBe(day("2026-11-23"));
    expect(parseReturnDate("back 11/23/2026", now)?.getTime()).toBe(day("2026-11-23"));
    expect(parseReturnDate("back on 23.11.", now)?.getTime()).toBe(day("2026-11-23"));
    // No year: the next one on or after today, so January is next year.
    expect(parseReturnDate("Out until Jan 2", now)?.getTime()).toBe(day("2027-01-02"));
    // January 4 is 61 days out: past the limit.
    expect(parseReturnDate("Out until Jan 4", now)).toBeNull();
  });

  it("refuses ambiguous, impossible, past and far-off dates, and times", () => {
    expect(parseReturnDate("back 11/12", now)).toBeNull();
    expect(parseReturnDate("back November 31", now)).toBeNull();
    expect(parseReturnDate("back 2026-10-01", now)).toBeNull();
    expect(parseReturnDate("back on March 3", now)).toBeNull();
    expect(parseReturnDate("back at 9.30 tomorrow", now)).toBeNull();
    expect(parseReturnDate("I am on leave.", now)).toBeNull();
    expect(parseReturnDate("Our launch is November 20 and I am away.", now)).toBeNull();
  });

  it("holds until the day after the return date, or for the default when there is none", () => {
    expect(outOfOfficeHoldUntil(new Date(day("2026-11-20")), now).toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(outOfOfficeHoldUntil(null, now).getTime()).toBe(now.getTime() + OOO_DEFAULT_HOLD_DAYS * 86_400_000);
  });
});

describe("bounce reports", () => {
  it("reads permanent failures from the report and from X-Failed-Recipients", () => {
    const report = "Reporting-MTA: dns; mx.example\n\nFinal-Recipient: rfc822; Old.Contact@Initech.example\nAction: failed\nStatus: 5.1.1\n\nFinal-Recipient: rfc822;slow@initech.example\nAction: delayed\nStatus: 4.4.1\n";
    expect(parseBounce({ headers: {}, deliveryReport: report })).toEqual({ permanent: ["old.contact@initech.example"], temporary: ["slow@initech.example"] });
    expect(parseBounce({ headers: { "x-failed-recipients": "a@initech.example, Bad <b@initech.example>" }, trustFailedHeader: true }).permanent).toEqual(["a@initech.example", "b@initech.example"]);
    // Untrusted unless the caller says otherwise.
    expect(parseBounce({ headers: { "x-failed-recipients": "a@initech.example" } }).permanent).toEqual([]);
  });

  it("uses the returned message's To only when the report says it failed but names no one", () => {
    const report = "Action: failed\nStatus: 5.0.0\n\nFrom: avery@acme.example\nTo: gone@initech.example\nSubject: Hello\n";
    expect(parseBounce({ headers: {}, deliveryReport: report }).permanent).toEqual(["gone@initech.example"]);
    expect(parseBounce({ headers: {}, deliveryReport: "From: avery@acme.example\nTo: gone@initech.example\nSubject: Hello\n" }).permanent).toEqual([]);
  });

  it("returns nothing for a report it cannot parse, rather than guessing", () => {
    expect(parseBounce({ headers: {}, deliveryReport: "Hi. This is the mail program. I could not deliver to someone, somewhere." })).toEqual({ permanent: [], temporary: [] });
    expect(parseBounce({ headers: {}, deliveryReport: "Final-Recipient: x400; not-an-address\nAction: failed" })).toEqual({ permanent: [], temporary: [] });
    expect(parseBounce({ headers: { "x-failed-recipients": "not an address" } })).toEqual({ permanent: [], temporary: [] });
  });
});

describe("header and text helpers", () => {
  it("keeps only the triage headers, lowercased, first occurrence, on one line", () => {
    expect(pickInboundHeaders([["Auto-Submitted", "auto-replied"], ["AUTO-SUBMITTED", "no"], ["Received", "x"], ["List-Id", "a\r\n b"], ["X-Empty", ""]])).toEqual({ "auto-submitted": "auto-replied", "list-id": "a b" });
  });

  it("parses message ids, keeping the most recent of a long chain", () => {
    expect(parseMessageIds("<a@x.example> <b@x.example> <a@x.example>")).toEqual(["<a@x.example>", "<b@x.example>"]);
    expect(parseMessageIds("bare@x.example")).toEqual(["<bare@x.example>"]);
    expect(parseMessageIds("not an id")).toEqual([]);
    const chain = Array.from({ length: 60 }, (_, i) => `<m${i}@x.example>`).join(" ");
    expect(parseMessageIds(chain)).toHaveLength(50);
    expect(parseMessageIds(chain).at(-1)).toBe("<m59@x.example>");
  });

  it("derives text from HTML without scripts, styles or tags", () => {
    expect(htmlToText("<style>p{}</style><p>Hello&nbsp;<b>Riley</b></p><script>x()</script><div>A &amp; B &#x41;</div>")).toBe("Hello Riley\nA & B A");
  });
});

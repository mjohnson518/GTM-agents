// GTM-agents: structural classification of inbound mail. Deterministic: patterns and headers only,
// no model, no network, so it runs in the per-minute poll and gives the same answer every time.
//
// The rules run in order and the first that matches wins:
//   1. bounce: a delivery report. The sender is a mail system (mailer-daemon, postmaster), the
//      message is a multipart/report delivery status, it carries X-Failed-Recipients, or it has an
//      anchored bounce subject and either an automated sender or a delivery report.
//   2. out_of_office or auto_reply. A person's responder is out_of_office: an anchored out-of-office
//      or automatic-reply subject, Auto-Submitted: auto-replied, X-Autoreply or X-Autorespond, or
//      Precedence: auto_reply. Machine mail is auto_reply: any other Auto-Submitted value
//      (auto-generated notifications), a no-reply sender, a service subject (DMARC and TLS
//      reports), or bulk and list mail (Precedence bulk, list or junk, or a List-Id) that is not
//      answering our mail.
//   3. unsubscribe: the sender's own text, quoted history removed, is only an opt-out
//      ("unsubscribe", "stop", "remove me", "take me off your list"). A subject that is only
//      "unsubscribe" (what a mail client's List-Unsubscribe mailto sends) is checked right after
//      the bounce rule, so an automated sender's opt-out is still one;
//   4. reply: a reply prefix on the subject (Re, Aw, Sv, Antw and the like), or the message
//      answers mail (In-Reply-To or References names one of our sends or our domains, passed as
//      repliesToUs; or it joins a thread already recorded, passed as knownThread).
//   5. new_inquiry: anything else.
// Separately, a billing-failure notice (a failed charge, a declined card, a suspended account) from
// an automated or billing sender is flagged for the operator, whatever its classification.
//
// Anchoring matters: "Re: moving away from spreadsheets" is a reply, not an out-of-office, and a
// reply that says "please remove me from the thread, but tell me more" is not an opt-out.

export type StructuralClassification = "bounce" | "out_of_office" | "auto_reply" | "unsubscribe" | "reply" | "new_inquiry";

export interface StructuralInput {
  /** The sender's normalized address. */
  from: string;
  subject: string;
  /** The body, plain text. */
  text: string;
  /** Lowercase keys, as INBOUND_HEADER_NAMES. */
  headers: Readonly<Record<string, string>>;
  deliveryReport?: string;
  /** True when In-Reply-To or References names one of our sends or an id on our own domains. */
  repliesToUs: boolean;
  /** True when it references a message already recorded, or its thread already holds one. */
  knownThread?: boolean;
}

export interface StructuralResult {
  classification: StructuralClassification;
  /** A short machine reason, such as "bounce:sender" or "ooo:subject". Never untrusted text. */
  reason: string;
  billingAlert: boolean;
}

const MAIL_SYSTEM_LOCAL = /^(?:mailer-daemon|postmaster|mail-daemon|mailerdaemon)$/i;
const AUTOMATED_LOCAL = /(?:^|[._+-])(?:no-?reply|do-?not-?reply|donotreply|noreply|bounces?|notifications?|mailer)(?:[._+-]|$)/i;
const BOUNCE_SUBJECT =
  /^\s*(?:undeliverable|undelivered mail|undeliverable mail|delivery status notification \((?:failure|delay)\)|delivery (?:has )?failed|delivery failure|mail delivery (?:failed|failure|subsystem)|returned mail|failure notice|mail system error|message not delivered)\b/i;
const REPORT_TYPE = /^multipart\/report\b[\s\S]*\breport-type\s*=\s*"?delivery-status/i;

/** True when the message's own content type says it is a delivery status report. */
export function isDeliveryReport(headers: Record<string, string>): boolean {
  return REPORT_TYPE.test(headers["content-type"] ?? "");
}

const OOO_SUBJECT =
  /^\s*(?:(?:re|aw|sv|antw|fwd?|wg|tr)\s*:\s*)?(?:automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|auto:|out of (?:the )?office|ooo\b|away from (?:the |my )?(?:office|desk)|vacation (?:reply|notice|response)|on (?:annual |parental |maternity |paternity )?(?:leave|vacation|holiday)\b|i am out of (?:the )?office|i'm out of (?:the )?office|abwesenheitsnotiz|automatische antwort|risposta automatica|fuera de la oficina|absence du bureau)/i;
const SERVICE_SUBJECT = /^\s*(?:\[preview\]\s*)?(?:report domain:|dmarc aggregate report|tls report|report-id:)/i;

const REPLY_PREFIX = /^\s*(?:re|aw|sv|antw|odp|ynt|vs|rif|res)\s*(?:\[\d+\])?\s*:/i;
const UNSUBSCRIBE_SUBJECT = /^\s*(?:re\s*:\s*)?(?:unsubscribe|opt[ -]?out|remove me)\s*[.!]*\s*$/i;
const OPT_OUT_TEXT =
  /^(?:please\s+)?(?:unsubscribe(?:\s+me)?|stop(?:\s+(?:emailing|contacting|sending)(?:\s+me)?)?|remove(?:\s+me)?(?:\s+from\s+(?:your|this|the)\s+(?:mailing\s+)?(?:list|emails?))?|opt[ -]?out|take\s+me\s+off(?:\s+(?:your|the|this))?(?:\s+(?:mailing|email))?\s+list|no\s+thanks?[,.]?\s+(?:please\s+)?(?:unsubscribe|remove\s+me))[\s.,!]*(?:thanks?|thank\s+you)?[\s.,!]*$/i;

// A failed charge or a suspended account, from an automated or billing sender. An invoice that is
// simply available is not one.
const BILLING_FAILURE =
  /payment (?:(?:was|has been|is) )?(?:failed|failure|declined|unsuccessful|(?:was |could )?not (?:be )?(?:processed|completed))|(?:unable|couldn'?t|could not) (?:to )?(?:charge|process (?:your )?payment)|card (?:was |has been )?declined|past due|overdue (?:invoice|balance|payment)|(?:account|service|subscription) (?:will be |has been |is )?suspended|update (?:your )?(?:payment|billing) (?:method|details|information)|billing (?:problem|issue|failure)/i;
const BILLING_LOCAL = /(?:^|[._+-])(?:billing|payments?|invoices?|accounts?|finance)(?:[._+-]|$)/i;

const localPart = (address: string): string => {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at) : address;
};

const header = (headers: Readonly<Record<string, string>>, name: string): string => (headers[name] ?? "").trim();

/**
 * The sender's own words: the text before quoted history (an "On ... wrote:" line, an
 * "Original Message" divider, a forwarded header block or a line starting with ">") and before a
 * signature divider ("-- "). Used to read opt-outs and return dates without matching our own text
 * quoted back.
 */
export function ownText(text: string): string {
  const quoteStart =
    /^[ \t]*(?:On\s[^\n]{0,200}(?:\n[^\n]{0,200})?\swrote:\s*$|-{2,}\s*Original Message\s*-{2,}|_{5,}\s*$|From:\s[^\n]+\n(?:[^\n]*\n)?(?:Sent|Date|To):|>)/im;
  const signature = /^-- ?$/m;
  let own = text;
  const quote = quoteStart.exec(own);
  if (quote) own = own.slice(0, quote.index);
  const sig = signature.exec(own);
  if (sig) own = own.slice(0, sig.index);
  return own.trim();
}

function bounceReason(input: StructuralInput, local: string): string | null {
  if (MAIL_SYSTEM_LOCAL.test(local)) return "bounce:sender";
  if (REPORT_TYPE.test(header(input.headers, "content-type"))) return "bounce:report";
  if (header(input.headers, "x-failed-recipients")) return "bounce:failed_recipients";
  if (BOUNCE_SUBJECT.test(input.subject) && (AUTOMATED_LOCAL.test(local) || /microsoftexchange/i.test(local) || Boolean(input.deliveryReport?.trim()))) return "bounce:subject";
  return null;
}

function automatedReason(input: StructuralInput, local: string): { classification: "out_of_office" | "auto_reply"; reason: string } | null {
  const submitted = header(input.headers, "auto-submitted").toLowerCase();
  const precedence = header(input.headers, "precedence").toLowerCase();
  if (OOO_SUBJECT.test(input.subject)) return { classification: "out_of_office", reason: "ooo:subject" };
  if (submitted.startsWith("auto-replied")) return { classification: "out_of_office", reason: "ooo:auto_submitted" };
  if (header(input.headers, "x-autoreply") || header(input.headers, "x-autorespond")) return { classification: "out_of_office", reason: "ooo:x_autoreply" };
  if (precedence === "auto_reply") return { classification: "out_of_office", reason: "ooo:precedence" };
  if (submitted && submitted !== "no") return { classification: "auto_reply", reason: "auto:auto_submitted" };
  if (AUTOMATED_LOCAL.test(local)) return { classification: "auto_reply", reason: "auto:sender" };
  if (SERVICE_SUBJECT.test(input.subject)) return { classification: "auto_reply", reason: "auto:service_subject" };
  // Bulk and list mail is machine mail unless it answers ours: a person replying from a group
  // address still stops the sequence. Sharing a thread with earlier mail does not count, since a
  // mailbox can thread a newsletter with the last issue.
  const bulk = ["bulk", "list", "junk"].includes(precedence) || Boolean(header(input.headers, "list-id"));
  if (bulk && !input.repliesToUs && !REPLY_PREFIX.test(input.subject)) return { classification: "auto_reply", reason: "auto:bulk" };
  return null;
}

/** True for a billing-failure notice from an automated or billing sender. */
export function isBillingAlert(from: string, subject: string, text: string): boolean {
  const local = localPart(from);
  if (!AUTOMATED_LOCAL.test(local) && !BILLING_LOCAL.test(local)) return false;
  return BILLING_FAILURE.test(subject) || BILLING_FAILURE.test(text.slice(0, 2000));
}

/** True when the sender's own text, or the subject, is only an opt-out. */
export function isOptOut(subject: string, text: string): boolean {
  if (UNSUBSCRIBE_SUBJECT.test(subject)) return true;
  const own = ownText(text).replace(/\s+/g, " ").trim();
  return own.length > 0 && own.length <= 120 && OPT_OUT_TEXT.test(own);
}

/** Classify one inbound message. Pure. */
export function classifyStructural(input: StructuralInput): StructuralResult {
  const from = typeof input.from === "string" ? input.from.trim().toLowerCase() : "";
  const subject = typeof input.subject === "string" ? input.subject : "";
  const text = typeof input.text === "string" ? input.text : "";
  const local = localPart(from);
  const normalized: StructuralInput = { ...input, from, subject, text };
  const billingAlert = isBillingAlert(from, subject, text);

  const bounce = bounceReason(normalized, local);
  if (bounce) return { classification: "bounce", reason: bounce, billingAlert };
  // A mail client's List-Unsubscribe mailto may come from an automated sender or carry automated
  // headers; it is still an opt-out.
  if (UNSUBSCRIBE_SUBJECT.test(subject)) return { classification: "unsubscribe", reason: "unsubscribe:subject", billingAlert };
  const automated = automatedReason(normalized, local);
  if (automated) return { ...automated, billingAlert };
  if (isOptOut(subject, text)) return { classification: "unsubscribe", reason: "unsubscribe", billingAlert };
  if (REPLY_PREFIX.test(subject)) return { classification: "reply", reason: "reply:subject", billingAlert };
  if (input.repliesToUs) return { classification: "reply", reason: "reply:ours", billingAlert };
  if (input.knownThread) return { classification: "reply", reason: "reply:thread", billingAlert };
  return { classification: "new_inquiry", reason: "new_inquiry", billingAlert };
}

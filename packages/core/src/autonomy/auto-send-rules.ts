// GTM-agents: the auto-send rules for replies: one pure function that every automatic reply must
// pass, failing closed on any missing input. reply-auto-send.ts gathers the inputs and sends.
//
// The rules, all of which must pass:
//   1. the tier is on: inbound:auto_send_tier AND replies:send_enabled AND
//      quality:model_review_enabled, AND the draft's class is one with an automatic path
//      (AUTO_SEND_CLASSES) at level 2 or above. The flag alone, or the level alone, is not enough;
//   2. outreach is not halted or paused (either one unreadable counts as paused);
//   3. it is a reply, or a new inquiry from someone we emailed (cold or follow-up);
//   4. a contact is matched;
//   5. no proposed time: none from triage, none from the qualifier, and no day, date or clock time
//      in the sender's own words, subject included (a deterministic check, so a model cannot miss
//      one), and the sender's whole text was read (not a stored preview, not cut at the limit);
//   6. no request to see the product, unless the class is the earned demo-link class;
//   7. the message's headers were recorded, the sender is authenticated (the receiving mailbox's
//      Authentication-Results shows a DKIM or SPF pass aligned with the sender's domain, so a forged
//      From cannot start a send), any Reply-To is the sender, and the draft goes to the sender, who
//      is the contact;
//   8. the intent: reply_send needs interested at 0.8 or more, a booking URL and scheduling words in
//      the sender's own text; reply_demo_link needs a request to see the product, interested or a
//      question at 0.8 or more;
//   9. no risk pattern (pricing, legal, contract, compliance, cancel, unsubscribe, a competitor) in
//      the sender's subject and text or in the draft, and no injection pattern and no link in what
//      the sender wrote (their own calendar link, or a page they want acted on, goes to a person);
//  10. fact grounding: approved facts exist, the draft states no figure the facts do not hold, makes
//      no plan or offer and no customer or reference claim, and does not promise to check and come
//      back;
//  11. no link except the exact booking URL or an approved asset URL (bare hosts count as links);
//  12. a reply_send draft carries the booking link; a demo-link draft carries exactly one asset;
//  13. the content lint does not block;
//  14. the full quality gate: the deterministic gate and the model reviewer together say pass (any
//      hold, or a reviewer that could not run, fails it).
// Questions, objections, declines, anyone proposing a time, and anyone asking to see the product
// without the earned demo-link class always go to a person: their intents fail rule 8, a proposed
// time fails rule 5, and an asset request fails rule 6. reply_question is not sent automatically in
// this version; its drafts always wait for a person.
//
// Inbound text never decides alone: it can only fail rules (a risk word, a time, an injection
// pattern), and what it could push (triage's intent and confidence) is one rule among fourteen,
// next to the flags, the earned level, fact grounding, the link rules and the quality gate.
// This module needs no Worker binding, so the evals in tests/evals/ run it directly.
import { lintOutbound } from "../quality/lint.ts";
import { detectInjection } from "../security/redact.ts";
import { AUTONOMY_FLAGS } from "./flags.ts";
import type { ActionClass, AutonomyLevel } from "./levels.ts";
import { figuresIn } from "./scorers.ts";

/** The reply classes that may be sent automatically once earned. */
export const AUTO_SEND_CLASSES: readonly ActionClass[] = Object.freeze<ActionClass[]>(["reply_send", "reply_demo_link"]);
/** The triage confidence an automatic reply's intent needs. */
export const AUTO_SEND_MIN_CONFIDENCE = 0.8;

export const SEND_FLAG = "replies:send_enabled";
export const REVIEW_FLAG = "quality:model_review_enabled";

export interface AutoSendFailure {
  rule: number;
  reason: string;
}

export interface AutoSendCheck {
  ok: boolean;
  failures: AutoSendFailure[];
}

/** The slice of a quality result the last rule reads (quality/gate.ts QualityResult fits). */
export interface AutoSendQuality {
  verdict: "pass" | "hold" | "block";
  findings: ReadonlyArray<{ code: string }>;
}

export interface ReplyAutoSendInput {
  /** Each switch: true, false, or null when it could not be read. */
  switches: { tier: boolean | null; send: boolean | null; review: boolean | null };
  /** The class's level, or null when it could not be read. */
  level: AutonomyLevel | null;
  actionClass: string | null;
  /** True when outreach is halted or paused; null when that could not be read. */
  paused: boolean | null;
  message: {
    /** The structural classification inbox intake recorded. */
    classification: string | null;
    /** For a new inquiry: whether outreach (cold or a follow-up) went to this contact before. */
    emailedBefore: boolean | null;
    sender: string | null;
    /** The headers intake recorded, lowercase names; null when they could not be read. */
    headers: Readonly<Record<string, string>> | null;
    /**
     * True only when the receiving mailbox's Authentication-Results shows an aligned DKIM or SPF
     * pass for the sender's domain (sender-auth.ts). Anything else fails rule 7.
     */
    authenticated: boolean | null;
    /** The sender's own text (quoted history removed). */
    text: string | null;
    /** The message's subject, which the sender wrote too; null when there is none. */
    subject: string | null;
    /**
     * True only when `text` is the whole of the sender's own text: read from storage, not a
     * preview, and not cut at the reading limit. Anything else fails rules 5 and 9.
     */
    complete: boolean | null;
  };
  contact: { email: string | null } | null;
  triage: { intent: string; confidence: number; proposedTime: string | null; assetRequested: boolean } | null;
  qualification: { proposedTime: string | null } | null;
  draft: { to: string | null; subject: string | null; body: string | null } | null;
  links: { bookingUrl: string | null; assetUrls: readonly string[] };
  /** The approved fact lines (the brain's facts and message pillars); null when unavailable. */
  facts: readonly string[] | null;
  /** Competitor names from the brain; null when unavailable. */
  competitors: readonly string[] | null;
  /** The full quality gate's result: the deterministic gate with the model review folded in. */
  quality?: AutoSendQuality | null;
}

const SCHEDULING = /\b(?:call|calls|chat|meet|meeting|meetings|talk|speak|schedule|scheduling|book|booking|calendar|availability|available|slot|catch up|connect|demo)\b/i;

const TIME_PATTERNS: readonly RegExp[] = [
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|today|this (?:morning|afternoon|evening|week|weekend|month|quarter)|next (?:week|weekend|month|quarter)|(?:later|early|earlier) (?:this|next) (?:week|month|quarter)|(?:the )?week of|in (?:a|one|two|three|\d+) (?:days?|weeks?|months?)|end of (?:the )?(?:day|week|month|quarter))\b/i,
  /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b(?:at|around|after|before)\s+\d{1,2}\b/i,
  /\b(?:noon|midday|midnight)\b/i,
  /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i,
  /\b\d{1,2}(?:st|nd|rd|th)\b/i,
];

/** True when the text names a day, a date, a period or a clock time. Normalized first (NFKC), so full-width digits count. Pure. */
export function mentionsTime(text: string): boolean {
  const normal = text.normalize("NFKC");
  return TIME_PATTERNS.some((p) => p.test(normal));
}

const RISK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["pricing", /\b(?:price|prices|pricing|priced|cost|costs|costing|quote|quotes|quotation|budget|invoice|invoices|billing|billed|discount|discounts|fee|fees|payment|payments|license|licence|per seat|per user)\b|[$€£¥]/i],
  ["legal", /\b(?:legal|lawyer|lawyers|attorney|counsel|liability|lawsuit|litigation|indemnif\w*)\b/i],
  ["contract", /\b(?:contract|contracts|msa|nda|agreement|agreements|terms|procurement|purchase order|redline\w*)\b/i],
  ["compliance", /\b(?:compliance|compliant|soc ?2|iso ?27001|hipaa|gdpr|ccpa|dpa|security review|security questionnaire|audit|audits|pen ?test\w*|penetration test\w*)\b/i],
  ["cancel", /\b(?:cancel|cancels|cancelled|canceled|cancellation|refund|refunds|terminate|termination)\b/i],
  ["unsubscribe", /\b(?:unsubscribe|unsubscribed|opt(?:ing)?[\s-]?out|remove me|take me off|stop (?:e-?mailing|contacting|writing|sending)|do not (?:contact|e-?mail)|don't (?:contact|e-?mail)|spam)\b/i],
  ["competitor", /\b(?:competitor|competitors|competition|alternative|alternatives|versus|vs)\b/i],
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first risk pattern the text matches, or null. Competitor names are matched whole. Pure. */
export function riskIn(text: string, competitors: readonly string[]): string | null {
  for (const [label, pattern] of RISK_PATTERNS) if (pattern.test(text)) return label;
  for (const name of competitors) {
    const n = name.trim();
    if (n.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, "iu").test(text)) return "competitor";
  }
  return null;
}

const FALLBACK = /\b(?:confirm|check|verify|find out|look into)\b[^.?!\n]{0,60}\b(?:come back|get back|follow up|circle back|revert|let you know)\b|\bI(?:'ll| will) (?:check|confirm|find out|look into)\b/i;
const PLAN_TERMS = /\b(?:(?<!feel )free(?! to\b)|trials?|plans?|tiers?|seats?|subscriptions?|subscribe|upgrade[sd]?|offers?|pilots?|credits?|unlimited|discounts?|coupons?|pricing|prices?|quotes?)\b/i;
const CUSTOMER_TERMS = /\b(?:customers?|clients?|case stud(?:y|ies)|testimonials?|references?|logos?|trusted by|used by|teams like|companies like|already us(?:e|ing))\b/i;

/** Why a draft is not grounded in the approved facts, or null when it is. Fails closed with no facts. Pure. */
export function groundingProblem(body: string, facts: readonly string[] | null): string | null {
  if (!facts || facts.filter((f) => f.trim() !== "").length === 0) return "no approved facts are available";
  if (FALLBACK.test(body)) return "the draft promises to check and come back, so the facts did not cover the question";
  const plan = PLAN_TERMS.exec(body);
  if (plan) return `the draft says "${plan[0]}"; plans and offers are answered by a person`;
  const customer = CUSTOMER_TERMS.exec(body);
  if (customer) return `the draft says "${customer[0]}"; customer and reference claims are answered by a person`;
  const known = new Set(figuresIn(facts.join("\n")));
  for (const figure of figuresIn(body)) if (!known.has(figure)) return `the draft states "${figure}", which is not in the approved facts`;
  return null;
}

const LINK = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;
const BARE_HOST = /(?<![@\w./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()"']*)?(?![\w@-])/gi;
const cleanLink = (url: string) => url.replace(/[.,;:!?)\]]+$/, "");
const sameLink = (a: string, b: string) => cleanLink(a).replace(/\/+$/, "").toLowerCase() === cleanLink(b).replace(/\/+$/, "").toLowerCase();

/** Every link in a text: full URLs, www. links, and bare hosts a mail client could turn into links. Pure. */
export function linksIn(text: string): string[] {
  const urls = (text.match(LINK) ?? []).map(cleanLink);
  const bare = (text.replace(LINK, " ").match(BARE_HOST) ?? []).map(cleanLink);
  return [...urls, ...bare];
}

/**
 * One plain address, lowercased, from a bare address or "Name <address>"; null for anything else
 * (two addresses, line breaks, no @). Strict on purpose: a value it cannot read never matches.
 */
export function plainAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  const bracketed = /<([^<>]*)>\s*$/.exec(text);
  if (bracketed) {
    // eslint-disable-next-line no-control-regex -- control characters are what this rejects
    if (/[\x00-\x1f\x7f@,;<>]/.test(text.slice(0, bracketed.index).replace(/"[^"]*"/, ""))) return null;
    text = (bracketed[1] ?? "").trim();
  }
  if (!/^[^\s@<>,;"()[\]\\]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(text)) return null;
  return text.toLowerCase();
}

const same = (a: string | null | undefined, b: string | null | undefined) => {
  const x = plainAddress(a);
  return x !== null && x === plainAddress(b);
};

/** Rules 1 to 13. Pure. */
export function autoSendPrecheck(input: ReplyAutoSendInput): AutoSendCheck {
  const failures: AutoSendFailure[] = [];
  const fail = (rule: number, reason: string) => failures.push({ rule, reason });
  const actionClass = input.actionClass;
  const earned = actionClass !== null && (AUTO_SEND_CLASSES as readonly string[]).includes(actionClass);
  const text = input.message.text ?? "";
  // Everything the sender wrote: the subject as well as the body.
  const written = `${input.message.subject ?? ""}\n${text}`;
  const triage = input.triage;
  const draft = input.draft;
  const body = draft?.body ?? "";
  const subject = draft?.subject ?? "";

  // 1. The tier.
  if (input.switches.tier !== true) fail(1, `${AUTONOMY_FLAGS.replyAutoSend} is not on`);
  if (input.switches.send !== true) fail(1, `${SEND_FLAG} is not on`);
  if (input.switches.review !== true) fail(1, `${REVIEW_FLAG} is not on, so the full quality gate cannot pass`);
  if (!earned) fail(1, `${actionClass ?? "an unknown class"} is not sent automatically`);
  else if (input.level === null || input.level < 2) fail(1, `${actionClass} is at level ${input.level ?? "unknown"}; automatic replies need level 2 or above`);
  // 2. Outreach running.
  if (input.paused !== false) fail(2, input.paused === null ? "the halt and pause state could not be read" : "outreach is halted or paused");
  // 3. A reply, or an inquiry from someone we emailed.
  const classification = input.message.classification;
  if (!(classification === "reply" || (classification === "new_inquiry" && input.message.emailedBefore === true))) {
    fail(3, classification === "new_inquiry" ? "a new inquiry from someone we never emailed" : `the message is ${classification ?? "unclassified"}, not a reply`);
  }
  // 4. A matched contact.
  if (!input.contact?.email) fail(4, "no contact is matched");
  // 5. No proposed time.
  if (!triage) fail(5, "triage is missing");
  else if (triage.proposedTime) fail(5, "triage found a proposed time");
  if (input.qualification?.proposedTime) fail(5, "the qualifier found a proposed time");
  if (input.message.text === null) fail(5, "the sender's text is missing");
  else if (mentionsTime(written)) fail(5, "the sender's subject or text names a day, a date or a time");
  if (input.message.complete !== true) fail(5, "the sender's whole text could not be read, so a time in it could be missed");
  // 6. No request to see the product, unless the class is the earned demo-link class.
  if (triage?.assetRequested && actionClass !== "reply_demo_link") fail(6, "they asked to see the product, and only the demo-link class sends that");
  // 7. Reply-To is the sender, and the draft goes to them.
  if (input.message.headers === null) fail(7, "the message's headers could not be read");
  else {
    const replyTo = input.message.headers["reply-to"];
    if (replyTo !== undefined && replyTo.trim() !== "" && !same(replyTo, input.message.sender)) fail(7, "Reply-To is not the sender");
  }
  if (input.message.authenticated !== true) fail(7, "the sender is not authenticated: no aligned DKIM or SPF pass from the receiving mailbox");
  if (!same(draft?.to, input.message.sender)) fail(7, "the draft does not go to the sender");
  if (!same(input.contact?.email, input.message.sender)) fail(7, "the sender is not the contact's stored address");
  // 8. The intent.
  if (!triage) fail(8, "triage is missing");
  else if (!(triage.confidence >= AUTO_SEND_MIN_CONFIDENCE)) fail(8, `triage confidence ${triage.confidence} is under ${AUTO_SEND_MIN_CONFIDENCE}`);
  else if (actionClass === "reply_send") {
    if (triage.intent !== "interested") fail(8, `the intent is ${triage.intent}; only interest is answered automatically`);
    if (!input.links.bookingUrl) fail(8, "no booking URL is configured");
    if (!SCHEDULING.test(text)) fail(8, "the sender's own text has no scheduling words");
  } else if (actionClass === "reply_demo_link") {
    if (!triage.assetRequested) fail(8, "they did not ask to see the product");
    if (triage.intent !== "interested" && triage.intent !== "question") fail(8, `the intent is ${triage.intent}`);
  }
  // 9. Risk and injection.
  const inboundRisk = riskIn(written, input.competitors ?? []);
  if (inboundRisk) fail(9, `the sender's text mentions ${inboundRisk}`);
  const draftRisk = riskIn(`${subject}\n${body}`, input.competitors ?? []);
  if (draftRisk) fail(9, `the draft mentions ${draftRisk}`);
  if (input.competitors === null) fail(9, "the competitor list could not be read");
  if (detectInjection(written) > 0) fail(9, "the sender's subject or text carries an injection pattern");
  if (linksIn(written).length > 0) fail(9, "the sender's subject or text carries a link");
  if (input.message.complete !== true) fail(9, "the sender's whole text could not be read, so a risk in it could be missed");
  // 10. Fact grounding.
  const grounding = groundingProblem(`${subject}\n${body}`, input.facts);
  if (grounding) fail(10, grounding);
  // 11 and 12. Links.
  const links = linksIn(`${subject}\n${body}`);
  const booking = input.links.bookingUrl;
  const assets = input.links.assetUrls.filter((u) => /^https:\/\//i.test(u));
  for (const link of links) {
    const allowed = (booking !== null && sameLink(link, booking)) || assets.some((a) => sameLink(link, a));
    if (!allowed) fail(11, `a link to ${link.slice(0, 60)} is not the booking URL or an approved asset`);
  }
  if (actionClass === "reply_send" && !(booking !== null && links.some((l) => sameLink(l, booking)))) fail(12, "an interest reply carries the booking link");
  if (actionClass === "reply_demo_link") {
    const carried = new Set(links.filter((l) => assets.some((a) => sameLink(l, a))).map((l) => cleanLink(l).replace(/\/+$/, "").toLowerCase()));
    if (carried.size !== 1) fail(12, "a demo-link reply carries exactly one approved asset");
  }
  // 13. The lint.
  if (!draft || !draft.subject || !draft.body) fail(13, "the draft has no subject or body");
  else if (lintOutbound({ subject, body }).blocks.length > 0) fail(13, "the content lint blocks the draft");
  return { ok: failures.length === 0, failures };
}

/** Every rule, the full quality gate (rule 14) included. Pure. */
export function decideReplyAutoSend(input: ReplyAutoSendInput): AutoSendCheck {
  const check = autoSendPrecheck(input);
  const failures = [...check.failures];
  if (!input.quality) failures.push({ rule: 14, reason: "the full quality gate has not run" });
  else if (input.quality.verdict !== "pass") failures.push({ rule: 14, reason: `the quality gate says ${input.quality.verdict}${input.quality.findings.length ? ` (${[...new Set(input.quality.findings.map((f) => f.code))].join(", ")})` : ""}` });
  return { ok: failures.length === 0, failures };
}

/**
 * The competitor names in a brain slice: the name field of each item in its competitors block.
 * Null when the slice has no competitors block (not approved, or left out by the byte budget), so
 * rule 9 fails closed instead of checking against no names. Pure.
 */
export function competitorNames(sliceText: string): string[] | null {
  const names: string[] = [];
  let inBlock = false;
  let found = false;
  for (const line of sliceText.split("\n")) {
    const heading = /^### ([a-z-]+) \(v\d+\)$/.exec(line);
    if (heading) {
      inBlock = heading[1] === "competitors";
      found = found || inBlock;
      continue;
    }
    if (inBlock && line.startsWith("- ")) {
      const name = /(?:^|; |: )name: ([^;]+)/.exec(line)?.[1]?.trim();
      if (name) names.push(name);
    } else if (line.trim() !== "" && !line.startsWith("- ")) inBlock = false;
  }
  return found ? names : null;
}

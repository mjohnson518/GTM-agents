// GTM-agents: the claims check: every figure and claim in outbound copy must come from approved text.
//
// Approved text is whatever the deployment's own people wrote or approved: the template, the copy
// lines, the contact's and account's own fields, the config, and the brain's facts and message
// pillars. A figure ("3x", "40%", "$2,000", "twelve") or a claim term (an offer word such as "free"
// or "discount", or a reference to customers) that appears in the copy but in none of those sources
// is an unapproved claim, and the message is held for a person. A term counts as approved only when
// the same pattern finds the same term in a source, so a template's "feel free" never approves
// "it's free". URLs are removed first, so the digits in a link are never read as figures.
//
// The check is deliberately narrow and literal: it cannot judge whether a sentence is true, only
// whether its figures and claim words were approved somewhere. The model reviewer judges the rest.
//
// The same file reads the brain slice for the gate: approvedClaimLines (the approved claims) and
// voiceAvoidPhrases (the phrases the voice quotes as ones never to write).

const URL = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;

// A figure keeps its suffix, so "10x" is approved only by "10x", never by a "10" elsewhere.
const FIGURE = /[$€£¥]?\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|[kmb]\b|x\b)?/gi;

const SPELLED_QUANTITY =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|hundreds|thousand|thousands|million|millions|billion|dozen|dozens|half|double|triple|twice)\b/gi;

/** Words that make an offer, a price or a promise. Offers and pricing are decided by a person. */
const OFFER_TERM = /\b(?:(?<!feel )free(?! to\b)|trials?|discounts?|pricing|prices?|plans?|tiers?|seats?|subscriptions?|offers?|coupons?|pilots?|credits?|unlimited|guarantee[ds]?|guaranteed|risk[- ]free|refunds?)\b/gi;

/** Words that point at customers or proof. A writer may cite only the proof the operator approved. */
const CUSTOMER_TERM = /\b(?:customers?|clients?|case stud(?:y|ies)|testimonials?|logos?|trusted by|used by|teams like|companies like|already us(?:e|ing))\b/gi;

const TERM_PATTERNS: readonly RegExp[] = [OFFER_TERM, CUSTOMER_TERM];

function normalizeFigure(token: string): string {
  return token
    .toLowerCase()
    .replace(/[$€£¥,\s]/g, "")
    .replace(/percent$/, "%");
}

function prepare(text: string): string {
  return text.normalize("NFKC").replace(URL, " ");
}

function figuresIn(text: string): string[] {
  return [...(text.match(FIGURE) ?? []).map(normalizeFigure), ...(text.match(SPELLED_QUANTITY) ?? []).map((w) => w.toLowerCase())];
}

function termsIn(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((m) => m[0].toLowerCase().replace(/\s+/g, " "));
}

export type ClaimCheck = { ok: true } | { ok: false; token: string };

/**
 * Check `text` against the approved `sources`. Returns the first figure or claim term the copy
 * states that no source contains. Pure.
 */
export function checkClaims(text: string, sources: readonly string[]): ClaimCheck {
  const draft = prepare(text);
  const approved = prepare(sources.join("\n"));
  const knownFigures = new Set(figuresIn(approved));
  for (const token of figuresIn(draft)) {
    if (!knownFigures.has(token)) return { ok: false, token };
  }
  for (const pattern of TERM_PATTERNS) {
    const known = new Set(termsIn(approved, pattern));
    for (const term of termsIn(draft, pattern)) {
      if (!known.has(term)) return { ok: false, token: term };
    }
  }
  return { ok: true };
}

/**
 * The approved claims in a brain slice: the item lines of its `facts` and `message-pillars`
 * blocks. The slice header (which carries the brain version) and every other component are left
 * out, so a version hash or a persona description never approves a figure.
 */
export function approvedClaimLines(sliceText: string): string[] {
  const lines: string[] = [];
  let inClaims = false;
  for (const line of sliceText.split("\n")) {
    const heading = /^### ([a-z-]+) \(v\d+\)$/.exec(line);
    if (heading) {
      inClaims = heading[1] === "facts" || heading[1] === "message-pillars";
      continue;
    }
    if (line.startsWith("- ")) {
      if (inClaims) lines.push(line.slice(2));
      continue;
    }
    // Any other text (the header, the missing-components line) ends a block.
    if (line.trim() !== "") inClaims = false;
  }
  return lines;
}

const VOICE_ITEM_KIND = /(?:^|; )kind: (dont|avoid)(?:;|$)/;
const QUOTED = /"([^"\n]+)"|“([^”\n]+)”/g;
const PHRASE_WORDS = { min: 2, max: 6 };

/**
 * The phrases the brain's voice says never to write: from the `voice` block of a slice, items of
 * kind `dont` or `avoid`, only the text inside double quotes, two to six words each. Prose without
 * quotes yields nothing, so a phrase is never guessed from a sentence. Trailing punctuation inside
 * the quotes is dropped; duplicates (ignoring case) are listed once. Pure.
 */
export function voiceAvoidPhrases(sliceText: string): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  let inVoice = false;
  for (const line of sliceText.normalize("NFKC").split("\n")) {
    const heading = /^### ([a-z-]+) \(v\d+\)$/.exec(line);
    if (heading) {
      inVoice = heading[1] === "voice";
      continue;
    }
    if (line.startsWith("- ")) {
      if (!inVoice) continue;
      const item = line.slice(2);
      const fields = item.slice(item.indexOf(": ") + 2);
      if (!VOICE_ITEM_KIND.test(fields)) continue;
      for (const match of fields.matchAll(QUOTED)) {
        const phrase = (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "").trim();
        const count = phrase === "" ? 0 : phrase.split(" ").length;
        if (count < PHRASE_WORDS.min || count > PHRASE_WORDS.max) continue;
        const key = phrase.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        phrases.push(phrase);
      }
      continue;
    }
    if (line.trim() !== "") inVoice = false;
  }
  return phrases;
}

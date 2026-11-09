// GTM-agents: the deterministic scorers the outbound writer evals use (tests/evals/writers.eval.ts).
//
// Each scores one rendered message against what it was written from:
//   - no house-rule character (an em or an en dash), anywhere;
//   - the content lint passes (no blocks: hidden characters, placeholders, shorteners, HTML);
//   - no number absent from the inputs: every figure (digits with their currency, percent or
//     suffix, and spelled-out quantities) in the subject or body appears in one of the texts the
//     writer was given. Links are removed first, so the digits in a URL are never read as figures;
//   - length bounds, in words.
// They are pure and need no network or model, so a writer's eval is hermetic.
import { lintOutbound } from "../quality/lint.ts";
import { countWords } from "../templates/variables.ts";

const URL = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;
const FIGURE = /[$€£¥]?\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|[kmb]\b|x\b)?/gi;
const SPELLED =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|hundreds|thousand|thousands|million|millions|billion|dozen|dozens|half|double|triple|twice)\b/gi;
const HOUSE_RULE = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

const normalizeFigure = (token: string) =>
  token
    .toLowerCase()
    .replace(/[$€£¥,\s]/g, "")
    .replace(/percent$/, "%");

/** Every figure in a text, links removed, normalized for comparison. Pure. */
export function figuresIn(text: string): string[] {
  const plain = text.normalize("NFKC").replace(URL, " ");
  return [...(plain.match(FIGURE) ?? []).map(normalizeFigure), ...(plain.match(SPELLED) ?? []).map((w) => w.toLowerCase())];
}

export interface ScoreInput {
  subject: string;
  body: string;
  /** Every text the writer was given: the template, the facts, the contact's own fields, the config. */
  inputs: readonly string[];
  /** Word bounds for the body. */
  words: { min: number; max: number };
}

export interface ScoreResult {
  pass: boolean;
  failures: string[];
}

/** Score one message. Pure. */
export function scoreOutboundText(input: ScoreInput): ScoreResult {
  const failures: string[] = [];
  const all = `${input.subject}\n${input.body}`;
  if (HOUSE_RULE.test(all)) failures.push("house_rule_character: an em or en dash");
  const lint = lintOutbound({ subject: input.subject, body: input.body });
  for (const block of lint.blocks) failures.push(`lint: ${block.code} (${block.detail})`);
  const known = new Set(figuresIn(input.inputs.join("\n")));
  for (const figure of new Set(figuresIn(all))) if (!known.has(figure)) failures.push(`new_number: "${figure}" is in none of the inputs`);
  const words = countWords(input.body);
  if (words < input.words.min || words > input.words.max) failures.push(`length: ${words} words, outside ${input.words.min} to ${input.words.max}`);
  return { pass: failures.length === 0, failures };
}

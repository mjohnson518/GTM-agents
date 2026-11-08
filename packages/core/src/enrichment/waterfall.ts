// GTM-agents: the email waterfall: finders in order until one returns a usable work address.
//
// Steps, in order, each recorded as tried so it is never repeated for the candidate:
//   1. an address the people provider already returned for this person, when it screens clean;
//   2. the first configured finder;
//   3. every further finder, only while discovery:email_waterfall_enabled is on.
// A step's address is used only when it screens clean: exactly one address, at the candidate's own
// account domain, not a personal mailbox, a shared host or a role mailbox. A personal address is
// dropped on the spot and never stored. A provider error stops every later step from that provider
// for the rest of the run. Each finder call is a paid call: the spend gate is asked first and the
// cost recorded after. The address found is a lead, not an output: core verifies it next.
import { AdapterError, type Evidence } from "../ports/types.ts";
import type { ContactFinder } from "../ports/contact.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { screenAddress, type AddressVerdict } from "../sourcing/identity.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { cleanProviderUrl } from "../sourcing/text.ts";

export interface WaterfallStep {
  step: string;
  outcome: "found" | "not_found" | AddressVerdict | "error" | "skipped";
  detail?: string;
}

export interface FoundEmail {
  email: string;
  provider: string;
  /** 0 to 100, when the provider gave one. */
  confidence: number | null;
  sourceUrl: string | null;
}

export interface WaterfallInput {
  firstName: string | null;
  lastName: string | null;
  account: string;
  profileUrl?: string | null;
  /** An address a people provider already returned for this person, unverified. */
  provided?: { email: string; provider: string; confidence?: number | null; sourceUrl?: string | null } | null;
  /** Steps tried on earlier runs; never repeated. */
  tried: readonly string[];
}

export interface WaterfallOptions {
  finders: readonly ContactFinder[];
  /** Run finders after the first one. */
  waterfallEnabled: boolean;
  gate: SpendGate;
  /** Providers that failed earlier in this run; shared across candidates, and updated here. */
  disabled: Set<string>;
  log?: JobLogger;
}

export interface WaterfallResult {
  found: FoundEmail | null;
  steps: WaterfallStep[];
  /** True when the budget stopped the waterfall before every step had run. */
  budgetStopped: boolean;
}

const clampConfidence = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null);

function firstSource(sources: readonly Evidence[] | undefined): string | null {
  for (const source of sources ?? []) {
    const url = cleanProviderUrl(source.url);
    if (url) return url;
  }
  return null;
}

export async function runEmailWaterfall(input: WaterfallInput, options: WaterfallOptions): Promise<WaterfallResult> {
  const steps: WaterfallStep[] = [];
  const tried = new Set(input.tried);

  if (input.provided && !tried.has(`provided:${input.provided.provider}`)) {
    const step = `provided:${input.provided.provider}`;
    const screen = screenAddress(input.provided.email, input.account);
    steps.push({ step, outcome: screen.verdict === "clean" ? "found" : screen.verdict });
    if (screen.verdict === "clean" && screen.email) {
      return {
        found: { email: screen.email, provider: input.provided.provider, confidence: clampConfidence(input.provided.confidence), sourceUrl: cleanProviderUrl(input.provided.sourceUrl) },
        steps,
        budgetStopped: false,
      };
    }
  }

  for (const [index, finder] of options.finders.entries()) {
    const step = `finder:${finder.name}`;
    if (tried.has(step)) continue;
    if (index > 0 && !options.waterfallEnabled) break;
    if (options.disabled.has(finder.name)) {
      steps.push({ step, outcome: "skipped", detail: "the provider failed earlier in this run" });
      continue;
    }
    if (!input.firstName || !input.lastName) {
      steps.push({ step, outcome: "skipped", detail: "a finder needs a first and a last name" });
      break;
    }
    if (!(await options.gate.allow())) return { found: null, steps, budgetStopped: true };
    let result: Awaited<ReturnType<ContactFinder["findWorkEmail"]>>;
    try {
      result = await finder.findWorkEmail({
        firstName: input.firstName,
        lastName: input.lastName,
        domain: input.account,
        ...(input.profileUrl ? { profileUrl: input.profileUrl } : {}),
      });
    } catch (error) {
      options.disabled.add(finder.name);
      options.log?.warn("finder failed; its later steps are skipped this run", { provider: finder.name, error: sanitizeErrorMessage(error) });
      steps.push({ step, outcome: "error", detail: error instanceof AdapterError ? error.code : "unknown" });
      continue;
    }
    await options.gate.record(result.cost, { provider: finder.name, capability: "email_find" });
    if (result.email === null) {
      steps.push({ step, outcome: "not_found" });
      continue;
    }
    const screen = screenAddress(result.email, input.account);
    steps.push({ step, outcome: screen.verdict === "clean" ? "found" : screen.verdict });
    if (screen.verdict === "clean" && screen.email) {
      return {
        found: { email: screen.email, provider: finder.name, confidence: clampConfidence(result.confidence), sourceUrl: firstSource(result.sources) },
        steps,
        budgetStopped: false,
      };
    }
  }
  return { found: null, steps, budgetStopped: false };
}

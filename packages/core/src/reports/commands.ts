// GTM-agents: the report commands in the operator chat. They read and never reach the model.
//
//   /scorecard                          the daily scorecard, as of now
//   /report conversion [dimension]      the conversion report; a dimension (template, subject,
//                                       cohort, segment, persona) shows that one in full
//   /report funnel                      the weekly funnel digest, as of now
//   /report cost                        spend per job since the previous report
//   /report holdout                     holdout lift
//
// Each reads the same metric functions and windows as the scheduled reports, so a command run on
// the day of a report shows the same numbers. They change nothing and need no flag beyond the
// operator agent itself; the chat consumer runs each once per message.
import type { FlagReader } from "../jobs/registry.ts";
import { isOutcomeDimension, OUTCOME_DIMENSIONS } from "../metrics/index.ts";
import { conversionWindow, loadConversionReport, renderConversionReport } from "./conversion.ts";
import { loadCostDigest, renderCostDigest } from "./cost.ts";
import { loadFunnelDigest, renderFunnelDigest } from "./funnel.ts";
import { loadHoldoutReport, renderHoldoutReport } from "./holdout.ts";
import { loadScorecard, renderScorecard } from "./scorecard.ts";

export const REPORT_COMMAND_NAMES = ["scorecard", "report"] as const;

export const REPORT_HELP_LINES: readonly string[] = Object.freeze([
  "/scorecard  the daily scorecard, as of now",
  `/report conversion [${OUTCOME_DIMENSIONS.join("|")}]  what the last 30 days of first touches earned`,
  "/report funnel | cost | holdout  the funnel digest, spend per job, or holdout lift",
]);

export function isReportCommand(name: string): boolean {
  return (REPORT_COMMAND_NAMES as readonly string[]).includes(name);
}

export interface ReportCommandDeps {
  db: D1Database;
  flags: FlagReader;
  now?: () => Date;
}

const usage = () => ["Reports:", ...REPORT_HELP_LINES].join("\n");

/** Run a report command and return the reply text. Throws on a database error; the caller reports it. */
export async function runReportCommand(deps: ReportCommandDeps, command: { name: string; args: string }): Promise<string> {
  const now = deps.now?.() ?? new Date();
  if (command.name === "scorecard") return renderScorecard(await loadScorecard(deps.db, deps.flags, now));
  if (command.name !== "report") return usage();
  const [kind = "", arg, ...rest] = command.args.toLowerCase().split(/\s+/).filter(Boolean);
  if (rest.length > 0) return usage();
  switch (kind) {
    case "conversion": {
      if (arg !== undefined && !isOutcomeDimension(arg)) return `Unknown dimension. Choose one of: ${OUTCOME_DIMENSIONS.join(", ")}.`;
      return renderConversionReport(await loadConversionReport(deps.db, conversionWindow(now), now, arg));
    }
    case "funnel":
      return arg === undefined ? renderFunnelDigest(await loadFunnelDigest(deps.db, now)) : usage();
    case "cost":
      return arg === undefined ? renderCostDigest(await loadCostDigest(deps.db, now)) : usage();
    case "holdout":
      return arg === undefined ? renderHoldoutReport(await loadHoldoutReport(deps.db, now)) : usage();
    default:
      return usage();
  }
}

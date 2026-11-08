// GTM-agents: the budget module's public surface: the cost ledger and the budget gate.
export { MICRO_CENTS_PER_CENT, microCentsToCents, recordCost, tokenCostMicroCents } from "./cost-ledger.ts";
export type { CostEvent, ModelPrice, TokenUsage } from "./cost-ledger.ts";
export {
  BUDGET_DEFAULTS,
  BUDGET_KEYS,
  BudgetReadError,
  RUN_CEILING_ABORT_FACTOR,
  checkBudget,
  checkRunCeiling,
  checkTurnCeiling,
  jobCapKey,
  readBudgetSettings,
  runSpendState,
  spentMicroCents,
} from "./gate.ts";
export type { BudgetBlockReason, BudgetCheckInput, BudgetDecision, BudgetSettings, RunSpendState, SpendFilter } from "./gate.ts";

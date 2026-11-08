// GTM-agents: the security class of every tool that core ships.
//
// Each tool declares two things, and the action gate reads nothing else:
//   taint  what its output does to the session (the taint the session holds after the call)
//   gate   the lowest session taint at which the tool is refused ("never" for read-only tools)
// Because a gate is a threshold, a tool refused at one taint level is refused at every higher one,
// so gates never loosen as taint rises. Optional fields:
//   egress        "url" if the tool fetches a URL it is given, "query" if it sends free text to a
//                 search service; once anything untrusted has been read, inputs that carry data out are refused
//   humanOnly     runs only with an operator approval bound to the digest of its exact input
//   rateCategory  the rate-limit bucket the call counts against
//   delegates     the tool runs another agent and reports that agent's final taint back
//
// A tool that is not declared here or in an adapter manifest is unknown, and an unknown tool is
// treated as UNKNOWN_TOOL_CLASS: fully tainted, refused once anything untrusted has been read.
// docs/SECURITY-MODEL.md explains how to choose a class for a new tool.
import type { PermanentHumanClass } from "../autonomy/levels.ts";
import type { GateLevel, TaintLevel } from "./taint.ts";

export interface ToolClass {
  readonly taint: TaintLevel;
  readonly gate: GateLevel;
  readonly egress?: "url" | "query";
  readonly humanOnly?: boolean;
  readonly rateCategory?: string;
  readonly delegates?: boolean;
}

export const UNKNOWN_TOOL_CLASS: ToolClass = Object.freeze({ taint: "full", gate: "metadata" });

function deepFreeze<T extends Record<string, ToolClass>>(classes: T): Readonly<T> {
  for (const cls of Object.values(classes)) Object.freeze(cls);
  return Object.freeze(classes);
}

export const CORE_TOOL_CLASSES: Readonly<Record<string, ToolClass>> = deepFreeze({
  // Readers of raw untrusted text. Reading is allowed at any taint; the session becomes fully
  // tainted, which then refuses every send, write and spend that follows.
  web_fetch: { taint: "full", gate: "never", egress: "url", rateCategory: "web" },
  web_extract: { taint: "full", gate: "never", egress: "url", rateCategory: "web" },
  web_research: { taint: "full", gate: "never", egress: "query", rateCategory: "web" },
  mail_read: { taint: "full", gate: "never", rateCategory: "mail" },
  inbound_get: { taint: "full", gate: "never" },
  doc_read: { taint: "full", gate: "never" },
  product_feedback_list: { taint: "full", gate: "never" },

  // Readers of short third-party text: subjects, snippets, listings and provider lookups.
  mail_list: { taint: "metadata", gate: "never", rateCategory: "mail" },
  web_search: { taint: "metadata", gate: "never", egress: "query", rateCategory: "search" },
  web_map: { taint: "metadata", gate: "never", egress: "url", rateCategory: "web" },
  web_find_similar: { taint: "metadata", gate: "never", egress: "url", rateCategory: "search" },
  company_search: { taint: "metadata", gate: "never", egress: "query", rateCategory: "search" },
  people_search: { taint: "metadata", gate: "never", egress: "query", rateCategory: "enrichment" },
  email_find: { taint: "metadata", gate: "never", rateCategory: "enrichment" },
  inbound_list: { taint: "metadata", gate: "never" },
  inbound_triage: { taint: "metadata", gate: "never" },
  memory_recall: { taint: "metadata", gate: "never" },
  doc_search: { taint: "metadata", gate: "never" },
  ci_run_get: { taint: "metadata", gate: "never" },

  // The structured extractor: reads a page itself and returns only short validated values.
  extract_structured: { taint: "structured", gate: "never", egress: "url", rateCategory: "web" },

  // Reads of records that can hold third-party text: a tainted session may write contacts, deals,
  // drafts and tasks, so reading them back is reading third-party text, not clean data.
  contacts_search: { taint: "metadata", gate: "never" },
  contacts_get: { taint: "metadata", gate: "never" },
  deals_list: { taint: "metadata", gate: "never" },
  drafts_list: { taint: "metadata", gate: "never" },
  task_list: { taint: "metadata", gate: "never" },
  task_get: { taint: "metadata", gate: "never" },

  // Reads of the deployment's own data: operator-written content, counts and status.
  contacts_stats: { taint: "none", gate: "never" },
  templates_list: { taint: "none", gate: "never" },
  campaigns_list: { taint: "none", gate: "never" },
  experiments_list: { taint: "none", gate: "never" },
  outreach_status: { taint: "none", gate: "never" },
  suppression_check: { taint: "none", gate: "never" },
  send_rate_status: { taint: "none", gate: "never" },
  email_verify: { taint: "none", gate: "never", rateCategory: "enrichment" },
  funnel_summary: { taint: "none", gate: "never" },
  scorecard_get: { taint: "none", gate: "never" },
  system_health: { taint: "none", gate: "never" },
  repo_read: { taint: "none", gate: "never" },

  // Records that a session holding extracted values may still write: contacts, open deals and
  // unsent drafts. Refused only at full taint.
  contacts_create: { taint: "none", gate: "full" },
  contacts_bulk_create: { taint: "none", gate: "full" },
  contacts_update: { taint: "none", gate: "full" },
  contacts_log_outreach: { taint: "none", gate: "full" },
  deals_create: { taint: "none", gate: "full" },
  deals_update: { taint: "none", gate: "full" },
  drafts_create: { taint: "none", gate: "full" },
  followup_draft: { taint: "none", gate: "full" },
  objection_draft: { taint: "none", gate: "full" },
  suppression_add: { taint: "none", gate: "full" },

  // Outward actions and durable shared state: sends, approvals, launches, queue control,
  // documents, workflows. Refused at structured taint and above.
  email_send: { taint: "none", gate: "structured", rateCategory: "esp" },
  drafts_update: { taint: "none", gate: "structured" },
  drafts_bulk_approve: { taint: "none", gate: "structured" },
  drafts_bulk_create: { taint: "none", gate: "structured" },
  templates_save: { taint: "none", gate: "structured" },
  campaigns_create: { taint: "none", gate: "structured" },
  campaigns_manage: { taint: "none", gate: "structured" },
  campaign_launch: { taint: "none", gate: "structured" },
  sequence_start: { taint: "none", gate: "structured" },
  deals_transition: { taint: "none", gate: "structured" },
  outreach_pause: { taint: "none", gate: "structured" },
  outreach_resume: { taint: "none", gate: "structured" },
  deferred_sends_replay: { taint: "none", gate: "structured" },
  deferred_sends_cancel: { taint: "none", gate: "structured" },
  referrals_run: { taint: "none", gate: "structured" },
  signal_record: { taint: "none", gate: "structured" },
  monitor_create: { taint: "none", gate: "structured" },
  monitor_hits_process: { taint: "none", gate: "structured" },
  task_create: { taint: "none", gate: "structured" },
  doc_create: { taint: "none", gate: "structured" },
  doc_write: { taint: "none", gate: "structured" },
  ci_trigger: { taint: "none", gate: "structured", rateCategory: "git_write" },
  code_mode_execute: { taint: "metadata", gate: "structured", rateCategory: "code_mode" },

  // Writes that later sessions load (memory, code, the link-intake queue, win and loss records),
  // and code execution. Refused once anything untrusted has been read.
  memory_store: { taint: "none", gate: "metadata" },
  deal_outcome: { taint: "none", gate: "metadata" },
  code_execute: { taint: "metadata", gate: "metadata", rateCategory: "sandbox" },
  code_result_store: { taint: "none", gate: "metadata" },
  repo_branch_create: { taint: "none", gate: "metadata", rateCategory: "git_write" },
  repo_file_write: { taint: "none", gate: "metadata", rateCategory: "git_write" },
  repo_pr_create: { taint: "none", gate: "metadata", rateCategory: "git_write" },
  link_enqueue: { taint: "none", gate: "metadata" },
  link_review: { taint: "none", gate: "metadata" },

  // Permanently human actions: they run only with an operator approval of their exact input.
  repo_pr_merge: { taint: "none", gate: "metadata", humanOnly: true },
  contact_erase: { taint: "none", gate: "metadata", humanOnly: true },
  checkout_create: { taint: "none", gate: "structured", humanOnly: true, rateCategory: "billing" },

  // Delegation. The worker starts at the caller's taint, and its final taint comes back with the
  // result, so a tainted caller cannot act through a clean worker.
  delegate_to_executor: { taint: "none", gate: "never", delegates: true },
  delegate_to_ops: { taint: "none", gate: "never", delegates: true },
  delegate_to_sender: { taint: "none", gate: "never", delegates: true },
  delegate_to_coder: { taint: "none", gate: "never", delegates: true },
  re_delegate: { taint: "none", gate: "never", delegates: true },
});

/**
 * Tools that perform a permanently human action class (autonomy/levels.ts). Whoever declares one of
 * these names, core or an adapter, must declare it humanOnly; the registry refuses to start
 * otherwise, so no configuration can make them autonomous.
 */
export const PERMANENT_HUMAN_TOOLS: Readonly<Record<string, PermanentHumanClass>> = Object.freeze({
  repo_pr_merge: "merge_code",
  contact_erase: "data_deletion",
  checkout_create: "pricing_billing_auth",
});

// GTM-agents: the ship loop's operator chat commands, as module commands (ModuleCommand from
// @gtm-agents/core/operator). They never reach the model: the chat consumer matches them after the
// allowlist and every built-in command, and runs each once per message.
//
//   ship-themes                     the live themes, highest score first
//   ship-spec-<id>                  one theme, its demand and its spec, with the command that
//                                   approves exactly that spec
//   ship-approve-<id> <code>        approve the spec whose digest the code is taken from; the same
//                                   command starts a build that did not start
//   ship-decline-<id> [reason]      decline a theme that is open or has a spec waiting
//   ship-note-approve-<id> <code>   send a drafted "you asked, it is live" note, bound to its digest
//   ship-note-decline-<id>          drop it
// Without a code, an approve command only shows what an approval would cover. Every command
// refuses while modules.ship is off in gtm.config.ts or ship:enabled is off or unreadable.
import type { Env } from "@gtm-agents/core";
import { kvFlagReader } from "@gtm-agents/core";
import type { GtmConfig } from "@gtm-agents/core/config";
import type { JobLogger } from "@gtm-agents/core/jobs";
import type { ModuleCommand, ModuleCommandContext, ModuleCommandHandler } from "@gtm-agents/core/operator";
import type { SendOutreach } from "@gtm-agents/core/sending";
import { approveSpec, declineSpec, markEdited, reviewText } from "./approval.ts";
import type { StartShipBuild } from "./contract.ts";
import { runNoteCommand } from "./notes.ts";
import { SHIP_FLAGS, shipFlagOn } from "./planning-flags.ts";
import { LIVE_THEME_SQL, dollars, oneLine, tryBuild } from "./planning-shared.ts";
import { parseStoredSpec, renderSpec, specDigest } from "./spec.ts";

export type ShipCommand =
  | { kind: "themes" }
  | { kind: "spec"; id: string }
  | { kind: "approve"; id: string; code: string | null }
  | { kind: "decline"; id: string; reason: string }
  | { kind: "note_approve"; id: string; code: string | null }
  | { kind: "note_decline"; id: string };

const BOT = "(?:@[A-Za-z0-9_]{1,64})?";
const ID = "([0-9a-f]{10})";
const CODE = "([0-9a-f]{32,64})";
const THEMES = new RegExp(`^/?ship[-_]themes${BOT}$`, "i");
const SPEC = new RegExp(`^/?ship[-_]spec[-_]${ID}${BOT}$`, "i");
const APPROVE = new RegExp(`^/?ship[-_]approve[-_]${ID}${BOT}(?:(?:\\s+|[-_])${CODE})?$`, "i");
const DECLINE = new RegExp(`^/?ship[-_]decline[-_]${ID}${BOT}(?:\\s+([\\s\\S]{0,300}))?$`, "i");
const NOTE_APPROVE = new RegExp(`^/?ship[-_]note[-_]approve[-_]${ID}${BOT}(?:(?:\\s+|[-_])${CODE})?$`, "i");
const NOTE_DECLINE = new RegExp(`^/?ship[-_]note[-_]decline[-_]${ID}${BOT}$`, "i");

/** The ship command in a message, or null. Matches the exact command word, never a substring. Pure. */
export function parseShipCommand(text: string): ShipCommand | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length > 400) return null;
  let m: RegExpExecArray | null;
  if (THEMES.test(t)) return { kind: "themes" };
  if ((m = SPEC.exec(t))) return { kind: "spec", id: (m[1] ?? "").toLowerCase() };
  if ((m = APPROVE.exec(t))) return { kind: "approve", id: (m[1] ?? "").toLowerCase(), code: m[2] ? m[2].toLowerCase() : null };
  if ((m = DECLINE.exec(t))) return { kind: "decline", id: (m[1] ?? "").toLowerCase(), reason: (m[2] ?? "").trim() };
  if ((m = NOTE_APPROVE.exec(t))) return { kind: "note_approve", id: (m[1] ?? "").toLowerCase(), code: m[2] ? m[2].toLowerCase() : null };
  if ((m = NOTE_DECLINE.exec(t))) return { kind: "note_decline", id: (m[1] ?? "").toLowerCase() };
  return null;
}

export const SHIP_HELP_LINES: readonly string[] = Object.freeze([
  "ship-themes  the ship loop's live themes, highest score first",
  "ship-spec-<id>  a theme, its demand and its spec, with the command that approves exactly that spec",
  "ship-approve-<id> <code> / ship-decline-<id> [reason]  approve a spec you were shown (a build starts and comes back as a pull request) or decline the theme",
  "ship-note-approve-<id> <code> / ship-note-decline-<id>  send or drop a \"you asked, it is live\" note (it is checked again before it is sent)",
]);

export interface ShipCommandDeps<E extends Env> {
  config: Pick<GtmConfig, "autonomy" | "modules">;
  startBuild: StartShipBuild<E>;
  send?: ((env: E) => SendOutreach | undefined) | undefined;
  baseBranch: string;
  repo: string;
  log: JobLogger;
}

interface ThemeListRow {
  id: string;
  title: string;
  status: string;
  priority_score: number;
  demand_count: number;
  paying_requesters: number;
  spec_risk: string | null;
}

async function listThemes(db: D1Database, repo: string): Promise<string> {
  const { results } = await db
    .prepare(`SELECT id, title, status, priority_score, demand_count, paying_requesters, spec_risk FROM themes WHERE repo = ?1 AND status IN (${LIVE_THEME_SQL}) ORDER BY priority_score DESC, created_at ASC LIMIT 15`)
    .bind(repo)
    .all<ThemeListRow>();
  if (results.length === 0) return "No live ship themes yet. Themes appear once product feedback has been triaged (ship:themes_enabled).";
  return [
    `Live ship themes for ${repo}, highest score first:`,
    ...results.map(
      (t) =>
        `${t.id}  score ${Number(t.priority_score)}  ${t.status}${t.spec_risk ? ` (${t.spec_risk} risk)` : ""}  ${oneLine(t.title, 90)}  [${Number(t.demand_count)} requester(s), ${Number(t.paying_requesters)} paying]`,
    ),
    "",
    "Show one with ship-spec-<id>.",
  ].join("\n");
}

async function showTheme(db: D1Database, id: string): Promise<string> {
  const t = await db
    .prepare(
      "SELECT id, title, status, category, affected_area, priority_score, demand_count, paying_requesters, requester_mrr_cents, max_priority, spec, spec_digest, declined_reason FROM themes WHERE id = ?1",
    )
    .bind(id)
    .first<{
      id: string;
      title: string;
      status: string;
      category: string;
      affected_area: string | null;
      priority_score: number;
      demand_count: number;
      paying_requesters: number;
      requester_mrr_cents: number;
      max_priority: string | null;
      spec: string | null;
      spec_digest: string | null;
      declined_reason: string | null;
    }>();
  if (!t) return `There is no theme ${id}.`;
  const { results: summaries } = await db
    .prepare("SELECT DISTINCT triage_summary FROM feedback_items WHERE theme_id = ?1 AND triage_summary IS NOT NULL ORDER BY created_at DESC LIMIT 5")
    .bind(t.id)
    .all<{ triage_summary: string }>();
  const lead = [
    `Theme ${t.id}: ${oneLine(t.title, 120)} (${t.status}${t.declined_reason ? `: ${oneLine(t.declined_reason, 160)}` : ""})`,
    `Score ${Number(t.priority_score)}: ${Number(t.demand_count)} requester(s), ${Number(t.paying_requesters)} paying, requester MRR ${dollars(Number(t.requester_mrr_cents))}, highest priority ${t.max_priority ?? "unknown"}; ${t.category}${t.affected_area ? `, ${t.affected_area}` : ""}.`,
    ...(summaries.length ? ["Requests (triage summaries):", ...summaries.map((s) => `- ${oneLine(s.triage_summary, 240)}`)] : []),
  ];
  const spec = parseStoredSpec(t.spec);
  if (!t.spec) return [...lead, "", "No spec yet. One is written once the score reaches the threshold (ship:specs_enabled)."].join("\n");
  if (!spec) return [...lead, "", "The stored spec cannot be read, so it cannot be approved."].join("\n");
  const digest = await specDigest(t.id, spec);
  if (t.status !== "spec_ready") return [...lead, "", renderSpec(spec)].join("\n");
  if (digest !== t.spec_digest) {
    await markEdited(db, t.id, digest, t.spec, new Date());
    lead.push("The spec changed after it was written, so it is back in review under a new code.");
  }
  return reviewText(t.id, spec, digest, lead);
}

/** The ship module's chat commands for createWorker's `commands`. */
export function createShipCommands<E extends Env>(deps: ShipCommandDeps<E>): ModuleCommand<E> {
  const run = (command: ShipCommand): ModuleCommandHandler<E> => async (ctx: ModuleCommandContext<E>) => {
    if (!deps.config.modules.ship.enabled) return "The ship module is turned off for this deployment (modules.ship.enabled in gtm.config.ts), so nothing was done.";
    const db = ctx.env.DB;
    const flags = kvFlagReader(ctx.env.KV);
    if (!(await shipFlagOn(flags, SHIP_FLAGS.enabled))) return `The ship loop is off (${SHIP_FLAGS.enabled}), so nothing was done.`;
    switch (command.kind) {
      case "themes":
        return listThemes(db, deps.repo);
      case "spec":
        return showTheme(db, command.id);
      case "approve":
        return (
          await approveSpec(
            { env: ctx.env, db, flags, config: deps.config, startBuild: deps.startBuild, baseBranch: deps.baseBranch, now: ctx.now, log: deps.log },
            command.id,
            { actor: ctx.actor, code: command.code },
          )
        ).message;
      case "decline":
        return (await declineSpec(db, command.id, { actor: ctx.actor, reason: command.reason, now: ctx.now, flags })).message;
      case "note_approve":
      case "note_decline":
        return runNoteCommand(
          { db, flags, send: tryBuild(deps.send, ctx.env), now: ctx.now, log: deps.log },
          command.kind === "note_approve" ? { action: "approve", id: command.id, code: command.code } : { action: "decline", id: command.id },
          ctx.actor,
        );
    }
  };
  return {
    module: "ship",
    helpLines: SHIP_HELP_LINES,
    match(text) {
      try {
        const command = parseShipCommand(text);
        return command ? run(command) : null;
      } catch {
        return null;
      }
    },
  };
}

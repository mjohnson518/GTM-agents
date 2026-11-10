// GTM-agents: AnnounceShipped (contract.ts), called by the build side once a production deploy
// carries a task's merge commit.
//
// In order, for the task's theme (re-read from the database by the task id; nothing else is taken
// from the caller):
//   1. the theme is marked shipped, and its feedback items with it. Idempotent: a theme already
//      shipped keeps its first shipped_at;
//   2. with ship:notes_enabled on, the "you asked, it is live" notes are drafted, or sent at an
//      earned level (notes.ts). One row per requester is the claim, so a second call drafts nothing
//      new;
//   3. the operator is paged once per theme (claimed in the effects ledger) with what happened.
// Gates fail closed and bookkeeping fails open, and nothing here ever fails the caller: every
// error is logged and dropped. The webhook that called it answers as if it succeeded.
import type { Env } from "@gtm-agents/core";
import type { GtmConfig } from "@gtm-agents/core/config";
import { claimEffect, releaseEffect } from "@gtm-agents/core/events";
import type { FlagReader, JobLogger } from "@gtm-agents/core/jobs";
import type { OperatorChannel } from "@gtm-agents/core/ports";
import { sanitizeErrorMessage } from "@gtm-agents/core/security";
import type { SendOutreach } from "@gtm-agents/core/sending";
import type { TemplateFile } from "@gtm-agents/core/templates";
import { draftShipNotes, type NoteRunResult } from "./notes.ts";
import { SHIP_FLAGS, shipFlagOn, shipStepOn } from "./planning-flags.ts";
import { oneLine } from "./planning-shared.ts";
import { parseStoredSpec } from "./spec.ts";

export const ANNOUNCE_EFFECT = "ship_announce";

export interface AnnounceDeps<E extends Env> {
  config: Pick<GtmConfig, "agent" | "company" | "sending" | "autonomy" | "modules">;
  flags: (env: E) => FlagReader;
  operator: (env: E) => OperatorChannel | undefined;
  send: (env: E) => SendOutreach | undefined;
  templates: readonly TemplateFile[] | undefined;
  templateId: string;
  maxNotes: number;
  chatId: string | undefined;
  log: JobLogger;
}

function pageText(theme: { id: string; title: string }, task: { pr_number: number | null }, notes: NoteRunResult | string): string {
  const pr = task.pr_number ? ` (pull request #${task.pr_number})` : "";
  const lines = [`Shipped: ${oneLine(theme.title, 120)} is live in production${pr} [theme ${theme.id}].`];
  if (typeof notes === "string") lines.push(notes);
  else {
    const parts = [`${notes.requesters} requester(s) reachable`];
    if (notes.unresolved) parts.push(`${notes.unresolved} could not be resolved to a contact`);
    if (notes.drafted) parts.push(`${notes.drafted} note(s) drafted for you (ship-note-approve-<id>)`);
    if (notes.sent) parts.push(`${notes.sent} sent`);
    if (notes.queued) parts.push(`${notes.queued} held by the send function until they can go`);
    if (notes.skipped) parts.push(`${notes.skipped} skipped`);
    if (notes.failed) parts.push(`${notes.failed} failed`);
    lines.push(`"You asked, it is live" notes: ${parts.join(", ")}.${notes.reason ? ` ${notes.reason}.` : ""}`);
  }
  return lines.join("\n");
}

/** Build AnnounceShipped for the factory. The returned function never throws. */
export function createAnnounceShipped<E extends Env>(deps: AnnounceDeps<E>): (env: E, taskId: string, now: Date) => Promise<void> {
  return async (env, taskId, now) => {
    const log = deps.log;
    try {
      if (!deps.config.modules.ship.enabled) {
        log.warn("a shipped task was announced while modules.ship is off; nothing was changed", { taskId: oneLine(taskId, 40) });
        return;
      }
      const db = env.DB;
      const flags = deps.flags(env);
      if (!(await shipFlagOn(flags, SHIP_FLAGS.enabled))) {
        log.warn("a shipped task was announced while ship:enabled is off or unreadable; nothing was changed", { taskId: oneLine(taskId, 40) });
        return;
      }
      if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
        log.warn("a shipped task was announced with an id that is not one; nothing was changed");
        return;
      }
      const task = await db.prepare("SELECT id, theme_id, pr_number FROM ship_tasks WHERE id = ?1").bind(taskId).first<{ id: string; theme_id: string; pr_number: number | null }>();
      if (!task) {
        log.warn("a shipped task was announced that does not exist", { taskId });
        return;
      }
      const theme = await db.prepare("SELECT id, title, spec FROM themes WHERE id = ?1").bind(task.theme_id).first<{ id: string; title: string; spec: string | null }>();
      if (!theme) {
        log.warn("a shipped task's theme does not exist", { taskId });
        return;
      }
      const at = now.toISOString();
      await db.batch([
        db.prepare("UPDATE themes SET status = 'shipped', shipped_at = COALESCE(shipped_at, ?2), updated_at = ?2 WHERE id = ?1 AND status <> 'shipped'").bind(theme.id, at),
        db.prepare("UPDATE feedback_items SET status = 'shipped' WHERE theme_id = ?1 AND status = 'themed'").bind(theme.id),
      ]);
      const title = parseStoredSpec(theme.spec)?.title ?? theme.title;
      const operator = (() => {
        try {
          return deps.operator(env);
        } catch {
          return undefined;
        }
      })();

      let notes: NoteRunResult | string;
      if (!(await shipStepOn(flags, SHIP_FLAGS.notes))) notes = `No notes were drafted: ${SHIP_FLAGS.notes} is off.`;
      else {
        try {
          const send = (() => {
            try {
              return deps.send(env);
            } catch {
              return undefined;
            }
          })();
          notes = await draftShipNotes(
            { env, db, flags, config: deps.config, send, operator, chatId: deps.chatId, templates: deps.templates, templateId: deps.templateId, maxNotes: deps.maxNotes, now, log },
            { id: theme.id, title },
            task.id,
          );
          await db.prepare("UPDATE ship_tasks SET notified_at = COALESCE(notified_at, ?2), updated_at = ?2 WHERE id = ?1").bind(task.id, at).run();
        } catch (error) {
          log.error("the ship notes could not be drafted", { themeId: theme.id, error: sanitizeErrorMessage(error) });
          notes = "The notes could not be drafted; the Worker's logs say why.";
        }
      }

      // The page, once per theme.
      if (operator && (await claimEffect(db, theme.id, ANNOUNCE_EFFECT))) {
        try {
          await operator.notify({ text: pageText({ id: theme.id, title }, task, notes), ...(deps.chatId ? { chatId: deps.chatId } : {}) });
        } catch (error) {
          await releaseEffect(db, theme.id, ANNOUNCE_EFFECT);
          log.warn("the shipped page could not be delivered", { themeId: theme.id, error: sanitizeErrorMessage(error) });
        }
      }
    } catch (error) {
      log.error("announcing a shipped task failed; the caller was not failed", { error: sanitizeErrorMessage(error) });
    }
  };
}

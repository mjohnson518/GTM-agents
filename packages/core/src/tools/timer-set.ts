// GTM-agents: the timer_set tool: the hub agent schedules a later turn in this chat session.
//
// Its class is taint none, gate full (security/tool-classes.ts): a session that has read raw
// untrusted text (a web page) cannot set a timer, so a page can never schedule work. A session that
// has read only third-party records or extracted values may, and the timer carries that taint: the
// turn it starts begins at least as tainted as the session was when the call ran (agents/timers.ts).
// The handler validates and writes one row and decides nothing else. Firing belongs to the
// operator_timers job and the chat consumer (docs/OPERATOR.md#timers).
//
// Skip rather than guess: a time that does not parse, has no timezone, or falls outside the window
// is refused, never moved into it, and a session already holding TIMER_PENDING_MAX waiting timers is
// refused rather than having one replaced.
import type { ToolHandler } from "../runtime/dispatcher.ts";
import {
  TIMER_MAX_DELAY_DAYS,
  TIMER_MIN_DELAY_MINUTES,
  TIMER_NOTE_MAX_CHARS,
  TIMER_PENDING_MAX,
  insertTimer,
  minuteUtc,
  newTimerId,
} from "../agents/timers.ts";

const MAX_DELAY_MINUTES = TIMER_MAX_DELAY_DAYS * 24 * 60;

export const timerSetDefinition = {
  name: "timer_set",
  description:
    `Set a timer that starts a later turn in this chat, for example to check on something tomorrow. Give either in_minutes or at, between ${TIMER_MIN_DELAY_MINUTES} minutes and ${TIMER_MAX_DELAY_DAYS} days from now, and a short note saying what to do then. ` +
    "When it fires, you get the note back in a new turn and your reply goes to the operator. Set one only when the operator asks to be reminded or to have something checked later. Refused once the session has read a web page.",
  inputSchema: {
    type: "object",
    properties: {
      in_minutes: { type: "integer", minimum: TIMER_MIN_DELAY_MINUTES, maximum: MAX_DELAY_MINUTES, description: "Minutes from now." },
      at: { type: "string", description: "An exact time in ISO 8601 with a timezone, for example 2026-11-16T09:00:00Z." },
      note: { type: "string", description: `What to do when the timer fires, at most ${TIMER_NOTE_MAX_CHARS} characters.` },
    },
    required: ["note"],
    additionalProperties: false,
  },
} as const;

export interface TimerSetDeps {
  db: D1Database;
  /** The session the timer belongs to, and the operator its turn is checked against when it fires. */
  sessionKey: string;
  chatId: string;
  userId: string;
  /** The session's cleared_at as the turn loaded it. A /clean after this cancels the timer. */
  clearedAt: string | null;
  turnId: string;
  newId?: () => string;
  now?: () => Date;
}

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function cleanNote(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(INVISIBLE, "").trim();
}

/** When the timer is due, from exactly one of in_minutes and at. Throws with a message the model can act on. */
export function resolveTimerDue(input: Record<string, unknown>, now: Date): Date {
  const hasMinutes = input.in_minutes !== undefined;
  const hasAt = input.at !== undefined;
  if (hasMinutes === hasAt) throw new Error("give exactly one of in_minutes and at");
  let due: Date;
  if (hasMinutes) {
    const minutes = input.in_minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes)) throw new Error("in_minutes must be a whole number of minutes");
    due = new Date(now.getTime() + minutes * 60_000);
  } else {
    const at = input.at;
    if (typeof at !== "string" || !ZONED_ISO.test(at.trim())) throw new Error("at must be an ISO 8601 time with a timezone, for example 2026-11-16T09:00:00Z");
    const t = Date.parse(at.trim());
    if (Number.isNaN(t)) throw new Error("at is not a valid time");
    due = new Date(t);
  }
  const delay = due.getTime() - now.getTime();
  if (delay < TIMER_MIN_DELAY_MINUTES * 60_000) throw new Error(`the timer must be due at least ${TIMER_MIN_DELAY_MINUTES} minutes from now (it is ${minuteUtc(now.toISOString())})`);
  if (delay > MAX_DELAY_MINUTES * 60_000) throw new Error(`the timer must be due within ${TIMER_MAX_DELAY_DAYS} days from now (it is ${minuteUtc(now.toISOString())})`);
  return due;
}

export function createTimerSetHandler(deps: TimerSetDeps): ToolHandler {
  return async (input, ctx) => {
    const raw = input.note;
    if (typeof raw !== "string") throw new Error("note is required");
    const note = cleanNote(raw);
    if (note.length === 0 || note.length > TIMER_NOTE_MAX_CHARS) throw new Error(`note must be 1 to ${TIMER_NOTE_MAX_CHARS} characters`);
    const now = deps.now?.() ?? new Date();
    const due = resolveTimerDue(input, now);
    const id = (deps.newId ?? newTimerId)();
    // ctx.taint is the session's taint as this call started, including anything read earlier in
    // the same turn: the taint the timer's turn starts from.
    const inserted = await insertTimer(
      deps.db,
      { id, sessionKey: deps.sessionKey, chatId: deps.chatId, userId: deps.userId, note, taint: ctx.taint, sessionClearedAt: deps.clearedAt, dueAt: due, setByTurnId: deps.turnId },
      now,
    );
    if (!inserted) throw new Error(`this chat already has ${TIMER_PENDING_MAX} timers waiting; the operator can list them with /timers and cancel one with /timers cancel <id>`);
    return `Timer ${id} is set for ${minuteUtc(due.toISOString())}. When it fires, a new turn in this chat gets the note back. The operator can list timers with /timers and cancel this one with /timers cancel ${id}.`;
  };
}

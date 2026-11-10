// GTM-agents: a dashboard chat turn's live text. The hub loop hands it the model's text as it is
// produced (TurnInput.onText); it pushes that text as chat.delta events, batched, and when the turn
// ends it makes what the dashboard shows equal the reply the turn returned.
//
//   - Batched: text is held for at most STREAM_FLUSH_MS, or until STREAM_MAX_CHARS characters are
//     waiting, then pushed as one event. A delta carries at most STREAM_MAX_CHARS characters, so even
//     escaped as JSON (at most six bytes a character) a frame stays far under MAX_FRAME_BYTES, and a
//     turn pushes about ten frames a second at most, however fast the model writes.
//   - Rounds: a turn's reply is the answer of its last model call that wrote text. When a later
//     call (after a tool) starts writing, its first delta carries `reset`, so the dashboard replaces
//     the earlier answer instead of appending to it. A later call that writes only whitespace does
//     not replace anything.
//   - Abort: once the turn's signal is aborted, nothing more is pushed until finish.
//   - Finish: the final reply (what the turn returned, which chat.history also records) is compared
//     with what was pushed. When it continues what the dashboard shows, only the rest is pushed;
//     otherwise it is pushed whole, its first delta carrying `reset`. Either way the dashboard ends
//     with exactly the final reply. The caller then pushes chat.done.
import type { ServerEvent } from "./protocol.ts";

export const STREAM_FLUSH_MS = 100;
export const STREAM_MAX_CHARS = 2048;

export interface ChatStreamOptions {
  turnId: string;
  push: (event: ServerEvent) => void;
  signal: AbortSignal;
  flushMs?: number;
  maxChars?: number;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Split text into pieces of at most `max` characters, never between the two halves of a surrogate pair. */
export function chunkText(text: string, max: number): string[] {
  const size = Math.max(2, max);
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

export class ChatStream {
  readonly #turnId: string;
  readonly #push: (event: ServerEvent) => void;
  readonly #signal: AbortSignal;
  readonly #flushMs: number;
  readonly #maxChars: number;
  /** What the dashboard holds for this turn after the deltas pushed so far. */
  #shown = "";
  /** Text received and not pushed yet, and whether it replaces what is shown. */
  #pending = "";
  #reset = false;
  #round = 0;
  /** This model call's text so far, and whether it is to replace an earlier call's answer once it has some. */
  #roundText = "";
  #replacing = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: ChatStreamOptions) {
    this.#turnId = options.turnId;
    this.#push = options.push;
    this.#signal = options.signal;
    this.#flushMs = Math.max(0, options.flushMs ?? STREAM_FLUSH_MS);
    this.#maxChars = Math.max(2, options.maxChars ?? STREAM_MAX_CHARS);
  }

  /** One piece of the answer of model call `round`. */
  text(piece: string, round: number): void {
    if (this.#closed || !piece) return;
    if (this.#signal.aborted) {
      this.#cancelTimer();
      return;
    }
    if (round !== this.#round) {
      this.#round = round;
      this.#roundText = "";
      this.#replacing = this.#shown !== "" || this.#pending !== "";
    }
    this.#roundText += piece;
    if (this.#replacing) {
      // Keep the earlier answer on screen until this call has written something to replace it with.
      if (!this.#roundText.trim()) return;
      this.#pending = this.#roundText;
      this.#reset = true;
      this.#replacing = false;
    } else {
      this.#pending += piece;
    }
    if (this.#pending.length >= this.#maxChars) this.#flush(false);
    else this.#schedule();
  }

  /** Push the final reply (see the header) and stop. Nothing is pushed after this. */
  finish(final: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    this.#pending = "";
    this.#reset = false;
    if (final.startsWith(this.#shown)) this.#send(final.slice(this.#shown.length), false);
    else this.#send(final, true);
    this.#shown = final;
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#closed && !this.#signal.aborted) this.#flush();
    }, this.#flushMs);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Push what is waiting. On a size flush (`all` false), a short last piece keeps waiting for more. */
  #flush(all = true): void {
    this.#cancelTimer();
    if (!this.#pending && !this.#reset) return;
    let text = this.#pending;
    let rest = "";
    if (!all) {
      const last = chunkText(text, this.#maxChars).at(-1) ?? "";
      if (last.length < this.#maxChars && last.length < text.length) {
        rest = last;
        text = text.slice(0, text.length - last.length);
      }
    }
    this.#send(text, this.#reset);
    this.#shown = this.#reset ? text : this.#shown + text;
    this.#pending = rest;
    this.#reset = false;
    if (rest) this.#schedule();
  }

  #send(text: string, reset: boolean): void {
    const pieces = chunkText(text, this.#maxChars);
    if (pieces.length === 0 && reset) pieces.push("");
    pieces.forEach((piece, i) => {
      this.#push({ event: "chat.delta", data: { turnId: this.#turnId, text: piece, ...(reset && i === 0 ? { reset: true } : {}) } });
    });
  }
}

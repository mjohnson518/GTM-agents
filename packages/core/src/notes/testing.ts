// GTM-agents: test helpers for meeting notes: an in-memory meeting-notes provider that records every
// call and can be told to fail, and a model gateway that answers with fixed text and records every
// request. Every recording, person and transcript a test builds with them is synthetic.
import type { MeetingNotesProvider, MeetingRecording, TranscriptSegment } from "../ports/business.ts";
import type { CompletionRequest, CompletionResult, ModelGateway } from "../ports/model.ts";

export interface FakeNotesProvider extends MeetingNotesProvider {
  listed: Array<{ since: string; cursor?: string }>;
  fetched: string[];
  failWith(error: Error | null): void;
}

/** A provider over fixed recordings, in pages of `pageSize`, and their transcripts by id. */
export function fakeNotesProvider(name: string, recordings: MeetingRecording[], transcripts: Record<string, TranscriptSegment[]>, pageSize = 25): FakeNotesProvider {
  const listed: FakeNotesProvider["listed"] = [];
  const fetched: string[] = [];
  let failure: Error | null = null;
  return {
    name,
    listed,
    fetched,
    failWith(error) {
      failure = error;
    },
    listRecordings(args) {
      if (failure) return Promise.reject(failure);
      listed.push({ since: args.since, ...(args.cursor ? { cursor: args.cursor } : {}) });
      const start = args.cursor ? Number(args.cursor) : 0;
      const items = recordings.filter((r) => r.startedAt >= args.since).slice(start, start + pageSize);
      const next = start + pageSize < recordings.filter((r) => r.startedAt >= args.since).length ? String(start + pageSize) : undefined;
      return Promise.resolve({ items, ...(next ? { cursor: next } : {}) });
    },
    getTranscript(externalId) {
      if (failure) return Promise.reject(failure);
      fetched.push(externalId);
      return Promise.resolve({ segments: transcripts[externalId] ?? [] });
    },
  };
}

export interface FakeAnsweringModel extends ModelGateway {
  requests: CompletionRequest[];
}

/** A model gateway that answers every request with `answer` (or what `answer` returns for it). */
export function fakeAnsweringModel(answer: string | ((req: CompletionRequest) => string), model = "test-worker-model"): FakeAnsweringModel {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake-gateway",
    requests,
    complete(req): Promise<CompletionResult> {
      requests.push(req);
      return Promise.resolve({ text: typeof answer === "string" ? answer : answer(req), toolCalls: [], stopReason: "end", usage: { inputTokens: 2000, outputTokens: 200 }, model });
    },
    embed() {
      return Promise.resolve({ vectors: [], model });
    },
  };
}

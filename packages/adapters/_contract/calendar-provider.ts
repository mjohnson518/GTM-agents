// GTM-agents: the shared contract every CalendarProvider adapter runs in its contract.test.ts.
//
//   runCalendarProviderContract((ctx) => createAdapter(ctx), fixtures)
//
// With recorded responses only, it checks what core relies on, whatever the calendar:
//   - the manifest validates, declares the CalendarProvider port, the convert:calendar_enabled flag
//     and a cost table, and its capabilities say which methods work: "list" (listEvents),
//     "freeBusy" and "write" (createEvent, updateEvent, cancelEvent). A capability-limited adapter
//     refuses every other method with a non-retryable "invalid" AdapterError, without a request,
//     and a `capabilities` object, when present, agrees with the manifest;
//   - only the injected fetch is used;
//   - privacy: every listing request names a field mask, and the mask never asks for a title, a
//     description, a location, conferencing, attachments or attendee names. Text the vendor answers
//     with anyway (a recorded response carries a title and a description) never reaches core;
//   - listed events are well formed: an id, a known status, ISO 8601 UTC times (null for all-day
//     events), lowercase attendee addresses with a self flag and a known response, an organizer or
//     null, and no other keys. A cancelled event is returned with status "cancelled";
//   - a vendor failure is a typed AdapterError with the code and retryable flag the fixture names;
//   - with no credentials, listing throws a non-retryable auth error before any request.
import { AdapterError, manifestSchema, type AdapterContext, type AdapterErrorCode, type CalendarEventSummary, type CalendarProvider } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

export type CalendarMethod = "listEvents" | "freeBusy" | "createEvent" | "updateEvent" | "cancelEvent";

/** Which methods each manifest capability turns on. */
export const CALENDAR_CAPABILITY_METHODS: Readonly<Record<string, readonly CalendarMethod[]>> = Object.freeze({
  list: ["listEvents"],
  freeBusy: ["freeBusy"],
  write: ["createEvent", "updateEvent", "cancelEvent"],
});

const ALL_METHODS: readonly CalendarMethod[] = ["listEvents", "freeBusy", "createEvent", "updateEvent", "cancelEvent"];

/** Field names a listing may never ask for, in any vendor's spelling. */
export const FORBIDDEN_FIELDS: readonly string[] = Object.freeze([
  "summary",
  "subject",
  "title",
  "description",
  "body",
  "bodypreview",
  "location",
  "conferencedata",
  "hangoutlink",
  "onlinemeeting",
  "attachments",
  "displayname",
  "comment",
  "extendedproperties",
]);

/** The keys a listed event may carry. */
export const EVENT_KEYS: readonly string[] = Object.freeze(["id", "status", "start", "end", "allDay", "seriesId", "organizer", "attendees"]);

export interface ListingFixtures {
  window: { start: string; end: string };
  /** What listEvents must return for the window, matched by id. */
  expected: CalendarEventSummary[];
  /** Text present in the recorded responses (a title, a description) that must never reach core. */
  leakedText: string[];
  /** True for a request that lists events. */
  isListRequest(request: Request): boolean;
  /** The field names a listing request asks for, split into single names; null when it names no mask. */
  requestedFields(request: Request): string[] | null;
  /** A context whose calendar refuses every listing, and the code and retryable flag that maps to. */
  failing(): { ctx: AdapterContext; calls: Request[]; code: AdapterErrorCode; retryable: boolean };
}

export interface CalendarProviderFixtures {
  manifest: unknown;
  /** A context with every secret set and a recorded fetch serving the fixture calendar. */
  context(): { ctx: AdapterContext; calls: Request[] };
  /** A context with no secrets set. */
  unconfigured(): { ctx: AdapterContext; calls: Request[] };
  listing: ListingFixtures;
}

async function rejection(promise: Promise<unknown>): Promise<{ code: unknown; retryable: unknown; adapterError: boolean }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: unknown; retryable?: unknown };
    return { code: e.code, retryable: e.retryable, adapterError: error instanceof AdapterError };
  }
  throw new Error("expected the call to be refused");
}

const isUtc = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function expectWellFormed(event: CalendarEventSummary): void {
  for (const key of Object.keys(event)) expect(EVENT_KEYS, `event key ${key}`).toContain(key);
  expect(typeof event.id).toBe("string");
  expect(event.id.length).toBeGreaterThan(0);
  expect(["confirmed", "tentative", "cancelled"]).toContain(event.status);
  expect(typeof event.allDay).toBe("boolean");
  for (const time of [event.start, event.end]) {
    if (time === null) continue;
    expect(isUtc(time), `${time} is ISO 8601 UTC`).toBe(true);
  }
  if (event.allDay) expect([event.start, event.end]).toEqual([null, null]);
  if (event.organizer !== null) {
    expect(Object.keys(event.organizer).sort()).toEqual(["email", "self"]);
    expect(event.organizer.email).toBe(event.organizer.email.toLowerCase());
  }
  for (const attendee of event.attendees) {
    expect(Object.keys(attendee).sort()).toEqual(["email", "responseStatus", "self"]);
    expect(attendee.email).toBe(attendee.email.toLowerCase());
    expect(attendee.email).toMatch(/^[^\s@]+@[^\s@]+$/);
    expect(typeof attendee.self).toBe("boolean");
    expect(["accepted", "declined", "tentative", "needsAction"]).toContain(attendee.responseStatus);
  }
}

const call = (provider: CalendarProvider, method: CalendarMethod): Promise<unknown> => {
  const window = { start: "2026-11-01T00:00:00.000Z", end: "2026-11-30T00:00:00.000Z" };
  const event = { title: "unused", start: window.start, end: window.end, attendees: [] };
  switch (method) {
    case "listEvents":
      return provider.listEvents(window);
    case "freeBusy":
      return provider.freeBusy(window);
    case "createEvent":
      return provider.createEvent(event, "effect-1");
    case "updateEvent":
      return provider.updateEvent("event-1", { start: window.start });
    case "cancelEvent":
      return provider.cancelEvent("event-1");
  }
};

export function runCalendarProviderContract(create: (ctx: AdapterContext) => CalendarProvider, fixtures: CalendarProviderFixtures): void {
  const manifest = manifestSchema.parse(fixtures.manifest);
  const supported = new Set(manifest.capabilities.flatMap((c) => CALENDAR_CAPABILITY_METHODS[c] ?? []));
  const unsupported = ALL_METHODS.filter((m) => !supported.has(m));

  describe("the CalendarProvider contract", () => {
    let globalFetch: { mock: { calls: unknown[] }; mockRestore(): void };
    beforeEach(() => {
      globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("adapters use ctx.fetch, never the global fetch");
      });
    });
    afterEach(() => {
      expect(globalFetch.mock.calls).toHaveLength(0);
      globalFetch.mockRestore();
    });

    it("declares the port, the calendar flag, a cost table and its capabilities in a valid manifest", () => {
      expect(manifest.ports).toContain("CalendarProvider");
      expect(manifest.flags).toContain("convert:calendar_enabled");
      expect(Object.keys(manifest.costs).length).toBeGreaterThan(0);
      expect(manifest.capabilities).toContain("list");
      for (const capability of manifest.capabilities) expect(Object.keys(CALENDAR_CAPABILITY_METHODS), capability).toContain(capability);
    });

    it("declares capabilities that agree with its manifest", () => {
      const declared = Reflect.get(create(fixtures.context().ctx), "capabilities") as Partial<Record<string, boolean>> | undefined;
      if (!declared) return;
      expect(declared.list !== false, "capabilities.list").toBe(supported.has("listEvents"));
      expect(declared.freeBusy !== false, "capabilities.freeBusy").toBe(supported.has("freeBusy"));
      expect(declared.write !== false, "capabilities.write").toBe(supported.has("createEvent"));
    });

    if (unsupported.length > 0) {
      it("refuses the methods it does not support with a non-retryable invalid error, without a request", async () => {
        const { ctx, calls } = fixtures.context();
        const provider = create(ctx);
        for (const method of unsupported) expect(await rejection(call(provider, method)), method).toEqual({ code: "invalid", retryable: false, adapterError: true });
        expect(calls).toHaveLength(0);
      });
    }

    it("asks the calendar for no title, description, location or attendee name on any listing request", async () => {
      const { ctx, calls } = fixtures.context();
      await create(ctx).listEvents(fixtures.listing.window);
      const listings = calls.filter((r) => fixtures.listing.isListRequest(r));
      expect(listings.length).toBeGreaterThan(0);
      for (const request of listings) {
        const fields = fixtures.listing.requestedFields(request);
        expect(fields, "every listing names a field mask").not.toBeNull();
        expect(fields?.length ?? 0).toBeGreaterThan(0);
        for (const field of fields ?? []) expect(FORBIDDEN_FIELDS, `${field} is not requested`).not.toContain(field.toLowerCase());
      }
    });

    it("lists well-formed events, cancelled ones included, and nothing it was not asked for", async () => {
      const { ctx } = fixtures.context();
      const events = await create(ctx).listEvents(fixtures.listing.window);
      for (const event of events) expectWellFormed(event);
      const byId = new Map(events.map((e) => [e.id, e]));
      for (const expected of fixtures.listing.expected) expect(byId.get(expected.id), expected.id).toEqual(expected);
      expect(events.some((e) => e.status === "cancelled"), "a cancelled event is listed").toBe(true);
      const serialized = JSON.stringify(events);
      for (const leaked of fixtures.listing.leakedText) expect(serialized, "vendor text never reaches core").not.toContain(leaked);
    });

    it("maps a refused listing to a typed AdapterError", async () => {
      const { ctx, code, retryable } = fixtures.listing.failing();
      expect(await rejection(create(ctx).listEvents(fixtures.listing.window))).toEqual({ code, retryable, adapterError: true });
    });

    it("throws a non-retryable auth error without credentials, before any request", async () => {
      const { ctx, calls } = fixtures.unconfigured();
      expect(await rejection(create(ctx).listEvents(fixtures.listing.window))).toEqual({ code: "auth", retryable: false, adapterError: true });
      expect(calls).toHaveLength(0);
    });
  });
}

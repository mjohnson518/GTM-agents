// GTM-agents: the gate for a second finder (docs/SOURCING.md#the-email-waterfall). With LeadMagic
// second in the waterfall, a candidate Hunter could not resolve gets LeadMagic's address, which
// still passes screening and verification before promotion; and a verifier that reports accept-all
// as unknown (LeadMagic's) never promotes such an address. Every company, person and address is
// invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runDiscoveryCycle } from "../src/sourcing/cycle.ts";
import { SOURCING_FLAGS } from "../src/sourcing/flags.ts";
import type { ContactFinder, EmailVerifier } from "../src/ports/contact.ts";
import { accountResult, fakeFinder, fakePeople, fakeSource, fakeVerifier, flagsOf, person, resetSourcingTables, silentLog, uploadBrain } from "./sourcing-fakes.ts";

const DAY_MS = 86_400_000;
const START = new Date("2026-11-04T09:00:00.000Z");

beforeEach(async () => {
  await resetSourcingTables(env.DB);
  await uploadBrain(env.KV);
});

function cycle(finders: ContactFinder[], verifier: EmailVerifier, options: { waterfall?: boolean; at?: Date; runId?: string } = {}) {
  const source = fakeSource("fake-search", [accountResult("Brightloop Labs", "brightloop.example")]);
  const people = fakePeople("fake-people", { "brightloop.example": [person("Jane", "Doe", "VP Engineering", "brightloop.example")] });
  return runDiscoveryCycle({
    db: env.DB,
    kv: env.KV,
    flags: flagsOf({ [SOURCING_FLAGS.enabled]: "true", ...(options.waterfall === false ? {} : { [SOURCING_FLAGS.waterfall]: "true" }) }),
    adapters: { sources: [source], people, finders, verifier },
    now: options.at ?? START,
    job: "discovery_cycle",
    runId: options.runId ?? "run-1",
    log: silentLog,
    jobCapCents: 300,
    peoplePerAccount: 1,
  });
}

const contacts = async () => (await env.DB.prepare("SELECT email, account_key FROM contacts").all<{ email: string; account_key: string }>()).results;
const janeCandidate = () =>
  env.DB.prepare("SELECT status, email, email_source, attributes FROM candidates WHERE first_name = 'Jane'").first<{ status: string; email: string | null; email_source: string | null; attributes: string }>();

describe("a second finder in the email waterfall", () => {
  it("finds the address Hunter could not, and the contact is promoted only after screening and verification", async () => {
    const hunter = fakeFinder("data-hunter", {});
    const leadmagic = fakeFinder("data-leadmagic", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    const verifier = fakeVerifier("data-hunter");
    await cycle([hunter, leadmagic], verifier);
    expect(hunter.calls).toHaveLength(1);
    expect(leadmagic.calls).toHaveLength(1);
    expect(verifier.calls).toContain("jane.doe@brightloop.example");
    expect(await contacts()).toEqual([{ email: "jane.doe@brightloop.example", account_key: "brightloop.example" }]);
    expect(await janeCandidate()).toMatchObject({ status: "promoted", email_source: "data-leadmagic" });
  });

  it("does not ask the second finder while discovery:email_waterfall_enabled is off", async () => {
    const leadmagic = fakeFinder("data-leadmagic", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    await cycle([fakeFinder("data-hunter", {}), leadmagic], fakeVerifier("data-hunter"), { waterfall: false });
    expect(leadmagic.calls).toHaveLength(0);
    expect(await contacts()).toEqual([]);
  });

  it("drops a second-finder address that is not a work address at the account, and never verifies it", async () => {
    const verifier = fakeVerifier("data-hunter");
    await cycle([fakeFinder("data-hunter", {}), fakeFinder("data-leadmagic", { "jane doe@brightloop.example": "jane.doe@initech.example" })], verifier);
    expect(verifier.calls).not.toContain("jane.doe@initech.example");
    expect(await contacts()).toEqual([]);
    expect((await janeCandidate())?.email).toBeNull();
  });

  it("never promotes an address the verifier reports unknown (LeadMagic's answer for accept-all)", async () => {
    const leadmagic = fakeFinder("data-leadmagic", { "jane doe@brightloop.example": "jane.doe@brightloop.example" });
    const verifier = fakeVerifier("data-leadmagic", {}, "unknown");
    for (let i = 0; i < 4; i++) {
      await cycle([fakeFinder("data-hunter", {}), leadmagic], verifier, { at: new Date(START.getTime() + i * 8 * DAY_MS), runId: `run-${i}` });
      expect(await contacts()).toEqual([]);
    }
    // Without a deliverable result the address adds nothing to the qualification score, so the
    // candidate stops below qualified and promotion never sees it.
    const row = await janeCandidate();
    expect(row).toMatchObject({ status: "borderline", email: "jane.doe@brightloop.example" });
    expect(JSON.parse(row?.attributes ?? "{}")).toMatchObject({ reject_reason: "borderline_score" });
  });
});

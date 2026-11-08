// GTM-agents: tests for recipient time zones and send windows. Pure functions, no database.
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEZONE, isValidTimezone, recipientTimezone, timezoneFromLocation } from "../src/sending/timezone.ts";
import { isWithinWindow, localParts, nextAllowedTime, windowForPath, zonedTimeToUtc, type SendWindow } from "../src/sending/window.ts";
import { config } from "./delivery-fakes.ts";

const MON_THU: SendWindow = { days: ["MON", "TUE", "WED", "THU"], startHour: 8, endHour: 15 };

describe("recipient time zones", () => {
  it("prefers the contact's own valid zone", () => {
    expect(recipientTimezone({ timezone: "Europe/Berlin", location: "Austin, TX" })).toEqual({ timezone: "Europe/Berlin", source: "contact" });
    expect(recipientTimezone({ timezone: "Mars/Olympus", location: "Austin, TX" })).toEqual({ timezone: "America/Chicago", source: "region" });
  });

  it.each([
    ["Madrid, Spain", "Europe/Madrid"],
    ["Zürich, Switzerland", "Europe/Zurich"],
    ["Cambridge, United Kingdom", "Europe/London"],
    ["Bengaluru, Karnataka, India", "Asia/Kolkata"],
    ["Indianapolis, Indiana", "America/New_York"],
    ["Santa Fe, New Mexico, United States", "America/Denver"],
    ["Mexico City, Mexico", "America/Mexico_City"],
    ["Vancouver, British Columbia, Canada", "America/Vancouver"],
    ["Montreal, Canada", "America/Toronto"],
    ["Perth, Western Australia, Australia", "Australia/Perth"],
    ["Sydney, Australia", "Australia/Sydney"],
    ["Seattle, WA", "America/Los_Angeles"],
    ["Denver, CO", "America/Denver"],
    ["Brooklyn, New York", "America/New_York"],
    ["Phoenix, Arizona", "America/Phoenix"],
    ["Tokyo", "Asia/Tokyo"],
    ["São Paulo", "America/Sao_Paulo"],
    ["Remote, USA", "America/New_York"],
  ])("reads %s as %s", (location, expected) => {
    expect(timezoneFromLocation(location)?.timezone).toBe(expected);
  });

  it("falls back to the default when nothing is recognized", () => {
    expect(timezoneFromLocation("Remote")).toBeNull();
    expect(recipientTimezone({ location: "Remote" })).toEqual({ timezone: DEFAULT_TIMEZONE, source: "default" });
    expect(recipientTimezone(null, "Europe/Dublin")).toEqual({ timezone: "Europe/Dublin", source: "default" });
    expect(recipientTimezone(null, "Not/AZone").timezone).toBe(DEFAULT_TIMEZONE);
  });

  it("validates zone names", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("America/Nowhere")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("send windows", () => {
  it("reads wall-clock parts in a zone", () => {
    expect(localParts(new Date("2026-11-04T17:00:00.000Z"), "America/New_York")).toMatchObject({ weekday: "WED", hour: 12 });
    expect(localParts(new Date("2026-11-04T17:00:00.000Z"), "Asia/Tokyo")).toMatchObject({ weekday: "THU", hour: 2 });
  });

  it("converts wall-clock times across daylight saving changes", () => {
    expect(zonedTimeToUtc(2026, 7, 1, 8, "America/New_York").toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(zonedTimeToUtc(2026, 12, 1, 8, "America/New_York").toISOString()).toBe("2026-12-01T13:00:00.000Z");
    expect(zonedTimeToUtc(2026, 11, 2, 8, "America/New_York").toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });

  it("returns now inside the window", () => {
    const now = new Date("2026-11-04T17:00:00.000Z");
    expect(isWithinWindow(now, "America/New_York", MON_THU)).toBe(true);
    expect(nextAllowedTime(now, "America/New_York", MON_THU)).toBe(now);
  });

  it("returns the next opening: later today, tomorrow, or past the weekend", () => {
    // 06:00 Wednesday in New York: opens at 08:00 the same day.
    expect(nextAllowedTime(new Date("2026-11-04T11:00:00.000Z"), "America/New_York", MON_THU).toISOString()).toBe("2026-11-04T13:00:00.000Z");
    // 16:00 Wednesday: opens Thursday 08:00.
    expect(nextAllowedTime(new Date("2026-11-04T21:00:00.000Z"), "America/New_York", MON_THU).toISOString()).toBe("2026-11-05T13:00:00.000Z");
    // 16:00 Thursday: Friday to Sunday are closed, so Monday 08:00.
    expect(nextAllowedTime(new Date("2026-11-05T21:00:00.000Z"), "America/New_York", MON_THU).toISOString()).toBe("2026-11-09T13:00:00.000Z");
    // The end hour is exclusive.
    expect(isWithinWindow(new Date("2026-11-04T20:00:00.000Z"), "America/New_York", MON_THU)).toBe(false);
  });

  it("never opens a window with no days or an empty range", () => {
    const now = new Date("2026-11-04T17:00:00.000Z");
    expect(nextAllowedTime(now, "UTC", { days: [], startHour: 8, endHour: 15 }).getTime()).toBeGreaterThan(now.getTime() + 6 * 86_400_000);
    expect(nextAllowedTime(now, "UTC", { days: ["WED"], startHour: 15, endHour: 8 }).getTime()).toBeGreaterThan(now.getTime() + 6 * 86_400_000);
  });

  it("picks the window by path from the sending config", () => {
    expect(windowForPath("cold", config.sending)).toEqual({ days: ["MON", "TUE", "WED", "THU"], startHour: 8, endHour: 15 });
    expect(windowForPath("sequence", config.sending)?.days).toEqual(["MON", "TUE", "WED", "THU"]);
    expect(windowForPath("lifecycle", config.sending)?.days).toEqual(["MON", "TUE", "WED", "THU", "FRI"]);
    expect(windowForPath("reply", config.sending)).toBeNull();
  });
});

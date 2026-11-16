// GTM-agents: ports for finding and verifying work email addresses, and checking where a person works.
import type { Cost, Evidence } from "./types.ts";

export interface ContactFinder {
  readonly name: string;
  findWorkEmail(args: {
    firstName: string;
    lastName: string;
    domain: string;
    profileUrl?: string;
  }): Promise<{ email: string; confidence: number; sources: Evidence[]; cost?: Cost } | { email: null; cost?: Cost }>;
}

export const VERIFICATION_STATUSES = ["deliverable", "risky", "undeliverable", "unknown"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface EmailVerifier {
  readonly name: string;
  verify(email: string): Promise<{
    status: VerificationStatus;
    /** 0 to 100 when the vendor gives one. */
    score?: number;
    /** Vendor code, for the audit row. */
    reason?: string;
    acceptAll?: boolean;
    disposable?: boolean;
    cost?: Cost;
  }>;
}

export const EMPLOYMENT_STATUSES = ["current", "moved", "never_worked_there", "ambiguous", "unknown", "profile_not_found"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/**
 * Where a person works now, from their public professional profile (docs/SIGNALS.md#employment-checks).
 * Every text field it returns is third-party data: core cleans it and stores it as data, like any
 * provider's, and never puts it in a notice or a signal headline.
 */
export interface EmploymentChecker {
  readonly name: string;
  /**
   * Whether the person still works at the expected company. `current`: it is a current role;
   * `moved`: another employer is current; `never_worked_there`, `ambiguous` (several current roles),
   * `unknown` (no dates) and `profile_not_found` say nothing either way. `roleStartedAt` is when the
   * current role at the expected company began, when the profile says.
   */
  checkEmployment(args: { profileUrl: string; companyDomain: string; companyName?: string }): Promise<{
    status: EmploymentStatus;
    roleStartedAt?: string;
    title?: string;
    cost?: Cost;
  }>;
  /**
   * The person's work address at their current employer, from their profile alone, with that
   * employer's domain. `{ email: null }` when none is found. Core screens and verifies it like any
   * other finder's address.
   */
  findCurrentWorkEmail(args: { profileUrl: string; firstName?: string; lastName?: string }): Promise<
    { email: string; domain: string; companyName?: string; title?: string; sources: Evidence[]; cost?: Cost } | { email: null; cost?: Cost }
  >;
}

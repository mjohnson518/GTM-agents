// GTM-agents: ports for finding and verifying work email addresses.
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

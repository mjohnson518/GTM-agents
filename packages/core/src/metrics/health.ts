// GTM-agents: measurement health: whether the numbers are complete enough to conclude anything.
//
// A conclusion is only as good as the counts under it. Before any report names a winner, an
// experiment concludes or a lift is called sufficient, these must hold:
//   - ledger coverage: the provider's own evidence of what was sent over the last 7 days (each sent
//     message's outreach_sent funnel event, which the send function writes beside the ledger row,
//     and each delivered event the provider webhook recorded) is matched to ledger rows by provider
//     and provider message id. With 20 or more such messages, at least 95% must have a ledger row,
//     or reply-based conclusions are blocked: replies would be credited against a short
//     denominator. Under 20 there is too little to judge, and nothing is blocked, unless the ledger
//     itself holds 20 or more sends for the window: then the evidence is missing, and that blocks;
//   - the product bridge: a product event (source "product" on the event spine) still unrouted 6
//     hours after it arrived blocks product-metric conclusions (sign-ups and later), because a
//     conversion may be missing;
//   - fail closed: a check that cannot be read blocks what it guards. measurementHealth never
//     throws, so a report always gets a verdict, and an unreadable one is a block.
import { EMAIL_EVENT_EFFECT } from "../sending/webhook.ts";
import { n } from "./sql.ts";
import { DAY_MS, HOUR_MS } from "./window.ts";

export const MIN_LEDGER_COVERAGE = 0.95;
export const MIN_SENDS_FOR_COVERAGE = 20;
export const COVERAGE_DAYS = 7;
export const BRIDGE_STUCK_HOURS = 6;
/** The event spine's source for events from the product being sold (docs/EVENT-CONTRACT.md). */
export const PRODUCT_EVENT_SOURCE = "product";

export interface LedgerCoverage {
  /** Distinct sent messages the provider evidence names in the window. */
  evidence: number;
  /** Of those, how many have a ledger row. */
  matched: number;
  /** matched / evidence, or null under MIN_SENDS_FOR_COVERAGE (too few to judge). */
  coverage: number | null;
  /** Outreach rows the ledger holds for the window. Evidence far below this means the evidence is missing, not the volume. */
  ledgerRows: number;
}

export interface MeasurementHealth {
  /** Null when the coverage could not be read. */
  ledger: LedgerCoverage | null;
  /** Product events unrouted for more than BRIDGE_STUCK_HOURS, or null when that could not be read. */
  bridgeUnrouted: number | null;
  /** Whether any product event has ever arrived (product metrics exist), or null when unreadable. */
  productEventsSeen: boolean | null;
  blocksReplyConclusions: boolean;
  blocksProductConclusions: boolean;
  /** Why conclusions are blocked, for the operator. Empty when healthy. */
  reasons: string[];
}

// Each delivered event is claimed in the effects ledger as "email:<provider>:<message id>:delivered".
const DELIVERED_SUFFIX = ":delivered";

/** Provider evidence over the window, matched to the ledger. Throws on a database error. */
export async function ledgerCoverage(db: D1Database, from: string, to: string): Promise<LedgerCoverage> {
  const row = await db
    .prepare(
      `WITH evidence AS (
         SELECT json_extract(fe.metadata, '$.provider') AS provider, json_extract(fe.metadata, '$.provider_message_id') AS message_id
           FROM funnel_events fe
          WHERE fe.event_type = 'outreach_sent' AND fe.source = 'agent' AND fe.occurred_at >= ?1 AND fe.occurred_at < ?2
            AND json_valid(fe.metadata)
         UNION
         SELECT substr(rest, 1, instr(rest, ':') - 1) AS provider,
                substr(rest, instr(rest, ':') + 1, length(rest) - instr(rest, ':') - ${DELIVERED_SUFFIX.length}) AS message_id
           FROM (SELECT substr(event_id, 7) AS rest FROM event_effects
                  WHERE effect = ?3 AND created_at >= ?1 AND created_at < ?2
                    AND substr(event_id, 1, 6) = 'email:' AND substr(event_id, -${DELIVERED_SUFFIX.length}) = '${DELIVERED_SUFFIX}')
          WHERE instr(rest, ':') > 1
       )
       SELECT COUNT(*) AS evidence,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM outreach_sends os WHERE os.provider_message_id = e.message_id AND os.provider = e.provider) THEN 1 ELSE 0 END) AS matched
         FROM evidence e
        WHERE e.provider IS NOT NULL AND e.provider <> '' AND e.message_id IS NOT NULL AND e.message_id <> ''`,
    )
    .bind(from, to, EMAIL_EVENT_EFFECT)
    .first<{ evidence: number | null; matched: number | null }>();
  const evidence = n(row?.evidence);
  const matched = n(row?.matched);
  const rows = await db
    .prepare("SELECT COUNT(*) AS n FROM outreach_sends WHERE sent_at >= ?1 AND sent_at < ?2")
    .bind(from, to)
    .first<{ n: number | null }>();
  return { evidence, matched, coverage: evidence >= MIN_SENDS_FOR_COVERAGE ? Math.min(1, matched / evidence) : null, ledgerRows: n(rows?.n) };
}

/** The verdict from what could be read. Pure. */
export function judgeHealth(input: { ledger: LedgerCoverage | null; bridgeUnrouted: number | null; productEventsSeen: boolean | null }): MeasurementHealth {
  const reasons: string[] = [];
  let blocksReply = false;
  if (input.ledger === null) {
    blocksReply = true;
    reasons.push("ledger coverage could not be read");
  } else if (input.ledger.coverage === null && input.ledger.ledgerRows >= MIN_SENDS_FOR_COVERAGE) {
    blocksReply = true;
    reasons.push(`the ledger holds ${input.ledger.ledgerRows} sends but the provider's evidence names only ${input.ledger.evidence} (sent events missing)`);
  } else if (input.ledger.coverage !== null && input.ledger.coverage < MIN_LEDGER_COVERAGE) {
    blocksReply = true;
    reasons.push(`the ledger holds ${input.ledger.matched} of ${input.ledger.evidence} sent messages (${Math.floor(input.ledger.coverage * 100)}%, needs ${Math.round(MIN_LEDGER_COVERAGE * 100)}%)`);
  }
  let blocksProduct = blocksReply;
  if (input.bridgeUnrouted === null) {
    blocksProduct = true;
    reasons.push("the product bridge's state could not be read");
  } else if (input.bridgeUnrouted > 0) {
    blocksProduct = true;
    reasons.push(`${input.bridgeUnrouted} product ${input.bridgeUnrouted === 1 ? "event is" : "events are"} unrouted after ${BRIDGE_STUCK_HOURS} hours`);
  }
  if (input.productEventsSeen === null) {
    blocksProduct = true;
    if (input.bridgeUnrouted !== null) reasons.push("whether product events exist could not be read");
  }
  return { ledger: input.ledger, bridgeUnrouted: input.bridgeUnrouted, productEventsSeen: input.productEventsSeen, blocksReplyConclusions: blocksReply, blocksProductConclusions: blocksProduct, reasons };
}

/** Measurement health at `now`. Never throws: whatever cannot be read blocks what it guards. */
export async function measurementHealth(db: D1Database, now: Date): Promise<MeasurementHealth> {
  const to = now.toISOString();
  const from = new Date(now.getTime() - COVERAGE_DAYS * DAY_MS).toISOString();
  const ledger = await ledgerCoverage(db, from, to).catch(() => null);
  const bridge = await db
    // The first read uses the unrouted index; the second stops at the first product event.
    .batch<{ n: number | null }>([
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE routed_at IS NULL AND received_at < ?2 AND source = ?1").bind(PRODUCT_EVENT_SOURCE, new Date(now.getTime() - BRIDGE_STUCK_HOURS * HOUR_MS).toISOString()),
      db.prepare("SELECT EXISTS (SELECT 1 FROM events WHERE source = ?1) AS n").bind(PRODUCT_EVENT_SOURCE),
    ])
    .then(([unrouted, seen]) => ({ unrouted: n(unrouted?.results[0]?.n), seen: n(seen?.results[0]?.n) > 0 }))
    .catch(() => null);
  const bridgeUnrouted = bridge === null ? null : bridge.unrouted;
  const productEventsSeen = bridge === null ? null : bridge.seen;
  return judgeHealth({ ledger, bridgeUnrouted, productEventsSeen });
}

/** A health result for when even the call failed: everything blocked. Pure. */
export function unreadableHealth(): MeasurementHealth {
  return judgeHealth({ ledger: null, bridgeUnrouted: null, productEventsSeen: null });
}

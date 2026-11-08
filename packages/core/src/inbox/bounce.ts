// GTM-agents: reading the failed recipient out of a delivery status notification in the mailbox.
//
// Three sources, in order of trust:
//   1. X-Failed-Recipients, which mail servers add to permanent failure reports. It is read only when
//      the caller passes trustFailedHeader: true, which it does only for a message shaped like a
//      report (a multipart/report content type, or report parts). That is a shape check, not
//      authentication: a sender controls both. What limits the damage is the caller acting only on
//      addresses it actually sent to, and only by suppressing them (never opting anyone out);
//   2. the machine-readable report (message/delivery-status, RFC 3464): each recipient block's
//      Final-Recipient (or Original-Recipient), Action and Status. A recipient is a permanent
//      failure when its Action is "failed" or its Status is 5.x.x; "delayed" and 4.x.x are temporary;
//   3. the returned message's own headers (text/rfc822-headers, or the header block of the
//      returned message): its To addresses, used only when the report says the delivery failed
//      permanently but names no recipient.
// Nothing is guessed: an address that does not parse is dropped, and a report with no parseable
// recipient comes back empty, so the caller records the bounce and skips it. Every source is
// untrusted (anyone can send a fake report), so the caller acts only on an address it actually
// sent to, and the action (suppression) can only send less.
import { normalizeAddress } from "../sending/suppression.ts";

/** The most recipients read from one report. */
export const MAX_BOUNCE_RECIPIENTS = 10;

export interface BounceInfo {
  /** Normalized addresses that failed permanently. */
  permanent: string[];
  /** Normalized addresses whose delivery is only delayed (temporary). */
  temporary: string[];
}

function addressesIn(value: string): string[] {
  const out: string[] = [];
  // A list of addresses, each possibly "Name <address>"; commas inside angle brackets do not occur.
  for (const part of value.split(/[,;]/)) {
    const bracketed = /<([^<>\s]+)>/.exec(part);
    const candidate = normalizeAddress(bracketed ? bracketed[1] : part.trim());
    if (candidate) out.push(candidate);
  }
  return out;
}

/** The address in a Final-Recipient or Original-Recipient value ("rfc822; jane@acme.example"). */
function recipientField(value: string): string | null {
  const semicolon = value.indexOf(";");
  const type = semicolon >= 0 ? value.slice(0, semicolon).trim().toLowerCase() : "rfc822";
  if (type !== "rfc822") return null;
  const address = (semicolon >= 0 ? value.slice(semicolon + 1) : value).trim().replace(/^<|>$/g, "");
  return normalizeAddress(address);
}

/** Header-style fields of one block: "Name: value", with folded continuation lines joined. */
function fields(block: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      const last = out[out.length - 1];
      if (last) last[1] = `${last[1]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) out.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return out;
}

/** Parse a delivery report. Pure; never throws. */
export function parseBounce(input: { headers: Readonly<Record<string, string>>; deliveryReport?: string | undefined; trustFailedHeader?: boolean }): BounceInfo {
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const failedHeader = input.headers["x-failed-recipients"];
  if (typeof failedHeader === "string" && input.trustFailedHeader === true) for (const address of addressesIn(failedHeader)) permanent.add(address);

  const report = typeof input.deliveryReport === "string" ? input.deliveryReport.slice(0, 64_000) : "";
  let reportSaysFailed = permanent.size > 0;
  let sawRecipient = false;
  const returnedTo: string[] = [];
  // Blocks are separated by blank lines: the per-message block, then one per recipient, then any
  // returned headers.
  for (const block of report.split(/\r?\n[ \t]*\r?\n/)) {
    const list = fields(block);
    const get = (name: string) => list.find(([k]) => k === name)?.[1];
    const recipient = recipientField(get("final-recipient") ?? get("original-recipient") ?? "");
    const action = (get("action") ?? "").toLowerCase();
    const status = get("status") ?? "";
    if (recipient) {
      sawRecipient = true;
      const failed = action.startsWith("failed") || /^5\.\d{1,3}\.\d{1,3}/.test(status);
      const delayed = action.startsWith("delayed") || /^4\.\d{1,3}\.\d{1,3}/.test(status);
      if (failed) {
        permanent.add(recipient);
        reportSaysFailed = true;
      } else if (delayed) temporary.add(recipient);
      continue;
    }
    if (action.startsWith("failed") || /^5\.\d{1,3}\.\d{1,3}/.test(status)) reportSaysFailed = true;
    const to = get("to");
    if (to && (get("from") !== undefined || get("subject") !== undefined || get("message-id") !== undefined)) returnedTo.push(...addressesIn(to));
  }
  if (permanent.size === 0 && reportSaysFailed && !sawRecipient) for (const address of returnedTo) permanent.add(address);
  for (const address of permanent) temporary.delete(address);
  return { permanent: [...permanent].slice(0, MAX_BOUNCE_RECIPIENTS), temporary: [...temporary].slice(0, MAX_BOUNCE_RECIPIENTS) };
}

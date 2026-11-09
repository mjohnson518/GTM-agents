// GTM-agents: the public job boards adapter: open roles on Greenhouse, Lever and Ashby boards, as
// counts per role kind.
//
// It reads only each vendor's documented public, unauthenticated board endpoint, on a fixed host and
// path, built here from a board token that must match /^[a-z0-9][a-z0-9-]{0,62}$/:
//   greenhouse  GET https://boards-api.greenhouse.io/v1/boards/<token>/jobs
//   lever       GET https://api.lever.co/v0/postings/<token>?mode=json
//   ashby       GET https://api.ashbyhq.com/posting-api/job-board/<token>
// No other URL is ever requested: the host is checked against that list before the call, redirects
// are not followed (a redirect reads as no board), and the token can never add a path segment, a
// query or a host. 404 is "no board"; other failures are AdapterErrors.
//
// Postings are classified into role kinds (ROLE_KINDS) here, from the posting's title and department,
// and only the counts leave the adapter: a posting title, a location or a description is never
// returned. The newest posting date is returned when the board reports one, with the board's public
// page for the signal's source URL. Reads are free; the cost reported is zero.
//
// No secrets and no options.
import { AdapterError, type AdapterContext, type Page, type Signal, type SignalSource } from "@gtm-agents/core/ports";
import { JOB_BOARDS, type BoardOpenings, type HiringBoardSource, type JobBoard, type RoleKind } from "@gtm-agents/core/signals";

export const NAME = "data-jobboards";
export const TOKEN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The only hosts this adapter ever requests. */
export const BOARD_HOSTS: Readonly<Record<JobBoard, string>> = Object.freeze({ greenhouse: "boards-api.greenhouse.io", lever: "api.lever.co", ashby: "api.ashbyhq.com" });
const PUBLIC_PAGES: Readonly<Record<JobBoard, string>> = Object.freeze({ greenhouse: "https://boards.greenhouse.io/", lever: "https://jobs.lever.co/", ashby: "https://jobs.ashbyhq.com/" });
/** Postings read from one board. */
export const MAX_POSTINGS = 2000;

/** The request URL for a board, or null when the token is not a valid token. Pure. */
export function boardUrl(board: JobBoard, token: string): string | null {
  if (!TOKEN.test(token) || !(JOB_BOARDS as readonly string[]).includes(board)) return null;
  const host = BOARD_HOSTS[board];
  if (board === "greenhouse") return `https://${host}/v1/boards/${token}/jobs`;
  if (board === "lever") return `https://${host}/v0/postings/${token}?mode=json`;
  return `https://${host}/posting-api/job-board/${token}`;
}

const RULES: ReadonlyArray<readonly [RoleKind, RegExp]> = [
  ["data", /\b(data|analytics|analyst|machine learning|ml|ai|scientist)\b/i],
  ["design", /\b(design|designer|ux|ui|researcher)\b/i],
  ["product", /\b(product manager|product owner|product lead|head of product|vp product|product)\b/i],
  ["engineering", /\b(engineer|engineering|developer|devops|sre|reliability|platform|infrastructure|security|qa|test|architect|programmer|software)\b/i],
  ["customer_success", /\b(customer success|support|account manager|implementation|onboarding|solutions)\b/i],
  ["sales", /\b(sales|account executive|business development|sdr|bdr|revenue)\b/i],
  ["marketing", /\b(marketing|growth|content|brand|communications|demand)\b/i],
  ["finance", /\b(finance|accounting|accountant|controller|payroll|tax)\b/i],
  ["people", /\b(recruit|recruiter|talent|people|hr|human resources)\b/i],
  ["legal", /\b(legal|counsel|compliance|paralegal|privacy)\b/i],
  ["operations", /\b(operations|ops|office|facilities|logistics|procurement)\b/i],
];

/** The role kind for a posting's title and department. Pure; the text is not kept. */
export function roleKind(title: unknown, department?: unknown): RoleKind {
  const text = [title, department].filter((v): v is string => typeof v === "string").join(" ").slice(0, 300);
  for (const [kind, pattern] of RULES) if (pattern.test(text)) return kind;
  return "other";
}

interface Posting {
  title?: unknown;
  department?: unknown;
  date?: number;
}

function postingsOf(board: JobBoard, body: unknown): Posting[] | null {
  const date = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined);
  if (board === "lever") {
    if (!Array.isArray(body)) return null;
    return body.map((p: Record<string, unknown>) => ({ title: p?.text, department: (p?.categories as Record<string, unknown> | undefined)?.team ?? (p?.categories as Record<string, unknown> | undefined)?.department, ...(date(p?.createdAt) !== undefined ? { date: date(p?.createdAt) } : {}) }));
  }
  const jobs = body && typeof body === "object" ? (body as { jobs?: unknown }).jobs : undefined;
  if (!Array.isArray(jobs)) return null;
  if (board === "greenhouse") {
    return jobs.map((p: Record<string, unknown>) => {
      const departments = Array.isArray(p?.departments) ? (p.departments as Array<{ name?: unknown }>).map((d) => d?.name).filter((n) => typeof n === "string").join(" ") : undefined;
      // first_published is when the posting went up; updated_at moves on any edit, so it is never a date.
      return { title: p?.title, department: departments, ...(date(p?.first_published) !== undefined ? { date: date(p?.first_published) } : {}) };
    });
  }
  return jobs
    .filter((p: Record<string, unknown>) => p?.isListed !== false)
    .map((p: Record<string, unknown>) => ({ title: p?.title, department: p?.department ?? p?.team, ...(date(p?.publishedAt) !== undefined ? { date: date(p?.publishedAt) } : {}) }));
}

/** Counts per role kind and the newest date. Pure. */
export function countPostings(postings: readonly Posting[], now: Date): Pick<BoardOpenings, "counts" | "total" | "latestPostedAt"> {
  const counts: Partial<Record<RoleKind, number>> = {};
  let latest: number | undefined;
  const list = postings.slice(0, MAX_POSTINGS);
  for (const p of list) {
    const kind = roleKind(p.title, p.department);
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (p.date !== undefined && p.date <= now.getTime() + 86_400_000 && (latest === undefined || p.date > latest)) latest = p.date;
  }
  return { counts, total: list.length, ...(latest !== undefined ? { latestPostedAt: new Date(latest).toISOString() } : {}) };
}

export type JobBoardsAdapter = HiringBoardSource & SignalSource;

export function createAdapter(ctx: AdapterContext): JobBoardsAdapter {
  async function openings(board: JobBoard, token: string): Promise<BoardOpenings> {
    const url = boardUrl(board, token);
    if (!url) throw new AdapterError("not a board token", "invalid", false);
    // Defense in depth: the URL was built from fixed parts, and the host is checked again here.
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== BOARD_HOSTS[board] || parsed.username || parsed.password || parsed.port) throw new AdapterError("refused a URL outside the board hosts", "invalid", false);
    let response: Response;
    try {
      response = await ctx.fetch(url, { method: "GET", headers: { accept: "application/json" }, redirect: "manual" });
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new AdapterError(timeout ? "job board timed out" : "job board could not be reached", timeout ? "timeout" : "unavailable", true, { cause: error });
    }
    const cost = { provider: NAME, capability: "board_read", usd: 0, units: 1 };
    if (response.status === 404 || response.status === 410 || (response.status >= 300 && response.status < 400) || response.status === 0) {
      response.body?.cancel().catch(() => undefined);
      return { status: "not_found", counts: {}, total: 0, cost };
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      const retryable = response.status === 429 || response.status >= 500;
      throw new AdapterError(`job board returned HTTP ${response.status}`, response.status === 429 ? "rate_limited" : retryable ? "unavailable" : "invalid", retryable);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new AdapterError("job board returned a body that is not JSON", "unknown", true, { cause: error });
    }
    const postings = postingsOf(board, body);
    if (!postings) throw new AdapterError("job board returned an unexpected shape", "unknown", false);
    return { status: "found", ...countPostings(postings, ctx.now()), boardUrl: `${PUBLIC_PAGES[board]}${token}`, cost };
  }

  return {
    name: NAME,
    openings,
    /**
     * The SignalSource view: for each account domain, the board token guessed from its first label on
     * each vendor, one hiring signal per board found with a dated posting. The summary is counts only.
     */
    async poll({ accountDomains = [], limit }): Promise<Page<Signal>> {
      const items: Signal[] = [];
      const retrievedAt = ctx.now().toISOString();
      for (const domain of accountDomains) {
        const token = domain.split(".")[0]?.toLowerCase() ?? "";
        if (!TOKEN.test(token)) continue;
        for (const board of JOB_BOARDS) {
          if (items.length >= limit) break;
          const found = await openings(board, token);
          if (found.status !== "found" || !found.latestPostedAt || !found.boardUrl) continue;
          items.push({
            type: "hiring",
            accountDomain: domain,
            occurredAt: found.latestPostedAt,
            summary: `${found.total} open roles`,
            url: found.boardUrl,
            evidence: [{ url: found.boardUrl, provider: NAME, retrievedAt }],
            providerRef: `${board}:${token}`,
          });
        }
      }
      return { items, cost: { provider: NAME, capability: "board_read", usd: 0, units: items.length } };
    },
  };
}

// GTM-agents: a recorded-response fetch for adapter contract tests.
//
// Contract tests are hermetic: an adapter gets this fetch through its AdapterContext, every request
// must match a recorded route, and an unmatched request fails the test instead of reaching the
// network. The calls are kept, so a test can assert what the adapter sent.

export interface RecordedRoute {
  method?: string;
  /** A full URL, or a RegExp tested against the full URL. */
  url: string | RegExp;
  /** The response to return, or a function that builds one from the request. */
  respond: Response | ((request: Request) => Response | Promise<Response>);
  /** Answer only this many times. Unlimited when omitted. */
  times?: number;
}

export interface RecordedFetch {
  fetch: typeof fetch;
  calls: Request[];
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
}

export function recordedFetch(routes: RecordedRoute[]): RecordedFetch {
  const calls: Request[] = [];
  const used = new Map<RecordedRoute, number>();
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push(request.clone());
    const route = routes.find((r) => {
      if (r.method && r.method.toUpperCase() !== request.method) return false;
      if (r.times !== undefined && (used.get(r) ?? 0) >= r.times) return false;
      return typeof r.url === "string" ? r.url === request.url : r.url.test(request.url);
    });
    if (!route) throw new Error(`no recorded response for ${request.method} ${request.url}`);
    used.set(route, (used.get(route) ?? 0) + 1);
    return typeof route.respond === "function" ? await route.respond(request) : route.respond.clone();
  };
  return { fetch: handler, calls };
}

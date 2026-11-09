// GTM-agents: the dashboard's hash routes. A route is a view name and, for a contact, its id.
// Ids are encoded into the fragment and decoded back, so a route can never leave the page.

export const VIEWS = [
  { name: "overview", label: "Overview" },
  { name: "cockpit", label: "GTM cockpit" },
  { name: "pipeline", label: "Pipeline" },
  { name: "inbound", label: "Inbound" },
  { name: "proposals", label: "Proposals" },
  { name: "learning", label: "Learning" },
  { name: "contacts", label: "Contacts" },
  { name: "agents", label: "Agents" },
  { name: "chat", label: "Chat" },
  { name: "activity", label: "Activity" },
  { name: "link-triage", label: "Link triage" },
  { name: "settings", label: "Settings" },
  { name: "changelog", label: "Changelog" },
] as const;

export type ViewName = (typeof VIEWS)[number]["name"];

export interface Route {
  view: ViewName;
  id?: string;
}

const NAMES = new Set<string>(VIEWS.map((view) => view.name));

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const [head = "", ...rest] = path.split("/");
  const view = NAMES.has(head) ? (head as ViewName) : "overview";
  if (view === "contacts" && rest.length > 0 && rest[0]) {
    try {
      return { view, id: decodeURIComponent(rest.join("/")) };
    } catch {
      return { view };
    }
  }
  return { view };
}

export function routeHash(route: Route): string {
  return route.id ? `#/${route.view}/${encodeURIComponent(route.id)}` : `#/${route.view}`;
}

export function navigate(route: Route): void {
  location.hash = routeHash(route);
}

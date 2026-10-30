import type { PlaygroundModule } from "@sdp/api-catalog/catalog";
import generatedCatalog from "@sdp/api-catalog/playground-catalog";
import type { ApiMethod } from "@sdp/api-catalog/reference";
import { resolveDashboardUrl } from "@/lib/dashboard-url";

const PLAYGROUND_PATHS = {
  wallets: "/dashboard/wallets",
  payments: "/dashboard/payments",
  counterparties: "/dashboard/payments",
  issuance: "/dashboard/issuance",
} as const satisfies Record<PlaygroundModule, string>;

type PlaygroundTarget = { section: PlaygroundModule; endpointId: string };

const PLAYGROUND_TARGETS = new Map<string, PlaygroundTarget>();
// SAFETY: PLAYGROUND_PATHS satisfies Record<PlaygroundModule, string> and has no extra keys.
for (const section of Object.keys(PLAYGROUND_PATHS) as PlaygroundModule[]) {
  for (const endpoint of generatedCatalog.modules[section]) {
    PLAYGROUND_TARGETS.set(`${endpoint.method} ${endpoint.path.split("?", 1)[0]}`, {
      section,
      endpointId: endpoint.id,
    });
  }
}

/** A catalog operation's dashboard landing URL, or null when the playground cannot run it. */
export function getPlaygroundHref(method: ApiMethod, path: string): string | null {
  const target = PLAYGROUND_TARGETS.get(`${method} ${path}`);
  if (target === undefined) return null;
  const dashboardUrl = resolveDashboardUrl();
  if (dashboardUrl === null) return null;

  const returnTo = `${PLAYGROUND_PATHS[target.section]}?${new URLSearchParams({
    tab: "playground",
    endpoint: target.endpointId,
  })}`;
  const landing = new URL("/dashboard", dashboardUrl);
  landing.searchParams.set("return_to", returnTo);
  return landing.toString();
}

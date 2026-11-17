import { DEFAULT_SDP_WEB_URL } from "@sdp/types/site";
import type { Nodes, Root } from "mdast";
import { resolveDashboardUrl } from "./dashboard-url";

const DEFAULT_DASHBOARD = new URL(DEFAULT_SDP_WEB_URL);

/** Where a reader creates an account or signs in: these follow the deployment the docs pair with. */
const ACCOUNT_PATHS = new Set(["/", "/sign-up", "/sign-in"]);

/**
 * Points the docs' account links at this build's own dashboard. A page links the production site
 * (`https://platform.solana.com`, `…/sign-up`); a build paired with another dashboard (beta, a
 * preview) rewrites the link to it, and a link text that names the production host names the
 * paired one. Every other link stays canonical: a docs page, and a dashboard page such as Go to
 * mainnet's, which only production serves.
 *
 * The paired dashboard is `resolveDashboardUrl()`, read when each page compiles.
 *
 * @returns The remark transformer.
 */
export function remarkDashboardLinks(): (tree: Root) => void {
  return (tree) => {
    const dashboardUrl = resolveDashboardUrl();
    if (dashboardUrl === null) return;
    const target = new URL(dashboardUrl);
    if (target.origin === DEFAULT_DASHBOARD.origin) return;
    visit(tree, target);
  };
}

function visit(node: Nodes, target: URL): void {
  if (node.type === "link") {
    const rewritten = rewrite(node.url, target);
    if (rewritten !== null) {
      node.url = rewritten;
      for (const child of node.children) {
        if (child.type === "text" && child.value === DEFAULT_DASHBOARD.host) {
          child.value = target.host;
        }
      }
    }
  }
  if ("children" in node) {
    for (const child of node.children) visit(child, target);
  }
}

/** The link on the paired dashboard, or null for any link but an account one. */
function rewrite(url: string, target: URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== DEFAULT_DASHBOARD.origin) return null;
  if (!ACCOUNT_PATHS.has(parsed.pathname)) return null;
  return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, target).toString();
}

import type { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
import type { Env } from "@/types/env";

export type ServedPathMatch = "exact" | "prefix";

// Path segments that group route families. A route's prefix is its deepest
// namespace plus one more segment.
const SERVED_PATH_NAMESPACES = [
  "/v1",
  "/v1/payments",
  "/internal",
  "/internal/dashboard",
  "/internal/dashboard/custody",
  "/webhooks",
  "/webhooks/payments",
  "/admin",
];

function isExactPath(path: string): boolean {
  return path === "/" || SERVED_PATH_NAMESPACES.includes(path) || /^\/[^/:*]+\.[^/]+$/.test(path);
}

function familyPrefixOf(path: string): string {
  const namespace = SERVED_PATH_NAMESPACES.filter((candidate) => path.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)
    .at(0);
  const namespaceSegments = namespace === undefined ? [] : namespace.split("/").slice(1);
  const family = path.split("/").slice(1, namespaceSegments.length + 2);
  const familySegment = family.at(-1);
  if (familySegment === undefined || familySegment === "" || /^[:*]/.test(familySegment)) {
    throw new Error(`${path} has no literal segment below ${namespace ?? "/"} to name its family`);
  }
  return `/${family.join("/")}`;
}

/**
 * The paths the app serves in any release channel, sorted: `/`, namespaces and
 * top-level files match exactly, every other route by its family prefix (the
 * prefix and anything below it). What `served-paths.generated.json` holds for
 * sdp-infra's public load balancers.
 */
export function servedPaths(app: Hono<{ Bindings: Env }>): Record<string, ServedPathMatch> {
  const matches = new Map<string, ServedPathMatch>();
  for (const { path, isMiddleware } of inspectRoutes(app)) {
    if (isMiddleware) {
      continue;
    }
    if (isExactPath(path)) {
      matches.set(path, "exact");
    } else {
      matches.set(familyPrefixOf(path), "prefix");
    }
  }
  return Object.fromEntries([...matches].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Shared by the route sweeps that check every project route refuses a project it must. */

/**
 * Routes that act on no project, so a project refusal has nothing to refuse.
 * Every other route must refuse a production project without the entitlement
 * (APE-351), and a sandbox project on a mainnet-only deployment. Each entry says why; a new route lands in this list
 * only on purpose.
 */
export const NO_PROJECT_ROUTES: readonly (readonly [RegExp, string])[] = [
  [/^\/(health|docs|openapi\.json|llms\.txt)?(\/|$)/, "public metadata"],
  [/^\/webhooks\//, "provider- or Clerk-signed inbound events; they finish money already moving"],
  [/^\/pay(\/|$)/, "public payment page; admits its own money movement (lib/money-admission.ts)"],
  [/^\/admin\//, "operator routes behind their own credential"],
  [/^\/v1\/(organizations|onboarding|places)(\/|$)/, "organization-scoped, no project"],
  [/^\/v1\/members(\/me)?$/, "membership reads and leaving, no project (ADR 0012)"],
  [
    /^\/v1\/members\/:memberId\/api-keys$/,
    "reads one member's keys across every project, so no single project (HOO-2301)",
  ],
  [/^\/internal\/dashboard\/network(\/|$)/, "chain-wide public figures; reads no tenant data"],
  [/^\/v1\/projects$/, "lists projects; hides production without the entitlement"],
  [
    /^\/v1\/issuance\/tokens\/:tokenId\/metadata\.json$/,
    "public token metadata that issued tokens point to on chain; serves, never acts",
  ],
];

export function probeMethod(method: string): string {
  return method === "ALL" ? "GET" : method;
}

/** A concrete URL: `:projectId` is the given project, every other param a placeholder. */
export function projectRoutePath(path: string, projectId: string): string {
  return path
    .replace(/:projectId(\{[^}]*\})?\??/g, projectId)
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, "x1")
    .replace(/\*/g, "x1");
}

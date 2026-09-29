import {
  COMPLIANCE_PROVIDERS,
  CUSTODY_PROVIDERS,
  EARN_PROVIDERS,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationProviderAvailabilityResponse,
  type ProviderAvailabilityEntry,
  RAMP_PROVIDERS,
} from "@sdp/types";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { PROJECT_COOKIE_NAME } from "../project-cookie";
import { isPaymentsPath, PAYMENTS_DEMO_COOKIE_NAME } from "./demo-cookie";
import { buildWorld, demoPathParts, demoWorldBody } from "./demo-fixtures";
import { type DemoAnswer, demoFlowRead, demoWrite } from "./demo-handlers";
import { applyDemoOps } from "./demo-replay";
import { appendDemoOps, readDemoOps } from "./demo-session";

/*
 * Demo mode: on the Payments screens of the project the demo cookie names, nothing about
 * payments reaches the SDP API. Reads come from the fixtures with the visitor's own actions
 * replayed over them; writes are checked as the API would, recorded in the browser's demo
 * session and answered with the result. Reads that aren't about payment data (the project, the
 * organization) still go to the API, and change nothing.
 */

/** Resources the demo owns: in demo mode these never reach the API, read or write. */
const DEMO_RESOURCES = new Set([
  "wallets",
  "payments",
  "transactions",
  "counterparties",
  "issuance",
  "compliance",
]);

/** Writes that only look something up (an address search), so they may still go out. */
const LOOKUP_WRITES = new Set(["places"]);

/**
 * Whether this request renders, or is fetched by, a Payments screen of the project the demo
 * cookie names. A page carries its own path (the proxy stamps `x-sdp-pathname`); a dashboard
 * API route counts only when a Payments page called it (its Referer). Everything else, the API
 * playground included, keeps real data. An organization-level read has no project of its own,
 * so it is judged by the project the dashboard has selected.
 */
const demoRequested = cache(async (projectId: string | null): Promise<boolean> => {
  try {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    const project = projectId ?? cookieStore.get(PROJECT_COOKIE_NAME)?.value ?? null;
    if (!project || cookieStore.get(PAYMENTS_DEMO_COOKIE_NAME)?.value !== project) {
      return false;
    }
    const pathname = headerStore.get("x-sdp-pathname");
    if (isPaymentsPath(pathname)) {
      return true;
    }
    if (!pathname?.startsWith("/api/dashboard/")) {
      return false;
    }
    const referer = headerStore.get("referer");
    return referer ? isPaymentsPath(new URL(referer).pathname) : false;
  } catch {
    // Outside a request there are no cookies or headers to read, so no demo.
    return false;
  }
});

function respond({ status, body }: DemoAnswer): Response {
  return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
}

function notInDemo(): Response {
  return Response.json(
    { error: { code: "not_found", message: "That isn't part of the demo." } },
    { status: 404 }
  );
}

function parseBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const PROVIDER_ON: ProviderAvailabilityEntry = { entitled: true, configured: true, enabled: true };

function allOn<T extends string>(providers: readonly T[]): Record<T, ProviderAvailabilityEntry> {
  return Object.fromEntries(providers.map((provider) => [provider, PROVIDER_ON])) as Record<
    T,
    ProviderAvailabilityEntry
  >;
}

/** Every provider on, for when the organization's own answer can't be read. */
function demoProviderAvailability(): OrganizationProviderAvailabilityResponse {
  return {
    tier: "enterprise",
    providers: {
      custody: allOn(CUSTODY_PROVIDERS),
      rpc: allOn(ORGANIZATION_RPC_PROVIDERS),
      compliance: allOn(COMPLIANCE_PROVIDERS),
      ramps: allOn(RAMP_PROVIDERS),
      earn: allOn(EARN_PROVIDERS),
    },
  };
}

/**
 * The organization's providers as the demo offers them: every ramp provider and address
 * screening on, whatever the plan, so every flow can be walked to its end. The rest is the
 * organization's real answer, or everything on when the API can't be reached.
 */
async function demoProviderAccess(upstream: () => Promise<Response>): Promise<Response> {
  const fallback = demoProviderAvailability();
  let json: { data?: Partial<OrganizationProviderAvailabilityResponse> } = {};
  try {
    const response = await upstream();
    if (response.ok) json = await response.json();
  } catch {
    // The API is down; the demo carries on with its own answer.
  }
  const real = json.data ?? {};
  const providers = { ...fallback.providers, ...real.providers };
  providers.ramps = fallback.providers.ramps;
  providers.compliance = { ...providers.compliance, range: PROVIDER_ON };
  return Response.json({ ...json, data: { ...fallback, ...real, providers } });
}

/**
 * The demo's answer to an SDP API request, or null to send it upstream. `upstream` sends it
 * for real, for the one read the demo adjusts rather than replaces.
 */
export async function paymentsDemoResponse(
  method: string,
  path: string,
  projectId: string | null,
  body: RequestInit["body"],
  upstream: () => Promise<Response>
): Promise<Response | null> {
  if (!(await demoRequested(projectId))) {
    return null;
  }
  const parts = demoPathParts(path);
  const verb = method.toUpperCase();
  if (parts === undefined) {
    return verb === "GET" ? null : notInDemo();
  }
  const [resource = ""] = parts.segments;
  const now = new Date();
  const ops = await readDemoOps();
  const world = applyDemoOps(buildWorld(now), ops, now);

  if (verb === "GET") {
    if (resource === "organizations" && parts.segments[2] === "provider-access") {
      return demoProviderAccess(upstream);
    }
    const fixture = demoWorldBody(world, path);
    if (fixture !== undefined) return Response.json(fixture);
    const flow = demoFlowRead(parts.segments, parts.params, world);
    if (flow) return respond(flow);
    return DEMO_RESOURCES.has(resource) || path.includes("demo_") ? notInDemo() : null;
  }

  if (LOOKUP_WRITES.has(resource)) {
    return null;
  }
  const parsedBody = parseBody(body);
  const result =
    parsedBody === undefined
      ? undefined
      : demoWrite(verb, { segments: parts.segments, body: parsedBody, world, ops, now });
  if (!result) {
    console.warn(JSON.stringify({ event: "payments_demo_unhandled_write", method: verb, path }));
    return Response.json(
      {
        error: {
          code: "payments_demo",
          message: "Demo mode doesn't cover this step. Turn off demo mode to do it for real.",
        },
      },
      { status: 409 }
    );
  }
  if (result.ops.length === 0) {
    return respond(result.answer(world));
  }
  const nextOps = await appendDemoOps(...result.ops);
  return respond(result.answer(applyDemoOps(buildWorld(now), nextOps, now)));
}

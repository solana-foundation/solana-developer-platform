import {
  COMPLIANCE_PROVIDERS,
  CUSTODY_PROVIDERS,
  EARN_PROVIDERS,
  type OrganizationProviderAvailabilityResponse,
  type ProviderAvailabilityEntry,
  // biome-ignore lint/style/noRestrictedImports: the keys of the availability record only; which ones are on comes from the channel-capped flags
  RAMP_PROVIDERS,
  type RampProviderId,
} from "@sdp/types";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { parseDashboardPathname } from "../dashboard-project-path";
import { designModuleForPath } from "../design-modules";
import { PROJECT_HEADER_NAME } from "../project-cookie";
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
 * so it is judged by the project of the request (its URL's or its header's).
 */
const demoRequested = cache(async (projectId: string | null): Promise<boolean> => {
  try {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    const project = projectId ?? headerStore.get(PROJECT_HEADER_NAME);
    if (!project || cookieStore.get(PAYMENTS_DEMO_COOKIE_NAME)?.value !== project) {
      return false;
    }
    // Page paths carry the project segment; the demo's route tables are written without it.
    const pathname = headerStore.get("x-sdp-pathname");
    const ownPage = pathname ? parseDashboardPathname(pathname).dashboardPath : null;
    const referer = pathname?.startsWith("/api/dashboard/") ? headerStore.get("referer") : null;
    const page = isPaymentsPath(ownPage)
      ? ownPage
      : referer
        ? parseDashboardPathname(new URL(referer).pathname).dashboardPath
        : null;
    if (!page || !isPaymentsPath(page)) {
      return false;
    }
    // Demo data is part of the new design and has a flag of its own: a page on the previous
    // design never gets it. Imported here, not at the top: the flags module reads auth through
    // sdp-api, which imports this file.
    const [{ paymentsDemoMode }, { isNewDesignOn }] = await Promise.all([
      import("@/flags"),
      import("@/flags/new-design"),
    ]);
    const [demoModeOn, newDesignPage] = await Promise.all([
      paymentsDemoMode(),
      isNewDesignOn(designModuleForPath(page) ?? undefined),
    ]);
    return demoModeOn && newDesignPage;
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

/**
 * Paths only the demo answers (Simulate verification): the SDP API has none of them, so outside
 * the demo they are refused here rather than sent upstream.
 */
function isDemoOnlyPath(path: string): boolean {
  const segments = demoPathParts(path)?.segments ?? [];
  return segments[0] === "payments" && segments[1] === "demo";
}

function onlyInDemo(): Response {
  return Response.json(
    { error: { code: "not_found", message: "Only demo mode answers this request." } },
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
const PROVIDER_OFF: ProviderAvailabilityEntry = {
  entitled: false,
  configured: false,
  enabled: false,
};

function allOn<T extends string>(providers: readonly T[]): Record<T, ProviderAvailabilityEntry> {
  return Object.fromEntries(providers.map((provider) => [provider, PROVIDER_ON])) as Record<
    T,
    ProviderAvailabilityEntry
  >;
}

/** Every provider on, but ramp providers only the ones the dashboard offers. */
function demoProviderAvailability(
  rampProviders: readonly RampProviderId[]
): OrganizationProviderAvailabilityResponse {
  return {
    tier: "enterprise",
    providers: {
      custody: allOn(CUSTODY_PROVIDERS),
      compliance: allOn(COMPLIANCE_PROVIDERS),
      ramps: Object.fromEntries(
        RAMP_PROVIDERS.map((provider) => [
          provider,
          rampProviders.includes(provider) ? PROVIDER_ON : PROVIDER_OFF,
        ])
      ) as Record<RampProviderId, ProviderAvailabilityEntry>,
      earn: allOn(EARN_PROVIDERS),
    },
  };
}

/**
 * The organization's providers as the demo offers them: every ramp provider the dashboard
 * offers and address screening on, whatever the plan, so every flow can be walked to its end. The rest is the
 * organization's real answer, or everything on when the API can't be reached.
 */
async function demoProviderAccess(
  upstream: () => Promise<Response>,
  rampProviders: readonly RampProviderId[]
): Promise<Response> {
  const fallback = demoProviderAvailability(rampProviders);
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
 * for real, for the one read the demo adjusts rather than replaces. A demo-only path is never
 * sent upstream, in the demo or out of it.
 */
export async function paymentsDemoResponse(
  method: string,
  path: string,
  projectId: string | null,
  body: RequestInit["body"],
  upstream: () => Promise<Response>
): Promise<Response | null> {
  if (!(await demoRequested(projectId))) {
    return isDemoOnlyPath(path) ? onlyInDemo() : null;
  }
  const parts = demoPathParts(path);
  const verb = method.toUpperCase();
  if (parts === undefined) {
    return verb === "GET" ? null : notInDemo();
  }
  const [resource = ""] = parts.segments;
  const now = new Date();
  const ops = await readDemoOps();
  // Imported here, not at the top, for the same reason as the flags in demoRequested.
  const { getEnabledRampProviders } = await import("@/flags/ramps");
  const rampProviders = await getEnabledRampProviders();
  const world = applyDemoOps(buildWorld(now, rampProviders), ops, now);

  if (verb === "GET") {
    if (resource === "organizations" && parts.segments[2] === "provider-access") {
      return demoProviderAccess(upstream, rampProviders);
    }
    const fixture = demoWorldBody(world, path);
    if (fixture !== undefined) return Response.json(fixture);
    const flow = demoFlowRead(parts.segments, parts.params, world, now);
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
  return respond(result.answer(applyDemoOps(buildWorld(now, rampProviders), nextOps, now)));
}

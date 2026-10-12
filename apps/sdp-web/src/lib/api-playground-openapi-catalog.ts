import { SDP_RELEASE_CHANNELS, type SdpModule, type SdpReleaseChannel } from "@sdp/types";
import type { ApiPlaygroundEndpointConfig } from "@/components/api-playground-shell";
import generatedCatalog from "./api-playground-catalog.generated.json";

type PlaygroundModule = "wallets" | "payments" | "counterparties" | "issuance";

type CatalogEndpointConfig = ApiPlaygroundEndpointConfig & {
  /** The SDP module that owns the route (apps/sdp-api/src/routes/route-modules.ts). */
  releaseModule: SdpModule | "core";
};

interface GeneratedPlaygroundCatalog {
  modules: Record<PlaygroundModule, CatalogEndpointConfig[]>;
  /** apps/sdp-api/src/routes/route-modules.ts, as `[pattern source, owner]`, first match wins. */
  routeOwners: [string, SdpModule | "core"][];
}

// JSON imports type tuples as plain arrays; the generator writes this shape.
const catalog = generatedCatalog as unknown as GeneratedPlaygroundCatalog;

function operationKey(endpoint: ApiPlaygroundEndpointConfig): string {
  return `${endpoint.method} ${endpoint.path.split("?", 1)[0]}`;
}

/** An operation key that ignores path parameter names, so curated forms match the catalog. */
function routeKey(endpoint: ApiPlaygroundEndpointConfig): string {
  return operationKey(endpoint).replace(/\{[^}/]*\}/g, "{}");
}

const RELEASE_MODULE_BY_ROUTE = new Map(
  Object.values(catalog.modules)
    .flat()
    .map((endpoint) => [routeKey(endpoint), endpoint.releaseModule] as const)
);

const ROUTE_OWNERS = catalog.routeOwners.map(
  ([pattern, owner]) => [new RegExp(pattern), owner] as const
);

/** The module that owns an endpoint: the catalog's, else the API's route ownership table. */
function releaseModuleOf(endpoint: ApiPlaygroundEndpointConfig): SdpModule | "core" | undefined {
  const known = RELEASE_MODULE_BY_ROUTE.get(routeKey(endpoint));
  if (known !== undefined) return known;
  const pattern = endpoint.path.split("?", 1)[0].replace(/\/\{([^}/]+)\}/g, "/:$1");
  return ROUTE_OWNERS.find(([owner]) => owner.test(pattern))?.[1];
}

/**
 * Drops every endpoint whose module is outside the deployment's release channel,
 * the catalog's operations and the hand-authored forms alike, so the playground
 * never offers a request the API refuses with 403. The catalog holds every
 * channel's operations; this is where a deployment narrows it.
 *
 * @param endpoints - The playground's endpoints.
 * @param releaseChannel - The deployment's release channel (`SDP_RELEASE_CHANNEL`).
 */
export function filterPlaygroundEndpointsToReleaseChannel(
  endpoints: ApiPlaygroundEndpointConfig[],
  releaseChannel: SdpReleaseChannel
): ApiPlaygroundEndpointConfig[] {
  const modules: readonly string[] = SDP_RELEASE_CHANNELS[releaseChannel];
  return endpoints.filter((endpoint) => {
    // Every API route is filed under a module (route-modules.test.ts), so a path no
    // module owns is not an API route the release channel could refuse.
    const releaseModule = releaseModuleOf(endpoint);
    return (
      releaseModule === undefined || releaseModule === "core" || modules.includes(releaseModule)
    );
  });
}

/**
 * Keeps the hand-authored forms for existing endpoints and fills every missing
 * operation from the public OpenAPI module catalog.
 */
export function mergeOpenApiPlaygroundEndpoints(
  module: PlaygroundModule,
  curatedEndpoints: ApiPlaygroundEndpointConfig[]
): ApiPlaygroundEndpointConfig[] {
  const curatedKeys = new Set(curatedEndpoints.map(operationKey));
  const missingEndpoints = catalog.modules[module].filter(
    (endpoint) => !curatedKeys.has(operationKey(endpoint))
  );

  return [...curatedEndpoints, ...missingEndpoints];
}

export function getOpenApiPlaygroundEndpoints(
  module: PlaygroundModule
): ApiPlaygroundEndpointConfig[] {
  return catalog.modules[module];
}

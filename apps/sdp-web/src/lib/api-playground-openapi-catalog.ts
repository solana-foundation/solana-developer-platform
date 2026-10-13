import {
  isRampProviderInReleaseChannel,
  type RampProviderId,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNELS,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types";
// biome-ignore lint/style/noRestrictedImports: validates the generated catalog's provider names; visibility comes from isRampProviderInReleaseChannel
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
} from "@/components/api-playground-shell";
import generatedCatalog from "./api-playground-catalog.generated.json";

type PlaygroundModule = "wallets" | "payments" | "counterparties" | "issuance";

type RouteOwner = SdpModule | "core";
type ValueGate = { module: SdpModule } | { rampProvider: RampProviderId };

interface GeneratedPlaygroundCatalog {
  modules: Record<PlaygroundModule, (ApiPlaygroundEndpointConfig & { releaseModule: string })[]>;
  /** apps/sdp-api/src/routes/route-modules.ts, first match wins. */
  routeOwners: { pattern: string; owner: string }[];
  /** apps/sdp-api/src/openapi/release-channel-values.ts: the owner of each module value. */
  valueGates: Record<string, { module?: string; rampProvider?: string }>;
}

// SAFETY: scripts/generate-playground-catalog.ts writes this file from the same
// shapes; JSON imports widen literal unions such as the HTTP method to string.
// Module and provider names are parsed below rather than trusted.
const catalog = generatedCatalog as GeneratedPlaygroundCatalog;

// The experimental channel runs every module by construction (release-channels.ts).
const SDP_MODULE_NAMES: ReadonlySet<string> = new Set(SDP_RELEASE_CHANNELS.experimental);
const RAMP_PROVIDER_NAMES: ReadonlySet<string> = new Set(RAMP_PROVIDERS);

function isSdpModule(value: string): value is SdpModule {
  return SDP_MODULE_NAMES.has(value);
}

function isRampProviderId(value: string): value is RampProviderId {
  return RAMP_PROVIDER_NAMES.has(value);
}

function parseRouteOwner(value: string): RouteOwner {
  if (value === "core" || isSdpModule(value)) return value;
  throw new Error(`Playground catalog names an unknown module: ${value}`);
}

function parseValueGate(gate: { module?: string; rampProvider?: string }): ValueGate {
  if (gate.module !== undefined && isSdpModule(gate.module)) return { module: gate.module };
  if (gate.rampProvider !== undefined && isRampProviderId(gate.rampProvider)) {
    return { rampProvider: gate.rampProvider };
  }
  throw new Error(`Playground catalog names an unknown value gate: ${JSON.stringify(gate)}`);
}

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
    .map((endpoint) => [routeKey(endpoint), parseRouteOwner(endpoint.releaseModule)] as const)
);

const ROUTE_OWNERS = catalog.routeOwners.map(
  ({ pattern, owner }) => [new RegExp(pattern), parseRouteOwner(owner)] as const
);

const VALUE_GATES = new Map(
  Object.entries(catalog.valueGates).map(([value, gate]) => [value, parseValueGate(gate)])
);

/** The module that owns an endpoint: the catalog's, else the API's route ownership table. */
function releaseModuleOf(endpoint: ApiPlaygroundEndpointConfig): RouteOwner | undefined {
  const known = RELEASE_MODULE_BY_ROUTE.get(routeKey(endpoint));
  if (known !== undefined) return known;
  const pattern = endpoint.path.split("?", 1)[0].replace(/\/\{([^}/]+)\}/g, "/:$1");
  return ROUTE_OWNERS.find(([owner]) => owner.test(pattern))?.[1];
}

type Published = (value: string) => boolean;

function publishedIn(releaseChannel: SdpReleaseChannel): Published {
  const modules: ReadonlySet<string> = new Set(SDP_RELEASE_CHANNELS[releaseChannel]);
  return (value) => {
    const gate = VALUE_GATES.get(value);
    if (gate === undefined) return true;
    if ("module" in gate) return modules.has(gate.module);
    return (
      modules.has("ramps") &&
      isRampProviderInReleaseChannel(releaseChannel, gate.rampProvider, SDP_RAMP_PROVIDER_STAGES)
    );
  };
}

/** An example response without values the channel does not run (the API prunes the same way). */
function pruneExample(value: unknown, published: Published): unknown {
  if (typeof value === "string") return published(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => pruneExample(entry, published))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.some(([, field]) => typeof field === "string" && !published(field))) {
      return undefined;
    }
    return Object.fromEntries(
      entries
        .map(([key, field]) => [key, pruneExample(field, published)] as const)
        .filter(([, field]) => field !== undefined)
    );
  }
  return value;
}

function pruneField(
  field: ApiPlaygroundFieldConfig,
  published: Published
): ApiPlaygroundFieldConfig {
  const options = field.options?.filter((option) => published(option.value));
  const keepDefault = field.defaultValue === undefined || published(field.defaultValue);
  return {
    ...field,
    ...(options === undefined ? {} : { options }),
    defaultValue: keepDefault ? field.defaultValue : options?.[0]?.value,
  };
}

/**
 * Drops every endpoint whose module is outside the deployment's release channel,
 * the catalog's operations and the hand-authored forms alike, so the playground
 * never offers a request the API refuses with 403. Inside the endpoints it
 * keeps, select options, defaults and example responses lose the values of
 * modules and ramp providers the channel does not run. The catalog holds every
 * channel's operations; this is where a deployment narrows it.
 *
 * @param endpoints - The playground's endpoints.
 * @param releaseChannel - The deployment's release channel (`SDP_RELEASE_CHANNEL`).
 */
export function filterPlaygroundEndpointsToReleaseChannel(
  endpoints: ApiPlaygroundEndpointConfig[],
  releaseChannel: SdpReleaseChannel
): ApiPlaygroundEndpointConfig[] {
  const modules: ReadonlySet<string> = new Set(SDP_RELEASE_CHANNELS[releaseChannel]);
  const published = publishedIn(releaseChannel);
  return endpoints
    .filter((endpoint) => {
      // Every API route is filed under a module (route-modules.test.ts), so a path no
      // module owns is not an API route the release channel could refuse.
      const releaseModule = releaseModuleOf(endpoint);
      return releaseModule === undefined || releaseModule === "core" || modules.has(releaseModule);
    })
    .map((endpoint) => ({
      ...endpoint,
      pathFields: endpoint.pathFields.map((field) => pruneField(field, published)),
      bodyFields: endpoint.bodyFields.map((field) => pruneField(field, published)),
      expectedResponse: pruneExample(endpoint.expectedResponse, published),
    }));
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

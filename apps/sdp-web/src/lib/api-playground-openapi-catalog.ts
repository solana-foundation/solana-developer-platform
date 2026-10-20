import type { RampProviderId } from "@sdp/types/provider-access";
// biome-ignore lint/style/noRestrictedImports: validates the generated catalog's provider names; visibility comes from isRampProviderInReleaseChannel
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import {
  isRampProviderInReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNELS,
  type SdpModule,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import { z } from "zod";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundMethod,
} from "@/components/api-playground-shell";
import generatedCatalog from "./api-playground-catalog.generated.json";

type PlaygroundModule = "wallets" | "payments" | "counterparties" | "issuance";

type RouteOwner = SdpModule | "core";
type ValueGate = { module: SdpModule } | { rampProvider: RampProviderId };

type GeneratedPlaygroundOperation = ApiPlaygroundEndpointConfig & {
  releaseModule: string;
  /** API routes whose literal segments win over this operation's parameters. */
  shadowedBy: string[];
};

interface GeneratedPlaygroundCatalog {
  modules: Record<PlaygroundModule, GeneratedPlaygroundOperation[]>;
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

/** A published operation, as the playground's proxy route and forms match it. */
export interface PlaygroundCatalogOperation {
  method: ApiPlaygroundMethod;
  /** The OpenAPI path template, without its query (`/v1/x/{id}`). */
  pathTemplate: string;
  releaseModule: RouteOwner;
}

/** A path template's segments: a `{name}` segment is a parameter, any other is literal. */
type TemplateSegment = { parameter: true } | { parameter: false; literal: string };

function templateSegments(pathTemplate: string): TemplateSegment[] {
  return pathTemplate
    .split("/")
    .map((segment) =>
      /^\{[^{}/]+\}$/.test(segment) ? { parameter: true } : { parameter: false, literal: segment }
    );
}

/**
 * Whether `pathname` is an instance of the template, segment for segment: a
 * parameter segment takes exactly one non-empty segment, every other segment
 * must be equal. Callers hand in a pathname that has already been through URL
 * parsing, so `..` and backslash segments are resolved before this compares.
 */
function matchesTemplate(segments: readonly TemplateSegment[], pathname: string): boolean {
  const parts = pathname.split("/");
  if (parts.length !== segments.length) return false;
  return segments.every((segment, index) => {
    const part = parts[index];
    return segment.parameter ? part !== "" : part === segment.literal;
  });
}

const CATALOG_OPERATIONS: readonly (PlaygroundCatalogOperation & {
  segments: readonly TemplateSegment[];
  shadows: readonly (readonly TemplateSegment[])[];
})[] = Object.values(catalog.modules)
  .flat()
  .map((endpoint) => {
    const pathTemplate = endpoint.path.split("?", 1)[0];
    return {
      method: endpoint.method,
      pathTemplate,
      releaseModule: parseRouteOwner(endpoint.releaseModule),
      segments: templateSegments(pathTemplate),
      shadows: endpoint.shadowedBy.map(templateSegments),
    };
  });

const VALUE_GATES = new Map(
  Object.entries(catalog.valueGates).map(([value, gate]) => [value, parseValueGate(gate)])
);

/**
 * The published playground operation `method pathname` is on `releaseChannel`,
 * or undefined. This is the playground's allowlist: the proxy route refuses
 * anything it does not return and the forms offer nothing it does not return,
 * so the two cannot disagree. The catalog holds the public OpenAPI document's
 * API-key operations (Earn held out), so an internal, admin or undocumented
 * route is never reachable through the playground.
 *
 * @param method - The HTTP method.
 * @param pathname - A concrete pathname (`/v1/x/abc`) or a form's template (`/v1/x/{id}`), no query.
 * @param releaseChannel - The deployment's release channel (`SDP_RELEASE_CHANNEL`).
 */
export function findPublishedPlaygroundOperation(
  method: string,
  pathname: string,
  releaseChannel: SdpReleaseChannel
): PlaygroundCatalogOperation | undefined {
  // A literal segment beats a parameter, as in the API's router: `/v1/wallets/configs`
  // is the configs read, not a wallet named "configs".
  const operation = CATALOG_OPERATIONS.filter(
    (candidate) => candidate.method === method && matchesTemplate(candidate.segments, pathname)
  ).sort((left, right) => parameterCount(left.segments) - parameterCount(right.segments))[0];
  if (operation === undefined) return undefined;
  // The API's router would send this path to a literal route instead, one the
  // catalog does not publish, so the request is not this operation.
  if (operation.shadows.some((shadow) => matchesTemplate(shadow, pathname))) return undefined;
  const modules: ReadonlySet<string> = new Set(SDP_RELEASE_CHANNELS[releaseChannel]);
  return operation.releaseModule === "core" || modules.has(operation.releaseModule)
    ? operation
    : undefined;
}

function parameterCount(segments: readonly TemplateSegment[]): number {
  return segments.filter((segment) => segment.parameter).length;
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

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Example responses are JSON (the catalog's, and the hand-authored forms'). */
const jsonSchema: z.ZodType<Json> = z.json();

/**
 * An example without values the channel does not run. Only the naming field
 * goes: catalog samples are synthesized from property examples, so dropping a
 * whole object would also drop, say, a plain transfer whose optional `provider`
 * example names a ramp provider.
 */
function pruneExample(value: Json, published: Published): Json | undefined {
  if (typeof value === "string") return published(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => pruneExample(entry, published))
      .filter((entry): entry is Json => entry !== undefined);
  }
  if (typeof value === "object" && value !== null) {
    const kept: { [key: string]: Json } = {};
    for (const [key, field] of Object.entries(value)) {
      const prunedField = pruneExample(field, published);
      if (prunedField !== undefined) kept[key] = prunedField;
    }
    return kept;
  }
  return value;
}

/** A JSON body default with the unpublished values pruned, formatted as the catalog writes it. */
function pruneJsonDefault(defaultValue: string, published: Published): string {
  const pruned = pruneExample(jsonSchema.parse(JSON.parse(defaultValue)), published);
  if (pruned === undefined) throw new Error("A JSON body default names only unpublished values");
  return JSON.stringify(pruned, null, 2);
}

/**
 * A field without the values the channel does not run, or undefined when the
 * field is a select with no option left (the API drops that parameter too).
 */
function pruneField(
  field: ApiPlaygroundFieldConfig,
  published: Published
): ApiPlaygroundFieldConfig | undefined {
  const options = field.options?.filter((option) => published(option.value));
  if (field.options !== undefined && field.options.length > 0 && options?.length === 0) {
    return undefined;
  }
  if (field.valueType === "json" && field.defaultValue !== undefined) {
    return { ...field, options, defaultValue: pruneJsonDefault(field.defaultValue, published) };
  }
  const keepDefault = field.defaultValue === undefined || published(field.defaultValue);
  return {
    ...field,
    options,
    defaultValue: keepDefault ? field.defaultValue : options?.[0]?.value,
  };
}

function pruneFields(
  fields: ApiPlaygroundFieldConfig[],
  published: Published
): ApiPlaygroundFieldConfig[] {
  return fields
    .map((field) => pruneField(field, published))
    .filter((field): field is ApiPlaygroundFieldConfig => field !== undefined);
}

/**
 * Drops every endpoint that is not a published catalog operation on the
 * deployment's release channel ({@link findPublishedPlaygroundOperation}), the
 * catalog's operations and the hand-authored forms alike, so the playground
 * never offers a request the proxy route or the API refuses. Inside the endpoints it
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
  const published = publishedIn(releaseChannel);
  return endpoints
    .filter(
      (endpoint) =>
        findPublishedPlaygroundOperation(
          endpoint.method,
          endpoint.path.split("?", 1)[0],
          releaseChannel
        ) !== undefined
    )
    .map((endpoint) => ({
      ...endpoint,
      pathFields: pruneFields(endpoint.pathFields, published),
      bodyFields: pruneFields(endpoint.bodyFields, published),
      expectedResponse: pruneExample(jsonSchema.parse(endpoint.expectedResponse), published),
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

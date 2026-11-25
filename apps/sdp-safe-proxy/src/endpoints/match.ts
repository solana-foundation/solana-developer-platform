import { SOLANA_CLUSTERS, type SolanaCluster } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import type { AllowedEndpoint } from "./endpoint";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "./providers";

export interface ProviderRequest {
  provider: string;
  cluster: string;
  method: string;
  path: string;
  body: string;
}

export type MatchResult =
  | {
      allowed: true;
      provider: SafeProxyProvider;
      cluster: SolanaCluster;
      host: string;
      endpoint: AllowedEndpoint;
    }
  | {
      allowed: false;
      code:
        | "provider_not_allowed"
        | "cluster_not_allowed"
        | "endpoint_not_allowed"
        | "body_not_allowed";
    };

type PatternSegment =
  | { is: "literal"; value: string }
  | { is: "parameter"; parameter: z.ZodType<string> };

const segmentsSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/));

function pathSegments(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const segments = segmentsSchema.safeParse(path.slice(1).split("/"));
  return segments.success ? segments.data : null;
}

function patternSegments(endpoint: AllowedEndpoint): PatternSegment[] {
  return endpoint.path
    .slice(1)
    .split("/")
    .map((segment) => {
      const name = /^\{(.+)\}$/.exec(segment)?.[1];
      return name === undefined
        ? { is: "literal", value: segment }
        : { is: "parameter", parameter: endpoint.parameters[name] };
    });
}

function segmentAccepts(pattern: PatternSegment, segment: string): boolean {
  return pattern.is === "literal"
    ? pattern.value === segment
    : pattern.parameter.safeParse(segment).success;
}

const querySchema = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[A-Za-z]+$/),
      value: z.string().regex(/^(?:[A-Za-z0-9._~*+-]|%[0-9A-Fa-f]{2})+$/),
    })
  )
  .refine((pairs) => new Set(pairs.map((pair) => pair.name)).size === pairs.length);

const providerSchema = z.enum(
  // SAFETY: Object.keys of a const object returns exactly its declared keys.
  Object.keys(SAFE_PROXY_PROVIDERS) as [SafeProxyProvider, ...SafeProxyProvider[]]
);

function queryNames(query: string): string[] | null {
  const pairs = querySchema.safeParse(
    query.split("&").map((pair) => {
      const [name, ...value] = pair.split("=");
      return { name, value: value.join("=") };
    })
  );
  return pairs.success ? pairs.data.map((pair) => pair.name) : null;
}

function pathMatches(endpoint: AllowedEndpoint, segments: string[], query: string[]): boolean {
  const pattern = patternSegments(endpoint);
  return (
    pattern.length === segments.length &&
    pattern.every((segment, index) => segmentAccepts(segment, segments[index])) &&
    query.every((name) => endpoint.query.includes(name))
  );
}

const jsonSchema = z.json();

function hasKeysEqualIgnoringCase(value: z.infer<typeof jsonSchema>): boolean {
  if (Array.isArray(value)) return value.some(hasKeysEqualIgnoringCase);
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value).map((key) => key.toLowerCase());
  return new Set(keys).size !== keys.length || Object.values(value).some(hasKeysEqualIgnoringCase);
}

function bodyAllowed(rule: z.ZodType, body: string): boolean {
  let parsed: z.infer<typeof jsonSchema>;
  try {
    parsed = jsonSchema.parse(JSON.parse(body));
  } catch {
    return false;
  }
  return (
    JSON.stringify(parsed) === body &&
    !hasKeysEqualIgnoringCase(parsed) &&
    rule.safeParse(parsed).success
  );
}

const clusterSchema = z.enum(SOLANA_CLUSTERS);

export function matchEndpoint(request: ProviderRequest): MatchResult {
  const provider = providerSchema.safeParse(request.provider);
  if (!provider.success) return { allowed: false, code: "provider_not_allowed" };
  const declared = SAFE_PROXY_PROVIDERS[provider.data];

  const cluster = clusterSchema.safeParse(request.cluster);
  const host = cluster.success ? declared.hosts[cluster.data] : null;
  if (!cluster.success || host === null) return { allowed: false, code: "cluster_not_allowed" };

  const queryStart = request.path.indexOf("?");
  const segments = pathSegments(
    queryStart === -1 ? request.path : request.path.slice(0, queryStart)
  );
  const query = queryStart === -1 ? [] : queryNames(request.path.slice(queryStart + 1));
  if (segments === null || query === null) return { allowed: false, code: "endpoint_not_allowed" };

  const candidates = declared.endpoints.filter(
    (endpoint) => endpoint.method === request.method && pathMatches(endpoint, segments, query)
  );
  if (candidates.length === 0) return { allowed: false, code: "endpoint_not_allowed" };

  const endpoint = candidates.find(
    (candidate) => candidate.body === undefined || bodyAllowed(candidate.body, request.body)
  );
  if (endpoint === undefined) return { allowed: false, code: "body_not_allowed" };

  return { allowed: true, provider: provider.data, cluster: cluster.data, host, endpoint };
}

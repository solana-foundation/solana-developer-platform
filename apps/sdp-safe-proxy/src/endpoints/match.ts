import { z } from "zod";
import type { AllowedEndpoint, BodyRule, PathParameter } from "./endpoint";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "./providers";

export interface ProviderRequest {
  provider: string;
  method: string;
  path: string;
  body: string;
}

export type MatchResult =
  | { allowed: true; provider: SafeProxyProvider; endpoint: AllowedEndpoint }
  | {
      allowed: false;
      code: "provider_not_allowed" | "endpoint_not_allowed" | "body_not_allowed";
    };

type PatternSegment =
  | { is: "literal"; value: string }
  | { is: "parameter"; parameter: PathParameter };

const segmentsSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/));

const FORMAT_PATTERNS = {
  digits: /^[0-9]{1,100}$/,
  token: /^[A-Za-z0-9_-]{1,255}$/,
} as const satisfies Record<Exclude<PathParameter["format"], "one_of">, RegExp>;

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

function parameterAccepts(parameter: PathParameter, segment: string): boolean {
  return parameter.format === "one_of"
    ? parameter.values.includes(segment)
    : FORMAT_PATTERNS[parameter.format].test(segment);
}

function segmentAccepts(pattern: PatternSegment, segment: string): boolean {
  return pattern.is === "literal"
    ? pattern.value === segment
    : parameterAccepts(pattern.parameter, segment);
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

function bodyAllowed(rule: BodyRule, body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (JSON.stringify(parsed) !== body) return false;
  const ruled = z.looseObject({ [rule.field]: z.enum(rule.values) }).safeParse(parsed);
  if (!ruled.success) return false;
  const field = rule.field.toLowerCase();
  return Object.keys(ruled.data).every((key) => key === rule.field || key.toLowerCase() !== field);
}

export function matchEndpoint(request: ProviderRequest): MatchResult {
  const provider = providerSchema.safeParse(request.provider);
  if (!provider.success) return { allowed: false, code: "provider_not_allowed" };

  const queryStart = request.path.indexOf("?");
  const segments = pathSegments(
    queryStart === -1 ? request.path : request.path.slice(0, queryStart)
  );
  const query = queryStart === -1 ? [] : queryNames(request.path.slice(queryStart + 1));
  if (segments === null || query === null) return { allowed: false, code: "endpoint_not_allowed" };

  const candidates = SAFE_PROXY_PROVIDERS[provider.data].endpoints.filter(
    (endpoint) => endpoint.method === request.method && pathMatches(endpoint, segments, query)
  );
  if (candidates.length === 0) return { allowed: false, code: "endpoint_not_allowed" };

  const endpoint = candidates.find(
    (candidate) => candidate.body === undefined || bodyAllowed(candidate.body, request.body)
  );
  if (endpoint === undefined) return { allowed: false, code: "body_not_allowed" };

  return { allowed: true, provider: provider.data, endpoint };
}

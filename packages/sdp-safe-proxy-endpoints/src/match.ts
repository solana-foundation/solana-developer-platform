import { z } from "zod";
import type { AllowedEndpoint, BodyRule } from "./endpoint";
import { pathSegments, patternSegments, segmentAccepts } from "./path-pattern";
import type { SafeProxyCode } from "./protocol";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "./providers";

export interface ProviderRequest {
  provider: string;
  method: string;
  // The request target as it will be sent: path, then an optional query.
  path: string;
  // The body as it will be sent; empty when the request has none.
  body: string;
}

export type MatchResult =
  | { allowed: true; provider: SafeProxyProvider; endpoint: AllowedEndpoint }
  | {
      allowed: false;
      code: Extract<
        SafeProxyCode,
        "provider_not_allowed" | "endpoint_not_allowed" | "body_not_allowed"
      >;
    };

const QUERY_PAIR = /^([A-Za-z]+)=((?:[A-Za-z0-9._~*+-]|%[0-9A-Fa-f]{2})+)$/;

const providerSchema = z.enum(
  // SAFETY: Object.keys of a const object returns exactly its declared keys.
  Object.keys(SAFE_PROXY_PROVIDERS) as [SafeProxyProvider, ...SafeProxyProvider[]]
);

function queryNames(query: string): string[] | null {
  const names: string[] = [];
  for (const pair of query.split("&")) {
    const name = QUERY_PAIR.exec(pair)?.[1];
    if (name === undefined || names.includes(name)) return null;
    names.push(name);
  }
  return names;
}

function pathMatches(endpoint: AllowedEndpoint, segments: string[], query: string[]): boolean {
  const pattern = patternSegments(endpoint);
  return (
    pattern.length === segments.length &&
    pattern.every((segment, index) => segmentAccepts(segment, segments[index])) &&
    query.every((name) => endpoint.query.includes(name))
  );
}

// A body is read only in the form JSON.stringify writes, so the field checked
// here is the only field of that name the provider can see.
function bodyAllowed(rule: BodyRule, body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (JSON.stringify(parsed) !== body) return false;
  return z.looseObject({ [rule.field]: z.enum(rule.values) }).safeParse(parsed).success;
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

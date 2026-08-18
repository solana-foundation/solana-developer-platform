import type { OrganizationRpcProvider } from "@sdp/types";
import {
  applyApiKeyTemplate,
  withAlchemyApiKey,
  withHeliusApiKey,
  withOptionalApiKeyTemplate,
} from "./config";
import { SdpRpcError } from "./errors";

/**
 * A tenant supplies the same pair the operator supplies today: an endpoint and
 * a key. `resolveManagedProviders` reads `SOLANA_RPC_<PROVIDER>_URL` plus
 * `SOLANA_RPC_<PROVIDER>_API_KEY` and applies a per-provider rule; BYOK applies
 * the identical rule to credentials the organization owns.
 *
 * The endpoint is required rather than derived from a built-in vendor URL:
 * QuickNode, Triton and Validation Cloud endpoints are account-specific, and
 * guessing a host for the others would put traffic somewhere nobody chose.
 */
export interface TenantRpcCredential {
  /** May carry the `{API_KEY}` placeholder the platform templates already use. */
  endpointUrl: string;
  apiKey: string;
}

export interface TenantRpcTarget {
  endpoint: string;
  headers: Record<string, string>;
}

/** `default` is SDP's own platform-managed rail — it has no tenant credential. */
export type ByokRpcProvider = Exclude<OrganizationRpcProvider, "default">;

export const BYOK_RPC_PROVIDERS: readonly ByokRpcProvider[] = [
  "alchemy",
  "helius",
  "nodit",
  "quicknode",
  "triton",
  "validationcloud",
];

export function isByokRpcProvider(value: string): value is ByokRpcProvider {
  return (BYOK_RPC_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Hosts a tenant endpoint may never point at.
 *
 * Activation and the relay both fetch whatever URL the tenant stored, so
 * without this a connection could aim SDP's server at loopback, a private
 * range, or a cloud metadata service and read back coarse reachability from the
 * status and timing. Blocking at submission keeps such a row from existing.
 *
 * Literal-address matching only: a hostname that resolves to a private address
 * still passes here, which is the deeper hardening HOO-1009 covers.
 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // 169.254.0.0/16 covers the 169.254.169.254 metadata address.
  /^169\.254\./,
  /\.internal$/i,
  /\.local$/i,
];

/**
 * IPv6 literals, tested against the bracket-stripped host.
 *
 * `URL.hostname` returns an IPv6 literal still wrapped in brackets
 * (`https://[fd00::1]/` -> `"[fd00::1]"`), so a pattern anchored with `^fd`
 * silently matches nothing. Stripping first is what makes these anchors mean
 * what they read as.
 */
const BLOCKED_IPV6_PATTERNS: RegExp[] = [
  // Loopback, in the compressed form the URL parser always normalises to.
  /^::1$/,
  // Unspecified address: on many stacks a connect() to it reaches loopback.
  /^::$/,
  // fc00::/7 unique local. Exactly four hex digits: a shorter group such as
  // `fd0:` is 0x0fd0, a different address that must not be caught here.
  /^f[cd][0-9a-f]{2}:/i,
  // fe80::/10 link local, which is where the IPv6 metadata endpoint lives.
  /^fe[89ab][0-9a-f]:/i,
];

/**
 * The host with IPv6 brackets removed, lowercased.
 *
 * `URL` also rewrites an IPv4-mapped literal into hex (`::ffff:127.0.0.1`
 * becomes `::ffff:7f00:1`), so the mapped IPv4 tail is expanded back to dotted
 * quad before the IPv4 patterns run — otherwise loopback re-enters as hex.
 */
function normalizeHost(hostname: string): { host: string; mappedIpv4: string | null } {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) {
    return { host, mappedIpv4: null };
  }

  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return {
    host,
    mappedIpv4: [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
  };
}

export function assertReachableTenantEndpoint(endpointUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new SdpRpcError("BAD_REQUEST", "The RPC endpoint is not a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new SdpRpcError("BAD_REQUEST", "An RPC endpoint must use https");
  }

  const { host, mappedIpv4 } = normalizeHost(parsed.hostname);
  const candidates = mappedIpv4 ? [host, mappedIpv4] : [host];

  if (
    BLOCKED_IPV6_PATTERNS.some((pattern) => pattern.test(host)) ||
    candidates.some((candidate) => BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(candidate)))
  ) {
    throw new SdpRpcError("BAD_REQUEST", "That RPC endpoint host is not reachable from SDP");
  }
}

/**
 * Build the outbound target for a tenant-owned credential. Pure on purpose:
 * the relay and the activation check must construct targets the same way, and
 * neither should need a database or a secret store to do it.
 */
export function buildTenantRpcTarget(
  provider: ByokRpcProvider,
  credential: TenantRpcCredential
): TenantRpcTarget {
  const endpointUrl = credential.endpointUrl.trim();
  const apiKey = credential.apiKey.trim();

  if (!endpointUrl) {
    throw new SdpRpcError("BAD_REQUEST", "A tenant RPC connection requires an endpoint URL");
  }
  if (!apiKey) {
    throw new SdpRpcError("BAD_REQUEST", "A tenant RPC connection requires an API key");
  }

  switch (provider) {
    case "helius":
      return { endpoint: withHeliusApiKey(endpointUrl, apiKey), headers: {} };
    case "alchemy":
      return { endpoint: withAlchemyApiKey(endpointUrl, apiKey), headers: {} };
    case "quicknode":
    case "nodit":
      return { endpoint: withOptionalApiKeyTemplate(endpointUrl, apiKey), headers: {} };
    // Triton authenticates by header; the key must not also be templated into
    // the URL, where it would end up in logs that only redact query strings.
    case "triton":
      return {
        endpoint: applyApiKeyTemplate(endpointUrl, apiKey),
        headers: { "x-api-key": apiKey },
      };
    case "validationcloud":
      return { endpoint: applyApiKeyTemplate(endpointUrl, apiKey), headers: {} };
  }
}

/**
 * Redact a tenant endpoint for display. The platform's `maskEndpoint` only
 * knows the operator's own env keys, so a tenant key would survive it.
 */
export function maskTenantEndpoint(endpoint: string, apiKey: string): string {
  const key = apiKey.trim();
  let masked = endpoint;
  if (key) {
    masked = masked.replaceAll(key, "***");
    const encoded = encodeURIComponent(key);
    if (encoded !== key) {
      masked = masked.replaceAll(encoded, "***");
    }
  }

  try {
    const parsed = new URL(masked);
    for (const name of parsed.searchParams.keys()) {
      if (name.toLowerCase().includes("key") || name.toLowerCase().includes("token")) {
        parsed.searchParams.set(name, "***");
      }
    }
    return parsed.toString();
  } catch {
    return masked;
  }
}

/**
 * What is safe to show about a stored connection. Never the endpoint with its
 * key applied — only the host and a short suffix so an admin can tell two
 * credentials apart.
 */
export function buildTenantDisplayMetadata(
  credential: TenantRpcCredential
): Record<string, string> {
  const metadata: Record<string, string> = {};
  try {
    metadata.endpointHost = new URL(credential.endpointUrl).host;
  } catch {
    // An unparseable URL is caught by validation before storage; display
    // metadata must not be the thing that fails a submission.
  }
  const key = credential.apiKey.trim();
  if (key.length > 4) {
    metadata.apiKeySuffix = key.slice(-4);
  }
  return metadata;
}

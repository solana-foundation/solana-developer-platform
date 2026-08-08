// Outbound webhook URL safety (SSRF).
//
// `send_webhook` makes the workflow engine fetch an issuer-supplied URL from inside the
// cluster, and the HTTP status lands in the execution log — which turns a naive fetch
// into a readable internal port scanner and a path to the cloud metadata endpoint.
//
// Two layers:
//   * `checkWebhookUrlSyntax` — synchronous, no DNS. Used by the save-time zod schema so
//     an issuer gets immediate feedback and obviously-bad URLs never reach storage.
//   * `resolveWebhookUrl` — adds DNS resolution, run immediately before each fetch. This
//     is the actual security boundary: the save-time check can't see where a hostname
//     points, and the answer can change between save and send.
//
// A DNS-rebinding attacker can still flip a public hostname to a private address in the
// window between our lookup and the runtime's own connect. Closing that needs a
// pinned-IP connect (custom agent/socket), which is out of scope here; the metadata
// endpoint and every literal private address are blocked either way.

import { lookup } from "node:dns/promises";

export type WebhookUrlRejection =
  | "INVALID_URL"
  | "INSECURE_SCHEME"
  | "PRIVATE_HOST"
  | "UNRESOLVABLE_HOST";

export type WebhookUrlResult = { ok: true; url: URL } | { ok: false; reason: WebhookUrlRejection };

// Hostnames that never legitimately receive an issuer webhook. `.internal` covers GCP's
// metadata alias (metadata.google.internal); `.local` is mDNS.
const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || // "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, incl. the 169.254.169.254 metadata endpoint
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast + reserved + broadcast
  );
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms tunnel a v4 address.
  const mapped = value.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) {
    return isPrivateIpv4(mapped[1]);
  }
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") || // unique local fc00::/7
    value.startsWith("fd") ||
    value.startsWith("fe8") || // link-local fe80::/10
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("ff") // multicast
  );
}

export function isPrivateAddress(address: string): boolean {
  return address.includes(":") ? isPrivateIpv6(address) : isPrivateIpv4(address);
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return true;
  }
  // A single-label host ("intranet") can only resolve inside the cluster's search domain.
  return !host.includes(".") && !isPrivateAddress(host);
}

// Save-time check: scheme + literal-address + hostname denylist. No DNS.
export function checkWebhookUrlSyntax(raw: string): WebhookUrlResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }
  // https only: the delivery carries holder wallets and counterparty ids, and the HMAC
  // signature is worthless if the body itself is readable in transit.
  if (url.protocol !== "https:") {
    return { ok: false, reason: "INSECURE_SCHEME" };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(hostname) || isBlockedHostname(hostname)) {
    return { ok: false, reason: "PRIVATE_HOST" };
  }
  return { ok: true, url };
}

// Runtime check: everything above, plus every address the hostname resolves to.
export async function resolveWebhookUrl(raw: string): Promise<WebhookUrlResult> {
  const syntax = checkWebhookUrlSyntax(raw);
  if (!syntax.ok) {
    return syntax;
  }
  const hostname = syntax.url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateAddress(hostname)) {
    return { ok: false, reason: "PRIVATE_HOST" };
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "UNRESOLVABLE_HOST" };
  }
  if (resolved.length === 0 || resolved.some((entry) => isPrivateAddress(entry.address))) {
    return { ok: false, reason: resolved.length === 0 ? "UNRESOLVABLE_HOST" : "PRIVATE_HOST" };
  }
  return { ok: true, url: syntax.url };
}

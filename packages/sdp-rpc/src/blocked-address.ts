import { isIP } from "node:net";
import { SdpRpcError } from "./errors";

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0)) {
    // Not a dotted quad we can reason about; refuse rather than guess.
    return true;
  }

  const [a, b] = octets as [number, number, number, number];

  if (a === 0 || a === 127) return true; // this host, loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, including the metadata address
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved, 255.255.255.255 included

  return false;
}

function isBlockedIpv6(address: string): boolean {
  const host =
    address
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";

  // An IPv4-mapped address is an IPv4 destination wearing IPv6 notation, so it
  // is classified as one. Node can hand this back in either spelling.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped?.[1]) {
    return isBlockedIpv4(mapped[1]);
  }
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(host)) {
    const parts = host.split(":");
    const high = Number.parseInt(parts[3] ?? "", 16);
    const low = Number.parseInt(parts[4] ?? "", 16);
    if (Number.isInteger(high) && Number.isInteger(low)) {
      return isBlockedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].map(String).join("."));
    }
    return true;
  }

  if (host === "::" || host === "::1") return true; // unspecified, loopback
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // link-local
  if (/^ff[0-9a-f]{2}:/.test(host)) return true; // multicast

  // Further prefixes embed an IPv4 address in their last 32 bits, so the
  // embedded address is classified as IPv4: the deprecated IPv4-compatible
  // (`::a.b.c.d`) and IPv4-translated (`::ffff:0:a.b.c.d`) forms, and NAT64
  // (`64:ff9b::/96`), which a dual-stack host routes to a real IPv4 target.
  // The local-use NAT64 prefix (`64:ff9b:1::/48`) embeds its IPv4 at a
  // different offset and is not classified here.
  const groups = parseIpv6Groups(host);
  if (groups) {
    for (const prefix of EMBEDDED_IPV4_PREFIXES) {
      const embedded = embeddedIpv4(groups, prefix);
      if (embedded !== null && isBlockedIpv4(embedded)) {
        return true;
      }
    }
  }

  return false;
}

/** Prefixes whose last 32 bits carry an embedded IPv4 address, as 16-bit groups. */
const EMBEDDED_IPV4_PREFIXES: readonly (readonly number[])[] = [
  [0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000], // ::/96 (deprecated IPv4-compatible)
  [0x0000, 0x0000, 0x0000, 0x0000, 0xffff, 0x0000], // ::ffff:0:0/96 (deprecated IPv4-translated)
  [0x0064, 0xff9b, 0x0000, 0x0000, 0x0000, 0x0000], // 64:ff9b::/96 (NAT64 well-known)
];

/** The eight 16-bit groups of one expanded IPv6 address. */
type Ipv6Groups = readonly [number, number, number, number, number, number, number, number];

/**
 * Expand a textual IPv6 address into its eight 16-bit groups, or null when it
 * is not an IPv6 address Node could have canonicalised. Accepts the compressed
 * `::` form and an optional trailing dotted-quad (`::127.0.0.1`).
 */
function parseIpv6Groups(host: string): Ipv6Groups | null {
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = parseIpv6GroupList(halves[0] ?? "");
  const tail = parseIpv6GroupList(halves.length === 2 ? (halves[1] ?? "") : "");
  if (head === null || tail === null) return null;

  const fill = 8 - head.length - tail.length;
  // Without `::` the explicit groups must be exactly eight; with it, at least one.
  if (fill < 0 || (halves.length === 1 && fill !== 0) || (halves.length === 2 && fill === 0)) {
    return null;
  }
  // The fill check above makes head, fill and tail total exactly eight groups,
  // so each name below is a present group.
  const [g0, g1, g2, g3, g4, g5, g6, g7] = [...head, ...Array<number>(fill).fill(0), ...tail];
  return [g0, g1, g2, g3, g4, g5, g6, g7];
}

/** Parse one `::`-free run of groups; the last may be a dotted quad. */
function parseIpv6GroupList(run: string): readonly number[] | null {
  if (run === "") return [];
  const parts = run.split(":");
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(part);
    if (dotted?.[1]) {
      // A dotted quad may only appear as the final group pair.
      if (index !== parts.length - 1) return null;
      const octets = dotted.slice(1).map(Number);
      if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null;
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      return groups;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/** The address's last 32 bits as a dotted quad when the address carries `prefix`, else null. */
function embeddedIpv4(groups: Ipv6Groups, prefix: readonly number[]): string | null {
  for (const [index, group] of prefix.entries()) {
    if (groups[index] !== group) return null;
  }
  const high = groups[6];
  const low = groups[7];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].map(String).join(".");
}

/**
 * Whether SDP refuses to open a connection to this address. Shared by the
 * write-time endpoint check (`assertReachableTenantEndpoint` below) and the
 * connect-time egress guard in sdp-api, so a URL that passes submission cannot
 * name an address the transport then refuses, and the transport cannot dial
 * one submission would have blocked.
 *
 * @param address - A literal IPv4 or IPv6 address.
 * @returns Whether the address is loopback, private, link-local or otherwise blocked.
 */
export function isBlockedAddress(address: string): boolean {
  return address.includes(":") ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/**
 * Names a tenant endpoint may never point at.
 *
 * SDP fetches whatever URL a tenant stores (the Helius Rings tenant RPC URL),
 * so without this a tenant could aim SDP's server at loopback, a private range,
 * or a cloud metadata service and read back coarse reachability from the status
 * and timing. Blocking at submission keeps such a row from existing.
 *
 * Name matching only: the URL parser canonicalises every literal-address
 * spelling, and those go through `isBlockedAddress`, the same classification
 * the egress guard applies at connect time. A hostname that resolves to a
 * private address passes here and is caught by that guard instead.
 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.internal$/i,
  /\.local$/i,
];

/**
 * The host with IPv6 brackets removed, lowercased.
 *
 * `URL` also rewrites an IPv4-mapped literal into hex (`::ffff:127.0.0.1`
 * becomes `::ffff:7f00:1`), so the mapped IPv4 tail is expanded back to dotted
 * quad before the IPv4 patterns run — otherwise loopback re-enters as hex.
 *
 * @param hostname - `URL.hostname` of the submitted endpoint.
 * @returns The normalized host, and its dotted-quad form when it is an IPv4-mapped IPv6 literal.
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

/**
 * Reject a tenant-supplied RPC URL that is not https, embeds credentials, or names a blocked host.
 *
 * @param endpointUrl - The URL the tenant submitted.
 * @throws SdpRpcError `BAD_REQUEST` naming the rule the URL breaks.
 */
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

  if (parsed.username || parsed.password) {
    throw new SdpRpcError("BAD_REQUEST", "An RPC endpoint URL must not embed credentials");
  }

  const { host, mappedIpv4 } = normalizeHost(parsed.hostname);
  const candidates = mappedIpv4 ? [host, mappedIpv4] : [host];

  if (
    candidates.some(
      (candidate) =>
        BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(candidate)) ||
        (isIP(candidate) !== 0 && isBlockedAddress(candidate))
    )
  ) {
    throw new SdpRpcError("BAD_REQUEST", "That RPC endpoint host is not reachable from SDP");
  }
}

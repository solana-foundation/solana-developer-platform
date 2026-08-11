import { BlockList, isIP } from "node:net";

type IpType = "ipv4" | "ipv6";

interface ParsedIpRange {
  address: string;
  groups: number[];
  prefix: number;
  type: IpType;
}

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts) {
    // `010.0.0.1` is octal to some resolvers, decimal to others — reject, don't guess.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }

  return octets;
}

/** Numeric hextets for a colon-separated group list, expanding a trailing dotted quad. */
function toHextets(parts: readonly string[]): number[] | null {
  const hextets: number[] = [];

  for (const [index, part] of parts.entries()) {
    if (part.includes(".")) {
      // An embedded IPv4 quad is only valid as the final group.
      if (index !== parts.length - 1) {
        return null;
      }
      const octets = parseIpv4Octets(part);
      if (!octets) {
        return null;
      }
      hextets.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return null;
    }
    hextets.push(Number.parseInt(part, 16));
  }

  return hextets;
}

function parseIpv6Hextets(address: string): number[] | null {
  const elision = address.indexOf("::");

  if (elision === -1) {
    const hextets = toHextets(address.split(":"));
    return hextets?.length === 8 ? hextets : null;
  }

  if (address.includes("::", elision + 1)) {
    return null;
  }

  const headText = address.slice(0, elision);
  const tailText = address.slice(elision + 2);
  const head = toHextets(headText.length > 0 ? headText.split(":") : []);
  const tail = toHextets(tailText.length > 0 ? tailText.split(":") : []);
  if (!head || !tail) {
    return null;
  }

  const elided = 8 - head.length - tail.length;
  if (elided < 1) {
    return null;
  }

  return [...head, ...Array.from({ length: elided }, () => 0), ...tail];
}

function parseIpRange(value: string): ParsedIpRange | null {
  if (value.length === 0 || value !== value.trim()) {
    return null;
  }

  const segments = value.split("/");
  if (segments.length > 2) {
    return null;
  }

  const address = segments[0];
  // Zone identifiers are meaningful only on the local host and are not valid
  // request-origin restrictions.
  if (address.includes("%")) {
    return null;
  }

  const type: IpType = address.includes(":") ? "ipv6" : "ipv4";
  const groups = type === "ipv4" ? parseIpv4Octets(address) : parseIpv6Hextets(address);
  if (!groups) {
    return null;
  }

  const maximumPrefix = type === "ipv4" ? 32 : 128;
  const rawPrefix = segments[1];
  if (rawPrefix === undefined) {
    return { address, groups, prefix: maximumPrefix, type };
  }

  if (!/^(0|[1-9]\d*)$/.test(rawPrefix)) {
    return null;
  }

  const prefix = Number(rawPrefix);
  if (prefix > maximumPrefix) {
    return null;
  }

  return { address, groups, prefix, type };
}

export function isValidIpAllowlistEntry(value: string): boolean {
  return parseIpRange(value) !== null;
}

/** Zero every bit past the prefix, so a range names the network it selects. */
function maskGroups(groups: readonly number[], bitsPerGroup: number, prefix: number): number[] {
  const width = (1 << bitsPerGroup) - 1;

  return groups.map((group, index) => {
    const significant = Math.min(Math.max(prefix - index * bitsPerGroup, 0), bitsPerGroup);
    if (significant === 0) {
      return 0;
    }
    return group & ((width << (bitsPerGroup - significant)) & width);
  });
}

/** RFC 5952: lowercase, no leading zeros, longest run of zero hextets elided. */
function formatIpv6(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;

  for (let index = 0; index <= hextets.length; index++) {
    if (index < hextets.length && hextets[index] === 0) {
      if (runStart === -1) {
        runStart = index;
      }
      continue;
    }

    if (runStart !== -1) {
      const length = index - runStart;
      // Strictly greater keeps the leftmost of two equal runs, as RFC 5952 requires.
      if (length > bestLength) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }

  const groups = hextets.map((hextet) => hextet.toString(16));

  // A single zero hextet is written out; `::` is only for a run of two or more.
  if (bestLength < 2) {
    return groups.join(":");
  }

  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

function isIpv4Mapped(hextets: readonly number[]): boolean {
  return hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
}

function formatRange(address: string, prefix: number, maximumPrefix: number): string {
  return prefix === maximumPrefix ? address : `${address}/${prefix}`;
}

/**
 * Rewrite a valid entry into the form that means what it enforces. BlockList
 * already tolerates the variants at match time; this is for the operator
 * reviewing the stored list — `203.0.113.5/24` reads as one host but
 * authorizes 256. Null for anything {@link isValidIpAllowlistEntry} rejects.
 */
export function canonicalizeIpAllowlistEntry(value: string): string | null {
  const parsed = parseIpRange(value);
  if (!parsed) {
    return null;
  }

  if (parsed.type === "ipv4") {
    return formatRange(maskGroups(parsed.groups, 8, parsed.prefix).join("."), parsed.prefix, 32);
  }

  const masked = maskGroups(parsed.groups, 16, parsed.prefix);

  // Below /96 the range escapes the IPv4-mapped space and must stay IPv6.
  if (parsed.prefix >= 96 && isIpv4Mapped(masked)) {
    const octets = [masked[6] >> 8, masked[6] & 0xff, masked[7] >> 8, masked[7] & 0xff];
    return formatRange(octets.join("."), parsed.prefix - 96, 32);
  }

  return formatRange(formatIpv6(masked), parsed.prefix, 128);
}

/** node's `isIP` result narrowed to the BlockList family labels. */
function clientIpType(value: string): IpType | null {
  switch (isIP(value)) {
    case 4:
      return "ipv4";
    case 6:
      return "ipv6";
    default:
      return null;
  }
}

/**
 * Return whether a trusted client IP satisfies an API key's configured ranges.
 *
 * Null and empty allowlists preserve unrestricted keys. Any missing client IP
 * or malformed persisted restriction fails closed.
 */
export function isClientIpAllowed(clientIp: string | null, allowedIps: unknown): boolean {
  if (allowedIps === null || allowedIps === undefined) {
    return true;
  }
  if (!Array.isArray(allowedIps)) {
    return false;
  }
  if (allowedIps.length === 0) {
    return true;
  }
  if (!clientIp || clientIp.includes("%")) {
    return false;
  }

  const clientType = clientIpType(clientIp);
  if (!clientType) {
    return false;
  }

  const blockList = new BlockList();
  try {
    for (const entry of allowedIps) {
      if (typeof entry !== "string") {
        return false;
      }
      const parsed = parseIpRange(entry);
      if (!parsed) {
        return false;
      }
      blockList.addSubnet(parsed.address, parsed.prefix, parsed.type);
    }
  } catch {
    return false;
  }

  return blockList.check(clientIp, clientType);
}

import { BlockList, isIP } from "node:net";

type IpVersion = 4 | 6;
type IpType = "ipv4" | "ipv6";

interface ParsedIpRange {
  address: string;
  prefix: number;
  type: IpType;
}

function parseIpRange(value: string): ParsedIpRange | null {
  if (value.length === 0 || value !== value.trim()) {
    return null;
  }

  const segments = value.split("/");
  if (segments.length > 2) {
    return null;
  }

  const address = segments[0] ?? "";
  // Zone identifiers are meaningful only on the local host and are not valid
  // request-origin restrictions.
  if (address.includes("%")) {
    return null;
  }

  const version = isIP(address) as IpVersion | 0;
  if (version === 0) {
    return null;
  }

  const maximumPrefix = version === 4 ? 32 : 128;
  const rawPrefix = segments[1];
  if (rawPrefix === undefined) {
    return {
      address,
      prefix: maximumPrefix,
      type: version === 4 ? "ipv4" : "ipv6",
    };
  }

  if (!/^(0|[1-9]\d*)$/.test(rawPrefix)) {
    return null;
  }

  const prefix = Number(rawPrefix);
  if (prefix > maximumPrefix) {
    return null;
  }

  return {
    address,
    prefix,
    type: version === 4 ? "ipv4" : "ipv6",
  };
}

export function isValidIpAllowlistEntry(value: string): boolean {
  return parseIpRange(value) !== null;
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

  const clientVersion = isIP(clientIp) as IpVersion | 0;
  if (clientVersion === 0) {
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

  return blockList.check(clientIp, clientVersion === 4 ? "ipv4" : "ipv6");
}

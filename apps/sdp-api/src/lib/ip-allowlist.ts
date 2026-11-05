import { BlockList, isIP } from "node:net";
import { type IpType, parseIpRange } from "@sdp/ip/ip-range";

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

/**
 * Address classification shared by the write-time endpoint check
 * (`assertReachableTenantEndpoint`) and the connect-time egress guard in
 * sdp-api. One list, so a URL that passes submission cannot name an address
 * the transport then refuses, and the transport cannot dial one submission
 * would have blocked.
 */

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

  return false;
}

/** Whether SDP refuses to open a connection to this address. */
export function isBlockedAddress(address: string): boolean {
  return address.includes(":") ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

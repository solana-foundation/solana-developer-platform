/**
 * Outbound HTTPS for endpoints a tenant supplies.
 *
 * `assertReachableTenantEndpoint` rejects a URL whose host is written as a
 * private literal, which is only half the boundary: a name the tenant controls
 * can resolve to a loopback, private, link-local or metadata address and the
 * literal check never sees it. The guard here runs at connect time and hands
 * the socket only addresses that passed, so a record that changes between the
 * check and the connection cannot widen it either.
 *
 * It applies to tenant endpoints alone. Platform provider endpoints come from
 * deployment config and are legitimately private in local development and in
 * the Surfpool integration suites, so those keep the ordinary fetch.
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

export class EgressBlockedError extends Error {
  constructor(host: string) {
    super(`The RPC endpoint host ${host} resolves to an address SDP will not connect to`);
    this.name = "EgressBlockedError";
  }
}

/** Statuses the Response constructor refuses a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

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

/** Whether SDP refuses to open a connection to this resolved address. */
export function isBlockedAddress(address: string): boolean {
  return address.includes(":") ? isBlockedIpv6(address) : isBlockedIpv4(address);
}

/**
 * A `dns.lookup` replacement that drops every blocked address before the
 * socket sees it. Node calls this while connecting, so the addresses it
 * returns are the ones actually dialled.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...(options as object), all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }

    const resolved = Array.isArray(addresses) ? addresses : [addresses];
    const allowed = resolved.filter((entry) => !isBlockedAddress(entry.address));
    if (allowed.length === 0) {
      callback(new EgressBlockedError(hostname), "", 0);
      return;
    }

    if (typeof options === "object" && options?.all) {
      (callback as (error: null, addresses: typeof allowed) => void)(null, allowed);
      return;
    }

    const [first] = allowed;
    callback(null, first?.address ?? "", first?.family ?? 0);
  });
};

export interface GuardedFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Same shape as a `fetch` call the caller would otherwise make, minus redirect
 * following: `node:https` does not follow one, which is the behaviour the
 * probe already asked for.
 */
export async function guardedFetch(url: string, init: GuardedFetchInit): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw new EgressBlockedError(target.hostname);
  }

  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      target,
      { method: init.method, headers: init.headers, lookup: guardedLookup },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(", "));
          }
          const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks).toString();
          resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
        });
      }
    );

    req.on("error", reject);
    req.end(init.body);
  });
}

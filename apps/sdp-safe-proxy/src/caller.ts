import { type CallerIdentity, CallerIdentityError } from "@sdp/metadata-server/receiver";
import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import { LOCAL_CALLER_HEADER } from "@sdp/safe-proxy-endpoints/protocol";
import { z } from "zod";
import { Refusal } from "./app";

type IdentifyCaller = (headers: Headers) => Promise<SafeProxyCaller>;

// On Cloud Run: the caller is the service account its Google identity token names.
export function createTokenCallerCheck(options: {
  verify: (authorizationHeader: string | undefined) => Promise<CallerIdentity>;
  callerEmails: Record<SafeProxyCaller, string>;
}): IdentifyCaller {
  return async (headers) => {
    let identity: CallerIdentity;
    try {
      identity = await options.verify(headers.get("authorization") ?? undefined);
    } catch (error) {
      if (!(error instanceof CallerIdentityError)) throw error;
      throw new Refusal(
        error.code === "keys_unavailable" ? "caller_check_unavailable" : "unauthenticated"
      );
    }
    const caller = SAFE_PROXY_CALLERS.find((name) => options.callerEmails[name] === identity.email);
    if (caller === undefined) throw new Refusal("caller_not_allowed");
    return caller;
  };
}

const localCaller = z.enum(SAFE_PROXY_CALLERS);

// Locally: the caller addresses the loopback address and port the entry listens on, and names
// itself.
export function createLocalCallerCheck(listensOn: {
  hostname: string;
  port: number;
}): IdentifyCaller {
  const host = `${listensOn.hostname}:${listensOn.port}`;
  return async (headers) => {
    const caller = localCaller.safeParse(headers.get(LOCAL_CALLER_HEADER));
    if (headers.get("host") !== host || !caller.success) throw new Refusal("unauthenticated");
    return caller.data;
  };
}

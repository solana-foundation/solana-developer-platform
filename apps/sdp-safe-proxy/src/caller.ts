import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "@sdp/safe-proxy-endpoints/callers";
import type { SafeProxyCode } from "@sdp/safe-proxy-endpoints/protocol";
import {
  type CallerIdentity,
  CallerIdentityError,
  type CallerIdentityErrorCode,
} from "@sdp/service-call/caller-identity";
import { Refusal } from "./refusal";

export interface IdentifiedCaller {
  caller: SafeProxyCaller;
  // null when the caller was identified without a token (the local entry).
  tokenAgeSeconds: number | null;
}

export type IdentifyCaller = (headers: Headers) => Promise<IdentifiedCaller>;

function refusalCode(code: CallerIdentityErrorCode): SafeProxyCode {
  switch (code) {
    case "missing_token":
    case "invalid_token":
      return "unauthenticated";
    case "keys_unavailable":
      return "caller_check_unavailable";
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

export function createTokenCallerCheck(options: {
  verify: (authorizationHeader: string | undefined) => Promise<CallerIdentity>;
  callerEmails: Record<SafeProxyCaller, string>;
  now: () => number;
}): IdentifyCaller {
  const callerByEmail = new Map(
    SAFE_PROXY_CALLERS.map((caller) => [options.callerEmails[caller], caller])
  );

  return async (headers) => {
    let identity: CallerIdentity;
    try {
      identity = await options.verify(headers.get("authorization") ?? undefined);
    } catch (error) {
      if (error instanceof CallerIdentityError) throw new Refusal(refusalCode(error.code));
      throw error;
    }

    const caller = callerByEmail.get(identity.email);
    if (caller === undefined) throw new Refusal("caller_not_allowed");
    return {
      caller,
      tokenAgeSeconds: Math.floor(options.now() / 1000) - identity.issuedAt,
    };
  };
}

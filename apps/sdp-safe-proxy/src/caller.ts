import { SAFE_PROXY_CALLERS, type SafeProxyCaller } from "@sdp/safe-proxy-catalog/catalog";
import { SafeProxyError } from "@sdp/safe-proxy-catalog/errors";
import {
  CallerIdentityError,
  createCallerIdentityVerifier,
} from "@sdp/service-call/caller-identity";
import { z } from "zod";
import type { Settings } from "@/settings";

type CallerVerifierOptions = Parameters<typeof createCallerIdentityVerifier>[0];

export const LOCAL_CALLER_HEADER = "x-safe-proxy-local-caller";

export type CallerCredentials = {
  authorization: string | undefined;
  localCaller: string | undefined;
};

/** Says which service is calling, or throws `caller_not_allowed`. */
export type ResolveCaller = (credentials: CallerCredentials) => Promise<SafeProxyCaller>;

const localCallerSchema = z.enum(SAFE_PROXY_CALLERS);

function notAllowed(): SafeProxyError {
  return new SafeProxyError({ code: "caller_not_allowed", outcome: "rejected" });
}

export function createCallerResolver(
  settings: Settings,
  /** The keys identity tokens are checked against. Google's published keys when omitted. */
  keys?: CallerVerifierOptions["keys"]
): ResolveCaller {
  if (settings.callerAuth === "local") {
    // A developer's machine has no identity token. The server listens on loopback only in this
    // mode, and the caller names itself.
    return async ({ localCaller }) => {
      const caller = localCallerSchema.safeParse(localCaller);
      if (!caller.success) {
        throw notAllowed();
      }
      return caller.data;
    };
  }

  const verify = createCallerIdentityVerifier({ audience: settings.audience, keys });
  const callerByEmail = new Map<string, SafeProxyCaller>([
    [settings.callerEmails.api, "api"],
    [settings.callerEmails.cron, "cron"],
  ]);

  return async ({ authorization }) => {
    let email: string;
    try {
      ({ email } = await verify(authorization));
    } catch (error) {
      if (error instanceof CallerIdentityError) {
        throw notAllowed();
      }
      throw error;
    }
    const caller = callerByEmail.get(email);
    if (caller === undefined) {
      throw notAllowed();
    }
    return caller;
  };
}

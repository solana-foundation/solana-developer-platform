import { SAFE_PROXY_CALLERS } from "@sdp/safe-proxy-endpoints/callers";
import { LOCAL_CALLER_HEADER } from "@sdp/safe-proxy-endpoints/protocol";
import { z } from "zod";
import type { IdentifyCaller } from "./caller";
import { Refusal } from "./refusal";

const localCaller = z.enum(SAFE_PROXY_CALLERS);

export function assertNotOnCloudRun(env: Record<string, string | undefined>): void {
  if (env.K_SERVICE !== undefined) {
    throw new Error("the local entry does not run on Cloud Run: K_SERVICE is set");
  }
}

export const identifyLocalCaller: IdentifyCaller = async (headers) => {
  const caller = localCaller.safeParse(headers.get(LOCAL_CALLER_HEADER));
  if (!caller.success) throw new Refusal("unauthenticated");
  return { caller: caller.data, tokenAgeSeconds: null };
};

import { Agent, setGlobalDispatcher } from "undici";
import { getLogger } from "@/runtime/logger";

/**
 * The pool behind every outbound `fetch` of an API or job process. An idle
 * socket stays open 19 s, past the ~16 s Treasury refresh and under a Solana
 * RPC node's 20 s idle close, so a steady refresh reuses its sockets instead of
 * opening new ones (each closed socket holds a Cloud NAT port for 120 s). A
 * server's Keep-Alive hint still sets the idle time, less 2 s and at most 60 s.
 * Like Node's default pool it has no per-origin socket cap: a cap would queue
 * sends and builds behind a burst of reads to the same RPC.
 */
const OUTBOUND_DISPATCHER_OPTIONS = {
  keepAliveTimeout: 19_000,
  keepAliveMaxTimeout: 60_000,
} as const;

/**
 * The undici major this Agent comes from. Node's `fetch` runs on the undici it
 * bundles and drives whatever global dispatcher is set, so the Agent is only
 * installed on a runtime that bundles the same major.
 */
const PAIRED_UNDICI_MAJOR = 7;

let skipLogged = false;

export function createOutboundDispatcher(): Agent {
  return new Agent(OUTBOUND_DISPATCHER_OPTIONS);
}

/**
 * Install once at process boot, before the first outbound request. On any
 * other undici major, Node's default pool stays and the skip is logged once.
 */
export function installOutboundDispatcher(
  runtimeUndici: string | undefined = process.versions.undici
): Agent | undefined {
  if (Number(runtimeUndici?.split(".")[0]) !== PAIRED_UNDICI_MAJOR) {
    if (!skipLogged) {
      skipLogged = true;
      getLogger().warn(
        { runtimeUndici: runtimeUndici ?? null, pairedUndiciMajor: PAIRED_UNDICI_MAJOR },
        "outbound dispatcher not installed: runtime undici major differs, Node's default pool stays"
      );
    }
    return undefined;
  }
  const dispatcher = createOutboundDispatcher();
  setGlobalDispatcher(dispatcher);
  return dispatcher;
}

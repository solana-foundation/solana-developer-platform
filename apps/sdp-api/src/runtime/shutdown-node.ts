/**
 * Node SIGTERM/SIGINT shutdown sequence.
 *
 * Lives separately from server.ts so unit tests can exercise the lifecycle
 * order without pulling in the full Hono app graph (routes, SDKs, etc.).
 *
 * Order matters:
 *   1. server.close — stop accepting new requests; finish in-flight ones.
 *      Anything those requests fire-and-forget via bg.run is already
 *      tracked, so the registration window stays open.
 *   2. cron.stop — block any future tick from scheduling new work.
 *      A tick that fires synchronously with stop() still registers its
 *      promise with bg.run before this call returns.
 *   3. bg.awaitAll — drain everything registered above. NodeBackgroundRunner
 *      seals after this returns, so any straggler bg.run is refused (and
 *      warned) rather than silently leaked.
 *   4. closeAllRedisClients — only after bg drain, so in-flight Redis
 *      commands aren't racing a client.quit() call.
 *   5. closeDatabasePools — last; the pg client is per-query so this is
 *      a cache clear, not a connection drain.
 */

import type { CronHandle } from "@/cron/runner";
import { closeDatabasePools } from "@/db/client";
import type { BackgroundRunner } from "./background";
import { closeAllRedisClients } from "./kv-redis";

export interface Closable {
  close(callback: (err?: Error) => void): void;
  // http.Server.close() stops accepting new connections but lets existing
  // idle keep-alive sockets time out on their own — minutes by default
  // behind a typical load balancer. closeIdleConnections() (Node >= 18.2)
  // drops idle sockets immediately so close() resolves on in-flight work
  // alone. Optional so test mocks and older runtimes still satisfy the
  // contract.
  closeIdleConnections?(): void;
}

export interface ShutdownDeps {
  server: Closable;
  cron: CronHandle | null;
  bg: BackgroundRunner;
  log: (msg: string) => void;
}

export async function shutdown(deps: ShutdownDeps): Promise<void> {
  deps.log("closing HTTP listener");
  await new Promise<void>((resolve, reject) => {
    deps.server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
    // Drop idle keep-alive sockets right after the close() request so the
    // server-side socket count drains immediately; in-flight requests run
    // to completion before close() resolves.
    deps.server.closeIdleConnections?.();
  });
  if (deps.cron) {
    deps.log("stopping cron scheduler");
    await deps.cron.stop();
  }
  deps.log("draining background tasks");
  await deps.bg.awaitAll();
  deps.log("closing Redis clients");
  await closeAllRedisClients();
  deps.log("closing database pools");
  await closeDatabasePools();
}

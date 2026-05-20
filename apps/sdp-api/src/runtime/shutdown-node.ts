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

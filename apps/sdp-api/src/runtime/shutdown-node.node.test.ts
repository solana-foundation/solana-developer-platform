import { beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "@/db/client";
import type { BackgroundRunner } from "./background";
import * as kvRedis from "./kv-redis";
import { shutdown } from "./shutdown-node";

vi.mock("./kv-redis", () => ({
  closeAllRedisClients: vi.fn(async () => {}),
}));

vi.mock("@/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/client")>();
  return { ...actual, closeDatabasePools: vi.fn(async () => {}) };
});

type Closable = { close: (cb: (err?: Error) => void) => void };

function makeServer(closeImpl?: (cb: (err?: Error) => void) => void): Closable {
  return {
    close: vi.fn(closeImpl ?? ((cb: (err?: Error) => void) => cb())),
  };
}

function makeBg(awaitImpl?: () => Promise<void>): BackgroundRunner {
  return {
    run: vi.fn(),
    awaitAll: vi.fn(awaitImpl ?? (async () => {})),
    draining: false,
  };
}

describe("shutdown", () => {
  beforeEach(() => {
    vi.mocked(kvRedis.closeAllRedisClients).mockReset().mockResolvedValue(undefined);
    vi.mocked(dbClient.closeDatabasePools).mockReset().mockResolvedValue(undefined);
  });

  it("runs lifecycle in order: server.close → cron.stop → bg.awaitAll → closeAllRedisClients → closeDatabasePools", async () => {
    const calls: string[] = [];
    const server = makeServer((cb) => {
      calls.push("server.close");
      cb();
    });
    const cron = {
      stop: vi.fn(() => {
        calls.push("cron.stop");
      }),
    };
    const bg = makeBg(async () => {
      calls.push("bg.awaitAll");
    });
    vi.mocked(kvRedis.closeAllRedisClients).mockImplementation(async () => {
      calls.push("closeAllRedisClients");
    });
    vi.mocked(dbClient.closeDatabasePools).mockImplementation(async () => {
      calls.push("closeDatabasePools");
    });

    await shutdown({ server, cron, bg, log: () => {} });

    expect(calls).toEqual([
      "server.close",
      "cron.stop",
      "bg.awaitAll",
      "closeAllRedisClients",
      "closeDatabasePools",
    ]);
  });

  it("waits for server.close callback before stopping cron", async () => {
    let serverClosed = false;
    const server = makeServer((cb) => {
      setTimeout(() => {
        serverClosed = true;
        cb();
      }, 5);
    });
    const cron = {
      stop: vi.fn(() => {
        expect(serverClosed).toBe(true);
      }),
    };
    await shutdown({ server, cron, bg: makeBg(), log: () => {} });
    expect(cron.stop).toHaveBeenCalled();
  });

  it("tolerates a null cron handle (DISABLE_CRON path)", async () => {
    await expect(
      shutdown({ server: makeServer(), cron: null, bg: makeBg(), log: () => {} })
    ).resolves.toBeUndefined();
  });

  it("rejects when server.close reports an error", async () => {
    const server = makeServer((cb) => cb(new Error("boom")));
    await expect(shutdown({ server, cron: null, bg: makeBg(), log: () => {} })).rejects.toThrow(
      "boom"
    );
  });
});

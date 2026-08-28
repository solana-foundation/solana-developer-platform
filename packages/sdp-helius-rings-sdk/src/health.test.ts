import { describe, expect, it } from "vitest";
import { probeRingsHealth, type RingsHealthInput } from "./health.js";

const INDEXER_URL = "http://indexer.test";
const PROVER_URL = "http://prover.test";
/** Stands in for the real one, which carries an API key. */
const RPC_URL_WITH_KEY = "https://devnet.helius-rpc.com/?api-key=super-secret-key";

function timeoutError(): Error {
  const error = new Error("timed out");
  error.name = "TimeoutError";
  return error;
}

const HEALTHY_CLIENT = {
  getLatestBlockhash: () => Promise.resolve({} as never),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Routes by host so one fake serves both the indexer and the prover. */
function hostOf(input: string | URL): string {
  return new URL(String(input)).host;
}

function fetchStub(
  handlers: Readonly<{ indexer?: () => Promise<Response>; prover?: () => Promise<Response> }>
): typeof globalThis.fetch {
  return ((input: string | URL) => {
    const host = hostOf(input);
    if (host === "indexer.test") {
      return (handlers.indexer ?? (() => Promise.resolve(jsonResponse({ result: "ok" }))))();
    }
    if (host === "prover.test") {
      return (handlers.prover ?? (() => Promise.resolve(new Response(null, { status: 200 }))))();
    }
    throw new Error(`unexpected probe target ${String(input)}`);
  }) as typeof globalThis.fetch;
}

function input(overrides: Partial<RingsHealthInput> = {}): RingsHealthInput {
  return {
    client: HEALTHY_CLIENT,
    indexerUrl: INDEXER_URL,
    proverUrl: PROVER_URL,
    timeoutMs: 50,
    fetch: fetchStub({}),
    ...overrides,
  };
}

describe("probeRingsHealth", () => {
  it("reports every component green and omits detail when all three answer", async () => {
    const health = await probeRingsHealth(input());

    expect(health).toEqual({ rpc: "green", photon: "green", prover: "green", gateway: "green" });
    expect(health.detail).toBeUndefined();
  });

  it("asks Photon for its health over JSON-RPC, since the client has no such method", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    const capture = ((url: string | URL, init?: RequestInit) => {
      if (hostOf(url) === "indexer.test") {
        requests.push({ method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      }
      return Promise.resolve(jsonResponse({ result: "ok" }));
    }) as typeof globalThis.fetch;

    await probeRingsHealth(input({ fetch: capture }));

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toMatchObject({ jsonrpc: "2.0", method: "getIndexerHealth" });
  });

  it("probes the prover at GET /health", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const capture = ((url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET" });
      return Promise.resolve(jsonResponse({ result: "ok" }));
    }) as typeof globalThis.fetch;

    await probeRingsHealth(input({ fetch: capture }));

    const prover = seen.find((request) => hostOf(request.url) === "prover.test");
    expect(prover).toEqual({ url: `${PROVER_URL}/health`, method: "GET" });
  });

  it("keeps a prover mounted behind a path prefix", async () => {
    const seen: string[] = [];
    const capture = ((url: string | URL) => {
      seen.push(String(url));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof globalThis.fetch;

    await probeRingsHealth(input({ proverUrl: `${PROVER_URL}/prover`, fetch: capture }));

    expect(seen).toContain(`${PROVER_URL}/prover/health`);
  });

  it("calls an answering-but-unhealthy Photon amber, not red", async () => {
    const notOk = await probeRingsHealth(
      input({ fetch: fetchStub({ indexer: () => Promise.resolve(jsonResponse({ result: "b" })) }) })
    );
    expect(notOk.photon).toBe("amber");
    expect(notOk.detail?.photon).toBe("not ok");

    const errored = await probeRingsHealth(
      input({
        fetch: fetchStub({
          indexer: () => Promise.resolve(jsonResponse({ error: { code: -32000 } })),
        }),
      })
    );
    expect(errored.photon).toBe("amber");
    expect(errored.detail?.photon).toBe("reported unhealthy");
  });

  it("calls an unreachable or erroring upstream red", async () => {
    const photonDown = await probeRingsHealth(
      input({
        fetch: fetchStub({ indexer: () => Promise.reject(new Error("connect ECONNREFUSED")) }),
      })
    );
    expect(photonDown.photon).toBe("red");
    expect(photonDown.detail?.photon).toBe("unreachable");

    const photon500 = await probeRingsHealth(
      input({ fetch: fetchStub({ indexer: () => Promise.resolve(jsonResponse({}, 500)) }) })
    );
    expect(photon500.photon).toBe("red");
    expect(photon500.detail?.photon).toBe("http 500");

    const prover503 = await probeRingsHealth(
      input({
        fetch: fetchStub({ prover: () => Promise.resolve(new Response(null, { status: 503 })) }),
      })
    );
    expect(prover503.prover).toBe("red");
    expect(prover503.detail?.prover).toBe("http 503");
  });

  it("fails the RPC probe red when the node rejects", async () => {
    const health = await probeRingsHealth(
      input({ client: { getLatestBlockhash: () => Promise.reject(new Error("no")) } })
    );

    expect(health.rpc).toBe("red");
    expect(health.detail?.rpc).toBe("unreachable");
  });

  it("treats a slow upstream as down rather than waiting on it", async () => {
    const health = await probeRingsHealth(
      input({ client: { getLatestBlockhash: () => new Promise(() => {}) }, timeoutMs: 10 })
    );

    expect(health.rpc).toBe("red");
    expect(health.detail?.rpc).toBe("timed out");
  });

  // The abort signal normally does this, but a `fetch` that ignores it would hang
  // the probe past its budget, which is the one thing a health endpoint must not do.
  it.each(["photon", "prover"])(
    "treats a %s fetch that ignores the abort as down",
    async (component) => {
      const health = await probeRingsHealth(
        input({
          timeoutMs: 10,
          fetch: (async () => new Promise(() => {})) as unknown as typeof globalThis.fetch,
        })
      );

      expect(health[component as "photon" | "prover"]).toBe("red");
      expect(health.detail?.[component]).toBe("timed out");
    }
  );

  it("never leaks the RPC URL or its API key into the reported detail", async () => {
    const health = await probeRingsHealth(
      input({
        // What a real client does: quotes the URL it failed to reach.
        client: {
          getLatestBlockhash: () =>
            Promise.reject(new Error(`fetch failed for ${RPC_URL_WITH_KEY}`)),
        },
        fetch: fetchStub({
          indexer: () => Promise.reject(timeoutError()),
          prover: () => Promise.reject(new Error(`connect ECONNREFUSED ${PROVER_URL}`)),
        }),
      })
    );

    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("api-key");
    expect(serialized).not.toContain("super-secret-key");
    expect(serialized).not.toContain("helius-rpc.com");
    expect(serialized).not.toContain("indexer.test");
    expect(health.detail).toEqual({
      rpc: "unreachable",
      photon: "timed out",
      prover: "unreachable",
    });
  });

  it("keeps the in-process gateway green even when every upstream is down", async () => {
    const health = await probeRingsHealth(
      input({
        client: { getLatestBlockhash: () => Promise.reject(new Error("no")) },
        fetch: fetchStub({
          indexer: () => Promise.reject(new Error("no")),
          prover: () => Promise.reject(new Error("no")),
        }),
      })
    );

    expect(health.gateway).toBe("green");
  });
});

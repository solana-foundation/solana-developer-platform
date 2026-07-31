import { afterEach, describe, expect, it, vi } from "vitest";
import { probeGatewayHealth } from "./health";

type FetchMockImpl = (url: string) => Promise<Response>;

function stubFetch(impl: FetchMockImpl): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = input instanceof URL ? input.toString() : String(input);
      return impl(url);
    })
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeGatewayHealth", () => {
  it("returns ready when both /health and /ready are 2xx", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" }, 200);
      if (url.endsWith("/ready")) return jsonResponse({ status: "ready" }, 200);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await probeGatewayHealth("http://gateway.test:8899");

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("narrowing");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.health.ok).toBe(true);
    expect(result.health.body).toEqual({ status: "ok" });
    expect(result.ready.body).toEqual({ status: "ready" });
  });

  it("returns degraded when /health is 200 but /ready is 503", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" }, 200);
      if (url.endsWith("/ready"))
        return jsonResponse({ status: "degraded", reason: "read upstream down" }, 503);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await probeGatewayHealth("http://gateway.test:8899");

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("narrowing");
    expect(result.reason).toBe("read upstream down");
    expect(result.ready.status).toBe(503);
  });

  it("returns degraded with a fallback reason when /ready body has no reason field", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" }, 200);
      if (url.endsWith("/ready")) return jsonResponse({ status: "degraded" }, 503);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await probeGatewayHealth("http://gateway.test:8899");

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("narrowing");
    expect(result.reason).toBe("degraded");
  });

  it("returns unreachable when /health fetch rejects", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/health")) throw new TypeError("fetch failed");
      return jsonResponse({ status: "ready" }, 200);
    });

    const result = await probeGatewayHealth("http://gateway.test:8899");

    expect(result.status).toBe("unreachable");
    if (result.status !== "unreachable") throw new Error("narrowing");
    expect(result.error).toContain("fetch failed");
  });

  it("returns unreachable when /health returns a non-2xx status", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/health")) return new Response("bad gateway", { status: 502 });
      return jsonResponse({ status: "ready" }, 200);
    });

    const result = await probeGatewayHealth("http://gateway.test:8899");

    expect(result.status).toBe("unreachable");
    if (result.status !== "unreachable") throw new Error("narrowing");
    expect(result.error).toContain("502");
    expect(result.health?.status).toBe(502);
  });

  it("rejects empty input as unreachable without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeGatewayHealth("");

    expect(result.status).toBe("unreachable");
    if (result.status !== "unreachable") throw new Error("narrowing");
    expect(result.error).toMatch(/required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unparseable URL as unreachable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeGatewayHealth("not-a-url");

    expect(result.status).toBe("unreachable");
    if (result.status !== "unreachable") throw new Error("narrowing");
    expect(result.error).toMatch(/invalid url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-http protocol as unreachable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeGatewayHealth("ftp://gateway.test");

    expect(result.status).toBe("unreachable");
    if (result.status !== "unreachable") throw new Error("narrowing");
    expect(result.error).toMatch(/protocol/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

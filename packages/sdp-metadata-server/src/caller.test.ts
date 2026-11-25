import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { createIdentityTokenProvider, IDENTITY_TOKEN_REFETCH_AFTER_SECONDS } from "./caller";

const SETTINGS = { urlSetting: "CALLEE_URL", audienceSetting: "CALLEE_AUDIENCE" };
const ORIGIN_MISMATCH = "CALLEE_URL must use HTTPS and match the CALLEE_AUDIENCE origin";

function providerFor(audience: string, url = audience): () => Promise<string> {
  return createIdentityTokenProvider({ url, audience, ...SETTINGS });
}

type FetchCall = { url: URL; headers: Headers };

function stubMetadata(t: TestContext, respond: (call: number) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init, "metadata request is sent with options");
    calls.push({ url: new URL(String(input)), headers: new Headers(init.headers) });
    return respond(calls.length);
  });
  return calls;
}

function stubClock(t: TestContext, startMs: number): { set: (ms: number) => void } {
  let now = startMs;
  t.mock.method(Date, "now", () => now);
  return {
    set: (ms) => {
      now = ms;
    },
  };
}

describe("createIdentityTokenProvider destination check", () => {
  it("accepts an HTTPS URL on the audience's origin, path included", () => {
    providerFor("https://callee.mock.invalid");
    providerFor("https://callee.mock.invalid/", "https://callee.mock.invalid/v1/rpc?x=1");
  });

  it("rejects plain HTTP, a different origin or embedded credentials on either side", () => {
    const cases: Array<[string, string]> = [
      ["http://callee.mock.invalid", "https://callee.mock.invalid"],
      ["https://callee.mock.invalid", "http://callee.mock.invalid"],
      ["http://callee.mock.invalid", "http://callee.mock.invalid"],
      ["https://other.mock.invalid", "https://callee.mock.invalid"],
      ["https://callee.mock.invalid:8443", "https://callee.mock.invalid"],
      ["https://api.callee.mock.invalid", "https://callee.mock.invalid"],
      ["https://user:pass@callee.mock.invalid", "https://callee.mock.invalid"],
      ["https://callee.mock.invalid", "https://user@callee.mock.invalid"],
    ];
    for (const [url, audience] of cases) {
      assert.throws(() => providerFor(audience, url), new Error(ORIGIN_MISMATCH));
    }
  });

  it("rejects unparseable input on either side, naming both settings", () => {
    const message = "CALLEE_URL and CALLEE_AUDIENCE must be valid URLs";
    assert.throws(() => providerFor("https://callee.mock.invalid", "not a url"), { message });
    assert.throws(() => providerFor("", "https://callee.mock.invalid"), { message });
  });
});

describe("createIdentityTokenProvider token", () => {
  it("asks the metadata server for a token for the audience and returns it trimmed", async (t) => {
    const audience = "https://callee-request.mock.invalid";
    const calls = stubMetadata(t, () => new Response("synthetic-token-request\n"));

    assert.equal(await providerFor(audience)(), "synthetic-token-request");

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url.protocol, "http:");
    assert.equal(call.url.host, "metadata.google.internal");
    assert.equal(call.url.searchParams.get("audience"), audience);
    assert.equal(call.headers.get("Metadata-Flavor"), "Google");
  });

  it("serves the held token until the refetch age, then fetches a new one", async (t) => {
    const startMs = 1_900_000_000_000;
    const refetchAtMs = startMs + IDENTITY_TOKEN_REFETCH_AFTER_SECONDS * 1000;
    const clock = stubClock(t, startMs);
    const tokens = ["synthetic-token-first", "synthetic-token-second"];
    const calls = stubMetadata(t, (call) => new Response(tokens[call - 1]));
    const provider = providerFor("https://callee-refetch.mock.invalid");

    assert.equal(await provider(), "synthetic-token-first");
    clock.set(refetchAtMs - 1);
    assert.equal(await provider(), "synthetic-token-first");
    assert.equal(calls.length, 1);

    clock.set(refetchAtMs);
    assert.equal(await provider(), "synthetic-token-second");
    assert.equal(calls.length, 2);
  });

  it("shares one fetch between concurrent calls", async (t) => {
    const calls = stubMetadata(t, () => new Response("synthetic-token-shared"));
    const provider = providerFor("https://callee-concurrent.mock.invalid");

    const tokens = await Promise.all([provider(), provider(), provider()]);

    assert.deepEqual(tokens, Array(3).fill("synthetic-token-shared"));
    assert.equal(calls.length, 1);
  });

  it("rejects on a non-2xx metadata response and fetches again on the next call", async (t) => {
    const calls = stubMetadata(t, (call) =>
      call === 1
        ? new Response("unavailable", { status: 503 })
        : new Response("synthetic-token-after-failure")
    );
    const provider = providerFor("https://callee-failure.mock.invalid");

    await assert.rejects(provider(), { message: "Identity token request failed with HTTP 503" });
    assert.equal(await provider(), "synthetic-token-after-failure");
    assert.equal(calls.length, 2);
  });
});

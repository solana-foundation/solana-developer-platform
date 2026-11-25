import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { UnsecuredJWT } from "jose";
import {
  assertCloudRunIdentityDestination,
  createCloudRunIdentityTokenProvider,
} from "./identity-token";

const SETTINGS = { urlSetting: "CALLEE_URL", audienceSetting: "CALLEE_AUDIENCE" };
const ORIGIN_MISMATCH = "CALLEE_URL must use HTTPS and match the CALLEE_AUDIENCE origin";

function checkDestination(url: string, audience: string): void {
  assertCloudRunIdentityDestination({ url, audience, ...SETTINGS });
}

describe("assertCloudRunIdentityDestination", () => {
  it("accepts an HTTPS URL on the audience's origin, path included", () => {
    checkDestination("https://callee.mock.invalid", "https://callee.mock.invalid");
    checkDestination("https://callee.mock.invalid/v1/rpc?x=1", "https://callee.mock.invalid/");
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
      assert.throws(() => checkDestination(url, audience), new Error(ORIGIN_MISMATCH));
    }
  });

  it("rejects unparseable input on either side, naming both settings", () => {
    const message = "CALLEE_URL and CALLEE_AUDIENCE must be valid URLs";
    assert.throws(() => checkDestination("not a url", "https://callee.mock.invalid"), {
      message,
    });
    assert.throws(() => checkDestination("https://callee.mock.invalid", ""), { message });
  });
});

function identityToken(expiresAtSeconds: number, label: string): string {
  return new UnsecuredJWT({ label }).setExpirationTime(expiresAtSeconds).encode();
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

describe("createCloudRunIdentityTokenProvider", () => {
  it("refuses an empty or blank audience, naming the setting", () => {
    for (const audience of ["", "   "]) {
      assert.throws(
        () => createCloudRunIdentityTokenProvider(audience, { audienceSetting: "KORA_AUDIENCE" }),
        { message: "KORA_AUDIENCE cannot be empty" }
      );
    }
  });

  it("asks the metadata server for an identity token for the audience", async (t) => {
    const audience = "https://callee-request.mock.invalid";
    const token = identityToken(Math.floor(Date.now() / 1000) + 3600, "request");
    const calls = stubMetadata(t, () => new Response(`${token}\n`));

    const provider = createCloudRunIdentityTokenProvider(audience, { audienceSetting: "A" });
    assert.equal(await provider(), token);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url.protocol, "http:");
    assert.equal(call.url.host, "metadata.google.internal");
    assert.equal(call.url.searchParams.get("audience"), audience);
    assert.equal(call.headers.get("Metadata-Flavor"), "Google");
  });

  it("serves the cached token until one minute before exp, then fetches a new one", async (t) => {
    const startMs = 1_900_000_000_000;
    const expSeconds = startMs / 1000 + 3600;
    const refreshAtMs = expSeconds * 1000 - 60_000;
    const clock = stubClock(t, startMs);
    const tokens = [identityToken(expSeconds, "first"), identityToken(expSeconds + 3600, "second")];
    const calls = stubMetadata(t, (call) => new Response(tokens[call - 1]));
    const provider = createCloudRunIdentityTokenProvider("https://callee-refresh.mock.invalid", {
      audienceSetting: "A",
    });

    assert.equal(await provider(), tokens[0]);
    clock.set(refreshAtMs - 1);
    assert.equal(await provider(), tokens[0]);
    assert.equal(calls.length, 1);

    clock.set(refreshAtMs);
    assert.equal(await provider(), tokens[1]);
    assert.equal(calls.length, 2);
  });

  it("rejects on a non-2xx metadata response and fetches again on the next call", async (t) => {
    const token = identityToken(Math.floor(Date.now() / 1000) + 3600, "after-failure");
    const calls = stubMetadata(t, (call) =>
      call === 1 ? new Response("unavailable", { status: 503 }) : new Response(token)
    );
    const provider = createCloudRunIdentityTokenProvider("https://callee-failure.mock.invalid", {
      audienceSetting: "A",
    });

    await assert.rejects(provider(), { message: /HTTP 503/ });
    assert.equal(await provider(), token);
    assert.equal(calls.length, 2);
  });
});

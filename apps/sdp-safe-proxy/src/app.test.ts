import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SafeProxyCode } from "@sdp/safe-proxy-endpoints/protocol";
import { importSPKI, jwtVerify } from "jose";
import {
  createForwardApp,
  FIREBLOCKS_PUBLIC_PEM,
  type ForwardApp,
  type ForwardAppOptions,
  type ForwardRequest,
  PLATFORM_CREDENTIALS,
  REVISION,
} from "./test/helpers/forward-app";

const LIST_WALLETS = "/v1/forward/privy/v1/wallets";
const UNKNOWN_PROVIDER = "/v1/forward/nope/v1/wallets";

async function assertOwnAnswer(
  forwardApp: ForwardApp,
  response: Response,
  expected: { result: "refused" | "no_answer"; code: SafeProxyCode; providerCalls: number }
): Promise<void> {
  assert.equal(response.headers.get("sdp-safe-proxy-result"), expected.result);
  assert.deepEqual(await response.json(), { code: expected.code });
  assert.equal(forwardApp.calls.length, expected.providerCalls);
  const lines = forwardApp.logLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.result, expected.result);
  assert.equal(lines[0]?.code, expected.code);
}

function assertRefused(forwardApp: ForwardApp, response: Response, code: SafeProxyCode) {
  return assertOwnAnswer(forwardApp, response, { result: "refused", code, providerCalls: 0 });
}

describe("forward route: provider answers", () => {
  const answers = [
    {
      name: "a JSON 200",
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: '{"id":"w1"}',
    },
    // Same status and body as a Safe Proxy refusal: only the result header tells them apart.
    {
      name: "a 403",
      status: 403,
      contentType: "application/json",
      body: '{"code":"caller_not_allowed"}',
    },
    { name: "a 204 with no body", status: 204, contentType: null, body: null },
  ];
  for (const answer of answers) {
    it(`returns ${answer.name} from the provider unchanged, marked forwarded`, async () => {
      const forwardApp = createForwardApp({
        answer: () =>
          new Response(answer.body, {
            status: answer.status,
            headers: answer.contentType === null ? {} : { "content-type": answer.contentType },
          }),
      });

      const response = await forwardApp.send(LIST_WALLETS);

      assert.equal(response.status, answer.status);
      assert.equal(response.headers.get("sdp-safe-proxy-result"), "forwarded");
      assert.equal(response.headers.get("content-type"), answer.contentType);
      assert.equal(await response.text(), answer.body ?? "");
      assert.equal(forwardApp.calls.length, 1);
    });
  }

  it("sends a Privy request once, with its body, its declared headers and the platform credential only", async () => {
    const forwardApp = createForwardApp();
    const body = '{"chain_type":"solana"}';

    await forwardApp.send(LIST_WALLETS, {
      method: "POST",
      body,
      headers: {
        "privy-idempotency-key": "idem-5e2",
        "privy-app-id": "caller-app",
        "x-api-key": "caller-key",
        "x-trace-id": "trace-1",
        cookie: "session=abc",
        "content-type": "text/plain",
      },
    });

    assert.deepEqual(
      forwardApp.calls.map(({ signal: _signal, ...call }) => call),
      [
        {
          url: "https://api.privy.io/v1/wallets",
          method: "POST",
          body,
          headers: {
            authorization: "Basic cHJpdnktYXBwLWEzMTpwcml2eS1zZWNyZXQtcTh6",
            "privy-app-id": "privy-app-a31",
            "privy-idempotency-key": "idem-5e2",
            "content-type": "application/json",
          },
        },
      ]
    );
  });

  it("sends a Fireblocks request to the exact target with a token signed for it", async () => {
    const forwardApp = createForwardApp();
    const target = "/v1/vault/accounts/7/SOL/addresses_paginated?limit=5";

    await forwardApp.send(`/v1/forward/fireblocks${target}`, {
      headers: { "x-api-key": "caller-key" },
    });

    assert.equal(forwardApp.calls.length, 1);
    const [call] = forwardApp.calls;
    assert.equal(call?.url, `https://api.fireblocks.io${target}`);
    assert.equal(call?.method, "GET");
    assert.equal(call?.body, null);
    assert.deepEqual(Object.keys(call?.headers ?? {}).sort(), ["authorization", "x-api-key"]);
    assert.equal(call?.headers["x-api-key"], "fireblocks-key-k4w");
    const token = call?.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const { payload } = await jwtVerify(token, await importSPKI(FIREBLOCKS_PUBLIC_PEM, "RS256"));
    assert.equal(payload.uri, target);
    assert.equal(payload.sub, "fireblocks-key-k4w");
  });
});

describe("forward route: refusals, each at the first step the request fails", () => {
  const noCredential = { "sdp-safe-proxy-credential": null } as const;
  const headerRows: { name: string; headers: ForwardRequest["headers"] }[] = [
    { name: "a missing request id", headers: { "sdp-safe-proxy-request-id": null } },
    { name: "an invalid request id", headers: { "sdp-safe-proxy-request-id": "req/1" } },
    { name: "a missing budget", headers: { "sdp-safe-proxy-budget-ms": null } },
    { name: "a budget that is not digits", headers: { "sdp-safe-proxy-budget-ms": "1e3" } },
    { name: "a budget above the maximum", headers: { "sdp-safe-proxy-budget-ms": "10001" } },
  ];
  const rows: (ForwardRequest & {
    name: string;
    path?: string;
    code: SafeProxyCode;
    keys?: ForwardAppOptions["keys"];
  })[] = [
    {
      name: "checks the caller before the request's headers",
      caller: null,
      headers: { "sdp-safe-proxy-budget-ms": "abc" },
      code: "unauthenticated",
    },
    {
      name: "refuses a token from another signer",
      token: { untrusted: true },
      code: "unauthenticated",
    },
    {
      name: "refuses a token past the maximum age",
      token: { ageSeconds: 301 },
      code: "unauthenticated",
    },
    {
      name: "reports identity keys that cannot be read apart from a bad token",
      keys: () => async () => {
        throw new Error("key set unreachable");
      },
      code: "caller_check_unavailable",
    },
    {
      name: "refuses a verified caller that is not a configured caller",
      token: { email: "someone@callers.mock.invalid" },
      code: "caller_not_allowed",
    },
    ...headerRows.map((row) => ({
      ...row,
      name: `refuses ${row.name} before matching the endpoint`,
      path: UNKNOWN_PROVIDER,
      code: "invalid_request" as const,
    })),
    {
      name: "refuses an unknown provider",
      caller: "cron",
      path: UNKNOWN_PROVIDER,
      code: "provider_not_allowed",
    },
    {
      name: "refuses an undeclared endpoint",
      caller: "cron",
      path: "/v1/forward/privy/v1/users",
      code: "endpoint_not_allowed",
    },
    {
      name: "refuses a body outside the endpoint's body rule",
      caller: "cron",
      method: "POST",
      path: "/v1/forward/privy/v1/wallets/wallet-1/rpc",
      body: '{"method":"exportWallet"}',
      code: "body_not_allowed",
    },
    {
      name: "checks the endpoint's caller list before the body",
      caller: "cron",
      headers: { "content-length": "5" },
      code: "caller_not_allowed",
    },
    {
      name: "refuses a GET declaring a body length before the credential",
      headers: { "content-length": "5", ...noCredential },
      code: "body_not_allowed",
    },
    {
      name: "refuses a GET declaring a transfer encoding before the credential",
      headers: { "transfer-encoding": "chunked", ...noCredential },
      code: "body_not_allowed",
    },
    {
      name: "refuses a missing credential reference",
      headers: noCredential,
      code: "invalid_request",
    },
    {
      name: "refuses a malformed credential reference",
      headers: { "sdp-safe-proxy-credential": "secret_manager_version:projects/p/secrets/s" },
      code: "invalid_request",
    },
    {
      name: "answers credential_store_unavailable for a stored credential version",
      headers: {
        "sdp-safe-proxy-credential":
          "secret_manager_version:projects/sdp-test/secrets/privy/versions/3",
      },
      code: "credential_store_unavailable",
    },
  ];

  for (const { name, path, code, keys, ...request } of rows) {
    it(name, async () => {
      const forwardApp = createForwardApp({ keys });
      await assertRefused(forwardApp, await forwardApp.send(path ?? LIST_WALLETS, request), code);
    });
  }

  it("counts time spent identifying the caller against the budget", async () => {
    const forwardApp = createForwardApp({
      keys: (trusted, clock) => (header, token) => {
        clock.advance(10_001);
        return trusted(header, token);
      },
    });

    await assertRefused(forwardApp, await forwardApp.send(LIST_WALLETS), "deadline_exceeded");
    assert.equal(forwardApp.logLines()[0]?.duration_ms, 10_001);
  });
});

describe("forward route: the provider call", () => {
  it("aborts the provider call when the budget runs out and answers no_answer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reachedProvider!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedProvider = resolve;
    });
    const forwardApp = createForwardApp({
      answer: ({ signal }) => {
        reachedProvider();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      },
    });

    const pending = forwardApp.send(LIST_WALLETS);
    await reached;
    t.mock.timers.tick(9_999);
    assert.equal(forwardApp.calls[0]?.signal?.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(forwardApp.calls[0]?.signal?.aborted, true);

    const response = await pending;
    await assertOwnAnswer(forwardApp, response, {
      result: "no_answer",
      code: "provider_no_answer",
      providerCalls: 1,
    });
  });

  it("answers no_answer when the provider call fails", async () => {
    const forwardApp = createForwardApp({
      answer: () => {
        throw new TypeError("fetch failed");
      },
    });

    await assertOwnAnswer(forwardApp, await forwardApp.send(LIST_WALLETS), {
      result: "no_answer",
      code: "provider_no_answer",
      providerCalls: 1,
    });
  });

  it("refuses with internal when the request fails before it is sent", async () => {
    const forwardApp = createForwardApp({
      credentials: {
        ...PLATFORM_CREDENTIALS,
        fireblocks: { apiKey: "fireblocks-key-k4w", apiSecretPem: "not a key" },
      },
    });

    const response = await forwardApp.send("/v1/forward/fireblocks/v1/supported_assets");

    await assertRefused(forwardApp, response, "internal");
  });
});

describe("routes outside the forward route", () => {
  for (const [method, path] of [
    ["GET", "/nope"],
    ["POST", "/health"],
  ] as const) {
    it(`answers ${method} ${path} as unknown_route and logs it`, async () => {
      const forwardApp = createForwardApp();
      await assertRefused(
        forwardApp,
        await forwardApp.app.request(path, { method }),
        "unknown_route"
      );
    });
  }

  it("answers health at once and readiness once ready, without logging either", async () => {
    const forwardApp = createForwardApp();

    assert.equal((await forwardApp.app.request("/health")).status, 200);
    assert.equal((await forwardApp.app.request("/health/ready")).status, 503);
    forwardApp.setReadiness("ready");
    const ready = await forwardApp.app.request("/health/ready");
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { service: "sdp-safe-proxy", revision: REVISION });
    assert.deepEqual(forwardApp.logLines(), []);
  });
});

describe("request log", () => {
  it("writes one line per request saying how far it got, with the declared endpoint pattern", async () => {
    const answered: ForwardAppOptions["answer"] = (_call, clock) => {
      clock.advance(250);
      return new Response(null, { status: 204 });
    };
    const failed: ForwardAppOptions["answer"] = () => {
      throw new TypeError("fetch failed");
    };
    const unmatched = { provider: null, endpoint_method: null, endpoint_path: null };
    const cron = { caller: "cron", caller_token_age_s: 42 };
    const readWallet = {
      provider: "privy",
      endpoint_method: "GET",
      endpoint_path: "/v1/wallets/{wallet}",
    };
    const cases: {
      path: string;
      request: ForwardRequest;
      answer?: ForwardAppOptions["answer"];
      line: Record<string, unknown>;
    }[] = [
      {
        path: "/v1/forward/privy/v1/wallets/wallet-9",
        request: { caller: "cron" },
        answer: answered,
        line: {
          ...cron,
          ...readWallet,
          result: "forwarded",
          code: null,
          provider_call: "answered",
          duration_ms: 250,
        },
      },
      {
        path: "/v1/forward/privy/v1/wallets/wallet-9",
        request: { caller: "cron" },
        answer: failed,
        line: {
          ...cron,
          ...readWallet,
          result: "no_answer",
          code: "provider_no_answer",
          provider_call: "in_flight",
          duration_ms: 0,
        },
      },
      {
        path: LIST_WALLETS,
        request: { caller: "cron" },
        line: {
          ...cron,
          provider: "privy",
          endpoint_method: "GET",
          endpoint_path: "/v1/wallets",
          result: "refused",
          code: "caller_not_allowed",
          provider_call: "not_sent",
          duration_ms: 0,
        },
      },
      {
        path: LIST_WALLETS,
        request: { caller: "cron", headers: { "sdp-safe-proxy-budget-ms": null } },
        line: {
          ...cron,
          ...unmatched,
          result: "refused",
          code: "invalid_request",
          provider_call: "not_sent",
          duration_ms: 0,
        },
      },
      {
        path: LIST_WALLETS,
        request: { caller: null },
        line: {
          caller: null,
          caller_token_age_s: null,
          ...unmatched,
          result: "refused",
          code: "unauthenticated",
          provider_call: "not_sent",
          duration_ms: 0,
        },
      },
    ];
    for (const { path, request, answer, line } of cases) {
      const forwardApp = createForwardApp({ answer });
      await forwardApp.send(path, request);
      assert.deepEqual(forwardApp.logLines(), [
        { request_id: "req-7d1", revision: REVISION, level: 30, severity: "INFO", ...line },
      ]);
    }
  });

  it("keeps request content, provider content and credentials out of the line", async () => {
    const forwardApp = createForwardApp({
      answer: ({ url }) => {
        if (url.includes("fireblocks")) throw new Error("socket closed by peer-f85");
        return new Response('{"signed":"resp-body-c63"}', { status: 200 });
      },
    });
    const token = await forwardApp.callerToken();
    const authorization = `Bearer ${token}`;
    const requestBody = '{"method":"signTransaction","params":{"transaction":"tx-body-b52"}}';
    const storedReference = "secret_manager_version:projects/sdp-test/secrets/privy-g96/versions/3";

    await forwardApp.send("/v1/forward/privy/v1/wallets/wallet-d41/rpc", {
      authorization,
      method: "POST",
      body: requestBody,
    });
    await forwardApp.send("/v1/forward/fireblocks/v1/vault/accounts_paged?namePrefix=vault-e74", {
      authorization,
    });
    await forwardApp.send(LIST_WALLETS, {
      authorization,
      headers: { "sdp-safe-proxy-credential": storedReference },
    });

    const lines = forwardApp.rawLogLines();
    assert.deepEqual(
      forwardApp.logLines().map((line) => line.result),
      ["forwarded", "no_answer", "refused"]
    );
    const pemLine = PLATFORM_CREDENTIALS.fireblocks.apiSecretPem.split("\n")[1] ?? "";
    assert.ok(pemLine.length > 40);
    for (const kept of [
      "tx-body-b52",
      "resp-body-c63",
      "privy-g96",
      "privy-secret-q8z",
      "fireblocks-key-k4w",
      pemLine,
      token,
      "wallet-d41",
      "vault-e74",
      "peer-f85",
    ]) {
      for (const line of lines) assert.ok(!line.includes(kept), `log line carries ${kept}`);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOCAL_CALLER_HEADER,
  REQUEST_ID_HEADER,
  RESULT_HEADER,
  type SafeProxyCode,
} from "@sdp/safe-proxy-endpoints/protocol";
import { importSPKI, jwtVerify } from "jose";
import { createLocalCallerCheck } from "@/app";
import {
  createForwardApp,
  FIREBLOCKS_PUBLIC_KEY_PEM,
  type ForwardAppOptions,
  type ForwardRequest,
  PLATFORM_CREDENTIALS,
} from "./test/helpers/forward-app";

const WALLETS = "/privy/v1/wallets";

async function ownAnswer(response: Response) {
  const result = response.headers.get(RESULT_HEADER);
  return { status: response.status, result, body: await response.text() };
}

describe("a refused request reaches no provider", () => {
  const rows: [
    name: string,
    status: number,
    code: SafeProxyCode,
    path: string,
    request?: ForwardRequest,
    app?: ForwardAppOptions,
  ][] = [
    ["a forged identity token", 401, "unauthenticated", WALLETS, { token: "forged" }],
    [
      "no token, even naming a local caller",
      401,
      "unauthenticated",
      WALLETS,
      { token: null, headers: { [LOCAL_CALLER_HEADER]: "api" } },
    ],
    ["an unknown service account", 403, "caller_not_allowed", WALLETS, { token: "stranger" }],
    [
      "a token while the identity keys cannot be read",
      503,
      "caller_check_unavailable",
      WALLETS,
      {},
      { keys: () => Promise.reject(new Error("keys unreachable")) },
    ],
    ["a caller not on the endpoint", 403, "caller_not_allowed", WALLETS, { token: "cron" }],
    ["an undeclared provider", 403, "provider_not_allowed", "/acme/v1/wallets"],
    ["an undeclared endpoint", 403, "endpoint_not_allowed", "/privy/v1/users"],
    [
      "a body outside the body rule",
      403,
      "body_not_allowed",
      "/privy/v1/wallets/wallet-d41/rpc",
      { method: "POST", body: '{"method":"exportWallet"}' },
    ],
    [
      "a body over the size limit",
      400,
      "invalid_request",
      WALLETS,
      { method: "POST", body: "a".repeat(1024 * 1024 + 1) },
    ],
    ["a provider with no provider path", 404, "unknown_route", "/privy"],
    ["a path naming no provider", 404, "unknown_route", "/"],
  ];
  for (const [name, status, code, path, request, app] of rows) {
    it(`refuses ${name}`, async () => {
      const forwardApp = createForwardApp(app);
      assert.deepEqual(await ownAnswer(await forwardApp.send(path, request)), {
        status,
        result: "refused",
        body: JSON.stringify({ code }),
      });
      assert.equal(forwardApp.calls.length, 0);
    });
  }
});

it("the local caller check takes a caller only on its loopback address, naming itself", async () => {
  const identify = createLocalCallerCheck({ hostname: "127.0.0.1", port: 8791 });
  const headers = (host: string, caller: string) =>
    new Headers({ host, [LOCAL_CALLER_HEADER]: caller });

  assert.equal(await identify(headers("127.0.0.1:8791", "cron")), "cron");
  await assert.rejects(identify(headers("localhost:8791", "api")), { code: "unauthenticated" });
  await assert.rejects(identify(headers("127.0.0.1:8791", "admin")), { code: "unauthenticated" });
});

it("sends the provider only its declared headers and the platform's Privy auth", async () => {
  const forwardApp = createForwardApp();
  await forwardApp.send(WALLETS, {
    method: "POST",
    body: '{"chain_type": "solana", "note": "é"}',
    headers: {
      "privy-idempotency-key": "idem-5e2",
      "privy-app-id": "caller-app",
      "x-api-key": "caller-key",
      cookie: "session=abc",
      "content-type": "text/plain",
    },
  });

  assert.deepEqual(forwardApp.calls, [
    {
      url: "https://api.privy.io/v1/wallets",
      method: "POST",
      headers: {
        authorization: "Basic YXBwXzdrMjpzw6ljcmV0",
        "content-type": "application/json",
        "privy-app-id": "app_7k2",
        "privy-idempotency-key": "idem-5e2",
      },
      body: '{"chain_type": "solana", "note": "é"}',
      redirect: "manual",
    },
  ]);
});

it("signs the Fireblocks target and body exactly as sent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_750 });
  const forwardApp = createForwardApp();
  await forwardApp.send("/fireblocks/v1/vault/accounts_paged?namePrefix=vault-e74&limit=5");
  await forwardApp.send("/fireblocks/v1/transactions", {
    method: "POST",
    body: '{"operation":"TRANSFER"}',
  });

  const publicKey = await importSPKI(FIREBLOCKS_PUBLIC_KEY_PEM, "RS256");
  const sent = await Promise.all(
    forwardApp.calls.map(async ({ url, body, headers: { authorization, ...headers } }) => {
      const bearer = /^Bearer (\S+)$/.exec(authorization);
      assert.ok(bearer, "the call carries a bearer token");
      const { nonce, ...claims } = (await jwtVerify(bearer[1], publicKey)).payload;
      return { url, body, headers, claims, nonce: String(nonce) };
    })
  );

  assert.notEqual(sent[0].nonce, sent[1].nonce);
  const claims = { sub: "fireblocks-key-k4w", iat: 1_800_000_000, exp: 1_800_000_030 };
  assert.deepEqual(
    sent.map(({ nonce, ...call }) => call),
    [
      {
        url: "https://api.fireblocks.io/v1/vault/accounts_paged?namePrefix=vault-e74&limit=5",
        body: null,
        headers: { "x-api-key": "fireblocks-key-k4w" },
        claims: {
          ...claims,
          uri: "/v1/vault/accounts_paged?namePrefix=vault-e74&limit=5",
          bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      },
      {
        url: "https://api.fireblocks.io/v1/transactions",
        body: '{"operation":"TRANSFER"}',
        headers: { "content-type": "application/json", "x-api-key": "fireblocks-key-k4w" },
        claims: {
          ...claims,
          uri: "/v1/transactions",
          bodyHash: "38ad69eb823eff0c4d8f416ceda77b9a1f5bcf32fce1892d8d6cc2a7386c4706",
        },
      },
    ]
  );
});

it("passes the provider's status, body and content type back as forwarded", async () => {
  const forwardApp = createForwardApp({
    answer: () =>
      new Response('{"code":"caller_not_allowed"}', {
        status: 403,
        headers: {
          "content-type": "application/json",
          "set-cookie": "session=provider-7a2",
          [RESULT_HEADER]: "refused",
        },
      }),
  });
  const response = await forwardApp.send(WALLETS);

  assert.deepEqual(
    {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    },
    {
      status: 403,
      headers: { "content-type": "application/json", [RESULT_HEADER]: "forwarded" },
      body: '{"code":"caller_not_allowed"}',
    }
  );
});

it("answers no answer when the provider call fails after it was sent", async () => {
  const forwardApp = createForwardApp({
    answer: () => Promise.reject(new TypeError("fetch failed")),
  });
  assert.deepEqual(await ownAnswer(await forwardApp.send(WALLETS)), {
    status: 502,
    result: "no_answer",
    body: '{"code":"provider_no_answer"}',
  });
  assert.equal(forwardApp.calls.length, 1);
});

it("logs the endpoint's pattern and the outcome, never a path, body, secret or token", async () => {
  const forwardApp = createForwardApp({
    answer: () => new Response('{"signed":"resp-body-c63"}'),
  });
  await forwardApp.send("/privy/v1/wallets/wallet-d41/rpc", {
    method: "POST",
    body: '{"method":"signTransaction","params":{"transaction":"tx-body-b52"}}',
  });
  const failing = createForwardApp({
    credentials: {
      privy: PLATFORM_CREDENTIALS.privy,
      get fireblocks(): never {
        throw new Error("credential read failed peer-f85");
      },
    },
  });
  await failing.send("/fireblocks/v1/vault/accounts_paged?namePrefix=vault-e74", {
    headers: { [REQUEST_ID_HEADER]: "req 7d1 tx-body-b52" },
  });

  const lines = [...forwardApp.logged, ...failing.logged].map(({ duration_ms, ...line }) => line);
  const revision = "sdp-safe-proxy-00042-abc";
  assert.deepEqual(lines, [
    {
      request_id: "req-7d1",
      caller: "api",
      provider: "privy",
      endpoint: "POST /v1/wallets/{wallet}/rpc",
      result: "forwarded",
      code: null,
      error_name: null,
      status: 200,
      revision,
    },
    {
      request_id: null,
      caller: "api",
      provider: "fireblocks",
      endpoint: "GET /v1/vault/accounts_paged",
      result: "refused",
      code: "internal",
      error_name: "Error",
      status: 500,
      revision,
    },
  ]);
});

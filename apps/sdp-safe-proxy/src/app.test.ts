import assert from "node:assert/strict";
import { it } from "node:test";
import {
  FROM_PROVIDER_HEADER,
  LOCAL_CALLER_HEADER,
  REQUEST_ID_HEADER,
} from "@sdp/safe-proxy-endpoints/protocol";
import { importSPKI, jwtVerify } from "jose";
import { createLocalCallerCheck, type ProviderCredentials } from "@/app";
import {
  createForwardApp,
  FIREBLOCKS_PUBLIC_KEY_PEM,
  type ForwardAppOptions,
  type ForwardRequest,
  PLATFORM_CREDENTIALS,
} from "./test/helpers/forward-app";

const WALLETS = "/privy/v1/wallets";
const VAULTS = "/fireblocks/v1/vault/accounts_paged?namePrefix=vault-e74";

const FAILING_CREDENTIALS = {
  privy: PLATFORM_CREDENTIALS.privy,
  get fireblocks(): never {
    throw new Error("credential read failed peer-f85");
  },
} satisfies ProviderCredentials;

// The body of an error the proxy answers itself.
const own = (error: string) => JSON.stringify({ error });

const answerOf = async (response: Response) => ({
  status: response.status,
  fromProvider: response.headers.get(FROM_PROVIDER_HEADER),
  body: await response.text(),
});

const ownAnswers: [string, number, string, string, ForwardRequest?, ForwardAppOptions?][] = [
  ["a forged identity token", 401, own("unauthorized"), WALLETS, { token: "forged" }],
  [
    "no token, even naming a local caller",
    401,
    own("unauthorized"),
    WALLETS,
    { token: null, headers: { [LOCAL_CALLER_HEADER]: "api" } },
  ],
  ["an unknown service account", 403, own("caller_not_allowed"), WALLETS, { token: "stranger" }],
  [
    "a token while the identity keys cannot be read",
    503,
    own("caller_check_unavailable"),
    WALLETS,
    {},
    { keys: () => Promise.reject(new Error("keys unreachable")) },
  ],
  ["a caller not on the endpoint", 403, own("caller_not_allowed"), WALLETS, { token: "cron" }],
  ["an undeclared provider", 403, own("provider_not_allowed"), "/acme/v1/wallets"],
  ["an undeclared endpoint", 403, own("endpoint_not_allowed"), "/privy/v1/users"],
  [
    "a body outside the body rule",
    403,
    own("body_not_allowed"),
    "/privy/v1/wallets/wallet-d41/rpc",
    { method: "POST", body: '{"method":"exportWallet"}' },
  ],
  [
    "a body over the size limit",
    413,
    "Payload Too Large",
    WALLETS,
    { method: "POST", body: "a".repeat(1024 * 1024 + 1) },
  ],
  ["a provider with no provider path", 404, own("not_found"), "/privy"],
  ["a path naming no provider", 404, own("not_found"), "/"],
  ["its own failure", 500, own("internal"), VAULTS, {}, { credentials: FAILING_CREDENTIALS }],
];
for (const [name, status, body, path, request, app] of ownAnswers) {
  it(`answers ${status} to ${name} and reaches no provider`, async () => {
    const forwardApp = createForwardApp(app);
    const answer = await answerOf(await forwardApp.send(path, request));
    assert.deepEqual(answer, { status, fromProvider: null, body });
    assert.equal(forwardApp.calls.length, 0);
  });
}

it("the local caller check takes a caller only on its loopback address, naming itself", async () => {
  const identify = createLocalCallerCheck({ hostname: "127.0.0.1", port: 8791 });
  const headers = (host: string, caller: string) =>
    new Headers({ host, [LOCAL_CALLER_HEADER]: caller });

  assert.equal(await identify(headers("127.0.0.1:8791", "cron")), "cron");
  await assert.rejects(identify(headers("localhost:8791", "api")), { status: 401 });
  await assert.rejects(identify(headers("127.0.0.1:8791", "admin")), { status: 401 });
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

it("passes back the provider's status, body and content type, marked as the provider's", async () => {
  const forwardApp = createForwardApp({
    answer: () =>
      new Response(own("caller_not_allowed"), {
        status: 403,
        headers: {
          "content-type": "application/problem+json",
          "set-cookie": "session=provider-7a2",
          "x-request-id": "provider-req-9f1",
          [FROM_PROVIDER_HEADER]: "0",
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
      headers: { "content-type": "application/problem+json", [FROM_PROVIDER_HEADER]: "1" },
      body: own("caller_not_allowed"),
    }
  );
});

it("answers 502 when the provider call fails after it was sent", async () => {
  const forwardApp = createForwardApp({
    answer: () => Promise.reject(new TypeError("fetch failed")),
  });
  assert.deepEqual(await answerOf(await forwardApp.send(WALLETS)), {
    status: 502,
    fromProvider: null,
    body: own("provider_unreachable"),
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
  await forwardApp.send(WALLETS, { token: "cron" });
  const failing = createForwardApp({ credentials: FAILING_CREDENTIALS });
  await failing.send(VAULTS, { headers: { [REQUEST_ID_HEADER]: "req 7d1 tx-body-b52" } });

  const lines = [...forwardApp.logged, ...failing.logged].map(({ duration_ms, ...line }) => line);
  const revision = "sdp-safe-proxy-00042-abc";
  assert.deepEqual(lines, [
    {
      request_id: "req-7d1",
      caller: "api",
      provider: "privy",
      endpoint: "POST /v1/wallets/{wallet}/rpc",
      error: null,
      status: 200,
      revision,
    },
    {
      request_id: "req-7d1",
      caller: "cron",
      provider: "privy",
      endpoint: "GET /v1/wallets",
      error: "caller_not_allowed",
      status: 403,
      revision,
    },
    {
      request_id: null,
      caller: "api",
      provider: "fireblocks",
      endpoint: "GET /v1/vault/accounts_paged",
      error: "Error",
      status: 500,
      revision,
    },
  ]);
});

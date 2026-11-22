import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  FORWARD_HEADERS,
  LOCAL_CALLER_HEADER,
  type SafeProxyCode,
} from "@sdp/safe-proxy-endpoints/protocol";
import { decodeJwt } from "jose";
import {
  createForwardApp,
  type ForwardRequest,
  PLATFORM_CREDENTIALS,
} from "./test/helpers/forward-app";

const LIST_WALLETS = "/v1/forward/privy/v1/wallets";

async function ownAnswer(response: Response): Promise<{ result: string | null; body: unknown }> {
  return { result: response.headers.get("sdp-safe-proxy-result"), body: await response.json() };
}

describe("forward route refusals reach no provider", () => {
  const rows: (ForwardRequest & { name: string; code: SafeProxyCode })[] = [
    { name: "a token from another signer", untrustedToken: true, code: "unauthenticated" },
    {
      name: "no token, even naming a local caller",
      caller: null,
      headers: { [LOCAL_CALLER_HEADER]: "api" },
      code: "unauthenticated",
    },
    { name: "a caller not on the endpoint's list", caller: "cron", code: "caller_not_allowed" },
    {
      name: "a body over the size limit",
      method: "POST",
      body: "a".repeat(1024 * 1024 + 1),
      code: "invalid_request",
    },
    {
      name: "a body that is not valid UTF-8",
      method: "POST",
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
      code: "invalid_request",
    },
    {
      name: "a GET that declares a body",
      headers: { "content-length": "2" },
      code: "body_not_allowed",
    },
    {
      name: "a malformed request id",
      headers: { [FORWARD_HEADERS.requestId]: "req 7d1" },
      code: "invalid_request",
    },
    {
      name: "a reference to a customer secret",
      headers: {
        [FORWARD_HEADERS.credential]:
          "secret_manager_version:projects/sdp-test/secrets/privy-g96/versions/3",
      },
      code: "credential_store_unavailable",
    },
    {
      name: "a malformed credential reference",
      headers: { [FORWARD_HEADERS.credential]: "secret_manager_version:privy-g96" },
      code: "invalid_request",
    },
  ];
  for (const { name, code, ...request } of rows) {
    it(`refuses ${name}`, async () => {
      const forwardApp = createForwardApp();
      const response = await forwardApp.send(LIST_WALLETS, request);
      assert.deepEqual(await ownAnswer(response), { result: "refused", body: { code } });
      assert.equal(forwardApp.calls.length, 0);
    });
  }
});

describe("the provider call", () => {
  const forwardApp = createForwardApp();
  const body = '{"chain_type": "solana", "note": "é"}';
  before(() =>
    forwardApp.send(LIST_WALLETS, {
      method: "POST",
      body,
      headers: {
        "privy-idempotency-key": "idem-5e2",
        "privy-app-id": "caller-app",
        "x-api-key": "caller-key",
        cookie: "session=abc",
        "content-type": "text/plain",
      },
    })
  );

  it("carries only the declared request headers and the platform credential", () => {
    assert.deepEqual(forwardApp.calls[0]?.headers, {
      authorization: "Basic cHJpdnktYXBwLWEzMTpwcml2eS1zZWNyZXQtcTh6",
      "privy-app-id": "privy-app-a31",
      "privy-idempotency-key": "idem-5e2",
      "content-type": "application/json",
    });
  });

  it("sends the body it matched", () => {
    assert.equal(forwardApp.calls[0]?.body, body);
  });

  it("does not follow a redirect", () => {
    assert.equal(forwardApp.calls[0]?.redirect, "manual");
  });
});

describe("the provider answer", () => {
  let response: Response;
  before(async () => {
    const forwardApp = createForwardApp({
      answer: () =>
        new Response('{"code":"caller_not_allowed"}', {
          status: 403,
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=provider-7a2",
            "sdp-safe-proxy-result": "refused",
          },
        }),
    });
    response = await forwardApp.send(LIST_WALLETS);
  });

  it("comes back with only its content type", () => {
    assert.deepEqual([...response.headers.keys()], ["content-type", "sdp-safe-proxy-result"]);
    assert.equal(response.headers.get("content-type"), "application/json");
  });

  it("is marked forwarded even when it reads like a Safe Proxy refusal", async () => {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("sdp-safe-proxy-result"), "forwarded");
    assert.equal(await response.text(), '{"code":"caller_not_allowed"}');
  });

  it("is refused past the size limit", async () => {
    const forwardApp = createForwardApp({
      answer: () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    });
    const tooLarge = await forwardApp.send(LIST_WALLETS);
    assert.deepEqual(await ownAnswer(tooLarge), {
      result: "no_answer",
      body: { code: "provider_answer_too_large" },
    });
  });

  it("is no answer when the call fails after the request left", async () => {
    const forwardApp = createForwardApp({
      answer: () => Promise.reject(new TypeError("fetch failed")),
    });
    const failed = await forwardApp.send(LIST_WALLETS);
    assert.deepEqual(await ownAnswer(failed), {
      result: "no_answer",
      body: { code: "provider_no_answer" },
    });
    assert.equal(forwardApp.calls.length, 1);
  });
});

it("refuses a request whose deadline passes before it is sent", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reading!: () => void;
  const bodyRead = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const forwardApp = createForwardApp();
  const stalledBody = new ReadableStream<Uint8Array>(
    {
      pull: () => {
        reading();
        return new Promise(() => {});
      },
    },
    { highWaterMark: 0 }
  );

  const pending = forwardApp.send(LIST_WALLETS, { method: "POST", body: stalledBody });
  await bodyRead;
  t.mock.timers.tick(10_000);

  assert.deepEqual(await ownAnswer(await pending), {
    result: "refused",
    body: { code: "deadline_exceeded" },
  });
  assert.equal(forwardApp.calls.length, 0);
});

it("bounds the provider call by the budget the caller check left", {
  timeout: 5_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reached!: () => void;
  const providerReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const forwardApp = createForwardApp({
    keys: (trusted) => (header, token) => {
      t.mock.timers.tick(4_000);
      return trusted(header, token);
    },
    answer: ({ signal }) => {
      reached();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    },
  });

  const pending = forwardApp.send(LIST_WALLETS);
  await providerReached;
  t.mock.timers.tick(5_999);
  assert.equal(forwardApp.calls[0]?.signal?.aborted, false);
  t.mock.timers.tick(1);

  assert.deepEqual(await ownAnswer(await pending), {
    result: "no_answer",
    body: { code: "provider_no_answer" },
  });
});

it("signs the Fireblocks target and body exactly as forwarded", async () => {
  const forwardApp = createForwardApp();
  await forwardApp.send(
    "/v1/forward/fireblocks/v1/vault/accounts_paged?namePrefix=vault-e74&limit=5"
  );
  await forwardApp.send("/v1/forward/fireblocks/v1/transactions", {
    method: "POST",
    body: '{"operation":"TRANSFER"}',
  });

  const signed = forwardApp.calls.map(({ url, body, headers }) => {
    const { uri, bodyHash } = decodeJwt(headers.authorization?.replace(/^Bearer /, "") ?? "");
    return { url, body, uri, bodyHash };
  });
  assert.deepEqual(signed, [
    {
      url: "https://api.fireblocks.io/v1/vault/accounts_paged?namePrefix=vault-e74&limit=5",
      body: null,
      uri: "/v1/vault/accounts_paged?namePrefix=vault-e74&limit=5",
      bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    {
      url: "https://api.fireblocks.io/v1/transactions",
      body: '{"operation":"TRANSFER"}',
      uri: "/v1/transactions",
      bodyHash: "38ad69eb823eff0c4d8f416ceda77b9a1f5bcf32fce1892d8d6cc2a7386c4706",
    },
  ]);
});

it("logs no body, concrete path, credential, reference or error message", async () => {
  const forwardApp = createForwardApp({
    answer: () => new Response('{"signed":"resp-body-c63"}'),
  });
  await forwardApp.send("/v1/forward/privy/v1/wallets/wallet-d41/rpc", {
    method: "POST",
    body: '{"method":"signTransaction","params":{"transaction":"tx-body-b52"}}',
  });
  await forwardApp.send(LIST_WALLETS, {
    headers: {
      "sdp-safe-proxy-credential":
        "secret_manager_version:projects/sdp-test/secrets/privy-g96/versions/3",
    },
  });
  const failing = createForwardApp({
    credentials: {
      privy: PLATFORM_CREDENTIALS.privy,
      get fireblocks(): never {
        throw new Error("credential read failed peer-f85");
      },
    },
  });
  await failing.send("/v1/forward/fireblocks/v1/vault/accounts_paged?namePrefix=vault-e74");

  const lines = [...forwardApp.logged, ...failing.logged];
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).code),
    [null, "credential_store_unavailable", "internal"]
  );
  for (const kept of [
    "tx-body-b52",
    "resp-body-c63",
    "privy-g96",
    "privy-secret-q8z",
    "wallet-d41",
    "vault-e74",
    "peer-f85",
    ...forwardApp.tokens,
    ...failing.tokens,
  ]) {
    for (const line of lines) assert.ok(!line.includes(kept), `log line carries ${kept}`);
  }
});

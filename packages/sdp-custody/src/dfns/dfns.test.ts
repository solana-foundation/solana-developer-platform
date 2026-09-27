import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { SignerError } from "@solana/keychain-core";
import { createDfnsApiClient, DfnsSigner } from "./index";

/**
 * SOLA9-586 regression: a controlled provider must not be able to smuggle a
 * credential-shaped value through an upstream error body (or a response
 * header, or a 200-body `reason` field) into the signer error message that is
 * persisted on transfer failures, serialized into API responses, and scrubbed
 * as telemetry.
 */

const AUTH_TOKEN = "dfns-auth-token-value";
const CREDENTIAL_ID = "credential_poc";
const API_BASE_URL = "https://api.dfns.test";

type FetchHandler = (url: URL, init?: RequestInit) => Response | null;

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function stubFetch(handler: FetchHandler): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = handler(url, init);
    if (response) {
      return response;
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url.pathname}`);
  }) as typeof fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
}

function serveHandshake(handler: (url: URL, init?: RequestInit) => Response | null): void {
  stubFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/wallets/wa_poc") {
      return jsonResponse(
        {
          id: "wa_poc",
          address: "11111111111111111111111111111111",
          network: "SolanaDevnet",
          signingKey: { id: "key_poc" },
        },
        200
      );
    }
    if (method === "POST" && url.pathname === "/auth/action/init") {
      return jsonResponse(
        {
          challenge: "challenge_poc",
          challengeIdentifier: "challenge_id_poc",
          allowCredentials: { key: [{ id: CREDENTIAL_ID }] },
        },
        200
      );
    }
    if (method === "POST" && url.pathname === "/auth/action") {
      return jsonResponse({ userAction: "user_action_poc" }, 200);
    }
    return handler(url, init);
  });
}

async function createSigner(): Promise<DfnsSigner> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const client = await createDfnsApiClient(
    {
      DFNS_AUTH_TOKEN: AUTH_TOKEN,
      DFNS_CREDENTIAL_ID: CREDENTIAL_ID,
      DFNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    { apiBaseUrl: API_BASE_URL }
  );
  return DfnsSigner.create({ client, walletId: "wa_poc" });
}

async function captureSignerError(signer: DfnsSigner): Promise<Error> {
  try {
    await signer.signMessages([{ content: new Uint8Array([1, 2, 3]), signatures: {} }]);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected signMessages to reject");
}

describe("dfns signer upstream error redaction", () => {
  it("collapses a credential-shaped upstream code to unavailable", async () => {
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse({ code: "sk_live_platform_secret" }, 403);
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(error.message, /code=unavailable/);
    assert.ok(!error.message.includes("sk_live_platform_secret"));
    assert.ok(!error.message.includes(AUTH_TOKEN));
  });

  it("omits a credential-shaped reason from a failed signature request", async () => {
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse(
          { id: "sig_poc", status: "Failed", reason: "sk_live_platform_secret" },
          200
        );
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(error.message, /signature request failed \(Failed\)(?!:)/);
    assert.ok(!error.message.includes("sk_live_platform_secret"));
  });

  it("collapses a provider echo of the configured auth token to unavailable", async () => {
    // Greptile finding on this PR: the auth token (`dfns-auth-token-value`) is
    // short, separator-friendly, and carries no known credential prefix, so the
    // shape filter alone accepts it — only exact matching against the held
    // secret closes the echo of exactly what the provider was sent.
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse({ code: AUTH_TOKEN }, 403);
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(error.message, /code=unavailable/);
    assert.ok(!error.message.includes(AUTH_TOKEN));
  });

  it("omits a provider echo of the configured auth token from a failed signature request", async () => {
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse({ id: "sig_poc", status: "Failed", reason: AUTH_TOKEN }, 200);
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(error.message, /signature request failed \(Failed\)(?!:)/);
    assert.ok(!error.message.includes(AUTH_TOKEN));
  });

  it("keeps an identifier-shaped reason from a failed signature request", async () => {
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse({ id: "sig_poc", status: "Failed", reason: "POLICY_REJECTED" }, 200);
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.ok(error.message.includes("signature request failed (Failed): POLICY_REJECTED"));
  });

  it("still surfaces a provider enum code and known content type", async () => {
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse({ error: { code: "NotEnoughPrecision" } }, 403);
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(error.message, /status=403/);
    assert.match(error.message, /contentType=application\/json/);
    assert.match(error.message, /code=NotEnoughPrecision/);
  });

  it("does not echo an unrecognized provider-controlled content type", async () => {
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse({ code: "UNAVAILABLE" }, 403, {
          "Content-Type": "sk_live_platform_secret",
        });
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(error.message, /contentType=unrecognized/);
    assert.ok(!error.message.includes("sk_live_platform_secret"));
  });

  it("does not echo the user action token from a redirect follow-up error", async () => {
    // Greptile finding on this PR: the original POST carries the short,
    // separator-bearing `x-dfns-useraction` token, and a provider answering the
    // same-origin redirect follow-up can echo that token back in the follow-up
    // error body — so the token must be held as a known secret there too.
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return new Response(null, {
          status: 307,
          headers: { Location: "/keys/key_poc/signatures/follow_poc" },
        });
      }
      if (
        (init?.method ?? "GET") === "GET" &&
        url.pathname === "/keys/key_poc/signatures/follow_poc"
      ) {
        return jsonResponse({ code: "user_action_poc" }, 403);
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(
      error.message,
      /redirect follow-up failed \(POST \/keys\/key_poc\/signatures\): status=403 code=unavailable/
    );
    assert.ok(!error.message.includes("user_action_poc"));
  });

  it("omits a provider echo of the user action token from a failed signature request", async () => {
    // Greptile finding on this PR (re-review of the redirect fix): the token
    // is minted inside the client at request time, after the signer's known
    // secret snapshot was taken — so a 200 signature status echoing it back in
    // `reason` still surfaced it. Reason vetting must see tokens minted after
    // client construction.
    serveHandshake((url, init) => {
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/keys/key_poc/signatures") {
        return jsonResponse({ id: "sig_poc", status: "Failed", reason: "user_action_poc" }, 200);
      }
      return null;
    });

    const signer = await createSigner();
    const error = await captureSignerError(signer);

    assert.ok(error instanceof SignerError);
    assert.match(error.message, /signature request failed \(Failed\)(?!:)/);
    assert.ok(!error.message.includes("user_action_poc"));
  });
});

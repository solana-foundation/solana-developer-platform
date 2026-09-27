import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { SignerError } from "@solana/keychain-core";
import type { DfnsApiClient } from "./client";
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

type FetchHandler = (url: URL, init?: RequestInit) => Response | null | Promise<Response | null>;

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

function serveHandshake(
  handler: FetchHandler,
  options?: { userActionTokens?: () => string }
): void {
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
      return jsonResponse(
        { userAction: options?.userActionTokens ? options.userActionTokens() : "user_action_poc" },
        200
      );
    }
    return handler(url, init);
  });
}

async function createTestClientAndSigner(options?: {
  now?: () => number;
}): Promise<{ client: DfnsApiClient; signer: DfnsSigner }> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const client = await createDfnsApiClient(
    {
      DFNS_AUTH_TOKEN: AUTH_TOKEN,
      DFNS_CREDENTIAL_ID: CREDENTIAL_ID,
      DFNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    { apiBaseUrl: API_BASE_URL, now: options?.now }
  );
  return { client, signer: await DfnsSigner.create({ client, walletId: "wa_poc" }) };
}

async function createSigner(): Promise<DfnsSigner> {
  const { signer } = await createTestClientAndSigner();
  return signer;
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

  it("holds a pending signature's token however many newer requests are minted", async () => {
    // Greptile finding on this PR: a short-lived register evicts a pending
    // signature's user action token once enough newer requests are minted, so
    // the failed result's `reason` echo of that token would survive vetting.
    // Tokens are therefore held for a retention window far beyond any poll.
    let mint = 0;
    let lastMintedToken = "";
    let signatureToken = "";
    let polls = 0;
    serveHandshake(
      (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/keys/key_poc/signatures") {
          signatureToken = lastMintedToken;
          return jsonResponse({ id: "sig_poc", status: "Pending" }, 200);
        }
        if (method === "GET" && url.pathname === "/keys/key_poc/signatures/sig_poc") {
          polls += 1;
          if (polls < 2) {
            return jsonResponse({ id: "sig_poc", status: "Pending" }, 200);
          }
          return jsonResponse({ id: "sig_poc", status: "Failed", reason: signatureToken }, 200);
        }
        if (method === "POST" && url.pathname === "/wallets") {
          return jsonResponse({ id: `wa_${mint}`, network: "SolanaDevnet" }, 200);
        }
        return null;
      },
      { userActionTokens: () => (lastMintedToken = `user_action_${++mint}`) }
    );

    const { client, signer } = await createTestClientAndSigner();
    let caught: unknown;
    const signing = signer
      .signMessages([{ content: new Uint8Array([1, 2, 3]), signatures: {} }])
      .catch((error) => {
        caught = error;
      });
    for (let index = 0; index < 16; index += 1) {
      await client.wallets.createWallet({ body: { network: "SolanaDevnet" } });
    }
    await signing;

    assert.ok(caught instanceof SignerError);
    assert.ok(signatureToken.length > 0);
    assert.match(caught.message, /signature request failed \(Failed\)(?!:)/);
    assert.ok(!caught.message.includes(signatureToken));
    // The token is held for the whole retention window, so it stays covered
    // against echoes in later responses too.
    assert.ok((client.getKnownUpstreamSecrets?.() ?? []).includes(signatureToken));
  });

  it("does not release another signature's held token when a poll response names a different ID", async () => {
    // Greptile finding on this PR (re-review of the token retention): the
    // token store is shared across concurrent signatures, and a poll response
    // naming another pending signature's ID must not release that
    // signature's token.
    let mint = 0;
    let lastMintedToken = "";
    let signatureToken = "";
    serveHandshake(
      (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/keys/key_poc/signatures") {
          signatureToken = lastMintedToken;
          return jsonResponse({ id: "sig_poc", status: "Pending" }, 200);
        }
        if (method === "GET" && url.pathname === "/keys/key_poc/signatures/sig_poc") {
          // Hostile poll response: terminal, for a different signature.
          return jsonResponse({ id: "sig_other", status: "Failed", reason: "unrelated" }, 200);
        }
        if (method === "POST" && url.pathname === "/wallets") {
          return jsonResponse({ id: `wa_${mint}`, network: "SolanaDevnet" }, 200);
        }
        return null;
      },
      { userActionTokens: () => (lastMintedToken = `user_action_${++mint}`) }
    );

    const { client, signer } = await createTestClientAndSigner();
    let caught: unknown;
    const signing = signer
      .signMessages([{ content: new Uint8Array([1, 2, 3]), signatures: {} }])
      .catch((error) => {
        caught = error;
      });
    for (let index = 0; index < 16; index += 1) {
      await client.wallets.createWallet({ body: { network: "SolanaDevnet" } });
    }
    await signing;

    assert.ok(caught instanceof SignerError);
    assert.ok(signatureToken.length > 0);
    assert.match(caught.message, /poll returned a different request ID/);
    assert.ok(!caught.message.includes(signatureToken));
    // sig_poc's token was not released by the mismatched response, and stays
    // held even though the register alone would have evicted it.
    assert.ok((client.getKnownUpstreamSecrets?.() ?? []).includes(signatureToken));
  });

  it("holds both tokens when two signature requests receive the same provider ID", async () => {
    // Greptile finding on this PR (re-review of the keyed retention): a
    // provider reusing a pending signature's ID must not be able to unprotect
    // either signature's token. Retention is keyed by token value and time,
    // not by provider-supplied IDs, so both stay held.
    let mint = 0;
    let lastMintedToken = "";
    const createdTokens: string[] = [];
    serveHandshake(
      (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/keys/key_poc/signatures") {
          createdTokens.push(lastMintedToken);
          return jsonResponse({ id: "sig_poc", status: "Pending" }, 200);
        }
        if (method === "POST" && url.pathname === "/wallets") {
          return jsonResponse({ id: `wa_${mint}`, network: "SolanaDevnet" }, 200);
        }
        return null;
      },
      { userActionTokens: () => (lastMintedToken = `user_action_${++mint}`) }
    );

    const { client } = await createTestClientAndSigner();
    await client.keySignatures.createSignature({
      keyId: "key_poc",
      body: { kind: "Message", message: "0x010203" },
    });
    await client.keySignatures.createSignature({
      keyId: "key_poc",
      body: { kind: "Message", message: "0x010204" },
    });
    for (let index = 0; index < 16; index += 1) {
      await client.wallets.createWallet({ body: { network: "SolanaDevnet" } });
    }

    const secrets = client.getKnownUpstreamSecrets?.() ?? [];
    assert.ok(secrets.includes(createdTokens[0]));
    assert.ok(secrets.includes(createdTokens[1]));
  });

  it("keeps a shared token value held while any signature still holds it", async () => {
    // Greptile finding on this PR (re-review of the pin): a provider repeating
    // a user-action token value for two pending signatures must not let one
    // signature's release unprotect the other. Holds are counted per value,
    // and the value stays held until every hold is dropped.
    const held: string[] = [];
    serveHandshake(
      (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/keys/key_poc/signatures") {
          return jsonResponse({ id: `sig_${held.length}_poc`, status: "Pending" }, 200);
        }
        return null;
      },
      {
        userActionTokens: () => {
          held.push("user_action_dup");
          return "user_action_dup";
        },
      }
    );

    const { client } = await createTestClientAndSigner();
    const first = await client.keySignatures.createSignature({
      keyId: "key_poc",
      body: { kind: "Message", message: "0x010203" },
    });
    const second = await client.keySignatures.createSignature({
      keyId: "key_poc",
      body: { kind: "Message", message: "0x010204" },
    });

    const secrets = () => client.getKnownUpstreamSecrets?.() ?? [];
    assert.ok(secrets().includes("user_action_dup"));
    first.releaseHeldUpstreamSecret?.();
    // The second signature still holds it.
    assert.ok(secrets().includes("user_action_dup"));
    second.releaseHeldUpstreamSecret?.();
    // Both holds dropped: the token ages out of the retention window normally
    // rather than being swept while a signature is still pending.
    assert.ok(secrets().includes("user_action_dup"));
  });

  it("drops a failed signature create's hold on its token", async () => {
    // Greptile finding on this PR (P2): a create that fails (HTTP error,
    // non-JSON body) never attaches a release handle, so its pin would stick
    // until the hold cap. The failure path drops the pin instead, and the
    // token keeps ordinary retention-window coverage for echoes — then ages
    // out of it on a later sweep, proving the hold was dropped.
    let clock = 1_000_000_000;
    let mint = 0;
    serveHandshake(
      (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/keys/key_poc/signatures") {
          return jsonResponse({ code: "sk_live_platform_secret" }, 403);
        }
        if (method === "POST" && url.pathname === "/wallets") {
          return jsonResponse({ id: "wa_later", network: "SolanaDevnet" }, 200);
        }
        return null;
      },
      {
        // The failed create mints first; any later mint uses another value so
        // the sweep below cannot be fooled by a re-recorded entry.
        userActionTokens: () => {
          mint += 1;
          return mint === 1 ? "user_action_poc" : `user_action_later_${mint}`;
        },
      }
    );

    const { client } = await createTestClientAndSigner({ now: () => clock });
    await assert.rejects(
      client.keySignatures.createSignature({
        keyId: "key_poc",
        body: { kind: "Message", message: "0x010203" },
      })
    );
    // Still covered for the retention window, no longer pinned.
    assert.ok((client.getKnownUpstreamSecrets?.() ?? []).includes("user_action_poc"));
    // Two hours later a new mint (a different token value) sweeps the
    // aged-out, unpinned token: had the failed create leaked its hold, the
    // token would still be in the set.
    clock += 2 * 3_600_000;
    await client.wallets.createWallet({ body: { network: "SolanaDevnet" } });
    assert.ok(!(client.getKnownUpstreamSecrets?.() ?? []).includes("user_action_poc"));
    assert.ok(
      (client.getKnownUpstreamSecrets?.() ?? []).some((secret) =>
        secret.startsWith("user_action_later")
      )
    );
  });

  it("keeps a pending signature's token held past any time cap until its result is handled", async () => {
    // Greptile verdict on this PR: a time cap on holds strips a still-pending
    // signature's token of protection — a sweep deletes it, and the eventual
    // failed result echoing the token back survives vetting. Holds are never
    // capped in time: the token stays held until the signer releases it,
    // however long the result takes.
    let clock = 1_000_000_000;
    let signatureToken = "";
    let polls = 0;
    let mint = 0;
    let created!: () => void;
    const createdPromise = new Promise<void>((resolve) => {
      created = resolve;
    });
    let releasePoll!: () => void;
    const releasePollPromise = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    serveHandshake(
      async (url, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/keys/key_poc/signatures") {
          return jsonResponse({ id: "sig_poc", status: "Pending" }, 200);
        }
        if (method === "GET" && url.pathname === "/keys/key_poc/signatures/sig_poc") {
          polls += 1;
          if (polls < 2) {
            // The create has minted and pinned the token by its first poll.
            created();
            return jsonResponse({ id: "sig_poc", status: "Pending" }, 200);
          }
          // Hold the failed result until the sweeps below have run.
          await releasePollPromise;
          return jsonResponse({ id: "sig_poc", status: "Failed", reason: signatureToken }, 200);
        }
        if (method === "POST" && url.pathname === "/wallets") {
          return jsonResponse({ id: `wa_${clock}`, network: "SolanaDevnet" }, 200);
        }
        return null;
      },
      {
        // The signature create mints first; later mints use other values so a
        // sweep cannot be fooled into holding the token by a re-recorded
        // entry minted after the pending one.
        userActionTokens: () => {
          mint += 1;
          if (mint === 1) {
            signatureToken = "user_action_poc";
            return signatureToken;
          }
          return `user_action_later_${mint}`;
        },
      }
    );

    const { client, signer } = await createTestClientAndSigner({ now: () => clock });
    let caught: unknown;
    const signing = signer
      .signMessages([{ content: new Uint8Array([1, 2, 3]), signatures: {} }])
      .catch((error) => {
        caught = error;
      });

    await createdPromise;
    // A day later, a new mint triggers a sweep — a 24-hour hold cap would
    // have deleted the pending signature's pinned token by now.
    clock += 25 * 3_600_000;
    await client.wallets.createWallet({ body: { network: "SolanaDevnet" } });
    assert.ok((client.getKnownUpstreamSecrets?.() ?? []).includes("user_action_poc"));

    releasePoll();
    await signing;
    assert.ok(caught instanceof SignerError);
    assert.match(caught.message, /signature request failed \(Failed\)(?!:)/);
    assert.ok(!caught.message.includes("user_action_poc"));
  });
});

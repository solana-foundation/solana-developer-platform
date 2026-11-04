import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ManagedRampKeysEnv } from "@/services/ramps/runtime";
import { hercleWebhook } from "@/services/ramps/webhooks/hercle";

function webhookKeyPair(): { privateKey: KeyObject; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

const SANDBOX_KEY = webhookKeyPair();
const PRODUCTION_KEY = webhookKeyPair();

const HERCLE_ENV = {
  HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: SANDBOX_KEY.publicKeyPem,
} satisfies ManagedRampKeysEnv;

const DELIVERY_SIGNATURE =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const DELIVERY_WALLET = "8mSiNWTeu59yy1pxsoNCyy7KNMnKvfgGu8Ej975LsufM";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Signs `rawBody` as Hercle does: base64 DER ECDSA over `${timestamp}.${rawBody}`. */
function signHercleBody(rawBody: string, timestamp: number, privateKey: KeyObject): string {
  return createSign("SHA256").update(`${timestamp}.${rawBody}`).sign(privateKey, "base64");
}

function settlementBody(data: Record<string, unknown>): string {
  return JSON.stringify({ event: "ramp.settlement.status_changed", timestamp: nowSeconds(), data });
}

/** Verifies `rawBody` signed with `privateKey` (the sandbox one by default) at the `environment` endpoint. */
async function verifySigned(
  rawBody: string,
  environment: "sandbox" | "production",
  {
    env = HERCLE_ENV,
    privateKey = SANDBOX_KEY.privateKey,
    timestamp = nowSeconds(),
  }: { env?: ManagedRampKeysEnv; privateKey?: KeyObject; timestamp?: number } = {}
) {
  await hercleWebhook.verify({
    env,
    environment,
    headers: new Headers({
      "X-Signature": signHercleBody(rawBody, timestamp, privateKey),
      "X-Timestamp": String(timestamp),
    }),
    rawBody,
  });
  return hercleWebhook.parse(rawBody, environment);
}

describe("hercleWebhook", () => {
  it("has no delivery id to deduplicate on", () => {
    expect(
      hercleWebhook.eventId(settlementBody({ reference: "ord_1", status: "settled" }))
    ).toBeNull();
  });

  it("maps order statuses to settlement event kinds, keyed on the order id", () => {
    const parse = (data: Record<string, unknown>) => hercleWebhook.parse(settlementBody(data));

    expect(parse({ reference: "ord_1", status: "awaiting_payment" })).toEqual({
      provider: "hercle",
      kind: "awaiting_payment",
      reference: "ord_1",
    });
    expect(parse({ reference: "ord_1", status: "settling" })).toEqual({
      provider: "hercle",
      kind: "settling",
      reference: "ord_1",
    });
    expect(
      parse({ reference: "ord_1", status: "expired", error: "FUNDING_WINDOW_EXPIRED" })
    ).toEqual({
      provider: "hercle",
      kind: "expired",
      reference: "ord_1",
      error: "The order's funding window closed before the wire arrived.",
    });
    expect(parse({ reference: "ord_1", status: "failed", error: "THIRD_PARTY_PAYER" })).toEqual({
      provider: "hercle",
      kind: "failed",
      reference: "ord_1",
      error: "The wire came from an account other than the business's own.",
    });
  });

  it("never reads the settled order's fiat amount as the crypto delivered", () => {
    expect(
      hercleWebhook.parse(
        settlementBody({ reference: "ord_1", status: "settled", receivedAmount: "100.00" })
      )
    ).toEqual({ provider: "hercle", kind: "settled", reference: "ord_1" });
  });

  it("hands a settled order's delivery to the chain verifier", () => {
    expect(
      hercleWebhook.parse(
        settlementBody({
          reference: "ord_1",
          status: "settled",
          txHash: DELIVERY_SIGNATURE,
          destinationWalletAddress: DELIVERY_WALLET,
        })
      )
    ).toEqual({
      provider: "hercle",
      kind: "settled",
      reference: "ord_1",
      onchain: { signature: DELIVERY_SIGNATURE, destinationAddress: DELIVERY_WALLET },
    });
  });

  it("keeps Hercle's own error codes out of the transfer row", () => {
    expect(
      hercleWebhook.parse(
        settlementBody({ reference: "ord_1", status: "failed", error: "BANK_SAID_NO" })
      )
    ).toEqual({
      provider: "hercle",
      kind: "failed",
      reference: "ord_1",
      error: "Hercle failed the order.",
    });
  });

  it("holds an order status SDP does not know instead of guessing", () => {
    expect(
      hercleWebhook.parse(settlementBody({ reference: "ord_1", status: "refunding" }))
    ).toEqual({
      provider: "hercle",
      kind: "ignore",
      reason: "unsupported_status:refunding",
      unmappedStatus: "refunding",
    });
  });

  it("ignores verification events and events it does not read", () => {
    for (const event of ["customer.verification.status_changed", "account.created"]) {
      expect(
        hercleWebhook.parse(
          JSON.stringify({
            event,
            timestamp: nowSeconds(),
            data: { accountId: "acct_1", status: "approved" },
          })
        )
      ).toEqual({ provider: "hercle", kind: "ignore", reason: `unsupported_event:${event}` });
    }
  });

  it("throws on a broken envelope so Hercle redelivers", () => {
    expect(() => hercleWebhook.parse("{bad-json")).toThrow("must be valid JSON");
    expect(() => hercleWebhook.parse(JSON.stringify({ data: {} }))).toThrow(
      "missing its event name"
    );
    expect(() =>
      hercleWebhook.parse(JSON.stringify({ event: "ramp.settlement.status_changed", timestamp: 1 }))
    ).toThrow("missing its data envelope");
    expect(() => hercleWebhook.parse(settlementBody({ status: "settled" }))).toThrow(
      "carries a malformed order"
    );
    expect(() => hercleWebhook.parse(settlementBody({ reference: "ord_1" }))).toThrow(
      "carries a malformed order"
    );
  });

  it("accepts a correctly signed webhook and returns its raw body", async () => {
    const rawBody = settlementBody({ reference: "ord_1", status: "settled" });
    const timestamp = nowSeconds();
    await expect(
      hercleWebhook.verify({
        env: HERCLE_ENV,
        environment: "sandbox",
        headers: new Headers({
          "X-Signature": signHercleBody(rawBody, timestamp, SANDBOX_KEY.privateKey),
          "X-Timestamp": String(timestamp),
        }),
        rawBody,
      })
    ).resolves.toBe(rawBody);
  });

  it("rejects a forged, tampered, unsigned or untimed delivery", async () => {
    const rawBody = settlementBody({ reference: "ord_1", status: "settled" });
    const timestamp = nowSeconds();
    const signature = signHercleBody(rawBody, timestamp, SANDBOX_KEY.privateKey);
    const verify = (headers: Record<string, string>, body = rawBody) =>
      hercleWebhook.verify({
        env: HERCLE_ENV,
        environment: "sandbox",
        headers: new Headers(headers),
        rawBody: body,
      });

    await expect(
      verify({ "X-Signature": signature, "X-Timestamp": String(timestamp) }, `${rawBody} `)
    ).rejects.toThrow(/Invalid hercle webhook signature/);
    await expect(
      verify({
        "X-Signature": signHercleBody(rawBody, timestamp, PRODUCTION_KEY.privateKey),
        "X-Timestamp": String(timestamp),
      })
    ).rejects.toThrow(/Invalid hercle webhook signature/);
    await expect(
      verify({ "X-Signature": "bm90LWEtc2lnbmF0dXJl", "X-Timestamp": String(timestamp) })
    ).rejects.toThrow(/Invalid hercle webhook signature/);
    await expect(verify({ "X-Timestamp": String(timestamp) })).rejects.toThrow(
      "missing the X-Signature header"
    );
    await expect(verify({ "X-Signature": signature })).rejects.toThrow(
      "missing the X-Timestamp header"
    );
    await expect(verify({ "X-Signature": signature, "X-Timestamp": "yesterday" })).rejects.toThrow(
      /Invalid hercle webhook timestamp/
    );
  });

  it("rejects a correctly signed but stale webhook", async () => {
    await expect(
      verifySigned(settlementBody({ reference: "ord_1", status: "settled" }), "sandbox", {
        timestamp: nowSeconds() - 3600,
      })
    ).rejects.toThrow(/tolerance window/i);
  });

  it("refuses the production endpoint while no production key is mounted", async () => {
    await expect(
      verifySigned(settlementBody({ reference: "ord_1", status: "settled" }), "production", {
        privateKey: PRODUCTION_KEY.privateKey,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("verifies the production endpoint with the production key, never the sandbox one", async () => {
    const env = {
      ...HERCLE_ENV,
      HERCLE_PRODUCTION_WEBHOOK_PUBLIC_KEY: PRODUCTION_KEY.publicKeyPem,
    } satisfies ManagedRampKeysEnv;
    const rawBody = settlementBody({ reference: "ord_1", status: "settled" });
    await expect(verifySigned(rawBody, "production", { env })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      verifySigned(rawBody, "production", { env, privateKey: PRODUCTION_KEY.privateKey })
    ).resolves.toMatchObject({ kind: "settled", reference: "ord_1" });
  });

  it("verifies with a public key mounted on one line with literal \\n escapes", async () => {
    const env = {
      HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: SANDBOX_KEY.publicKeyPem.trim().replace(/\n/g, "\\n"),
    } satisfies ManagedRampKeysEnv;
    await expect(
      verifySigned(settlementBody({ reference: "ord_1", status: "settling" }), "sandbox", { env })
    ).resolves.toMatchObject({ kind: "settling" });
  });
});

import { getBase64Codec } from "@solana/codecs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as guardedEgress from "@/services/guarded-egress";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";

const productionEnv: Env = { ENVIRONMENT: "production", API_VERSION: "v1" };
const SIGNED_TX_BASE64 = getBase64Codec().decode(new Uint8Array(8).fill(1));
const TENANT_RPC_URL = "https://rings-tenant.example.com/rpc";
const LOOPBACK_RPC_URL = "https://127.0.0.1/rpc";
const SIGNATURE = "1".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("submitRingsOuterTransaction with a persisted connection URL", () => {
  it("dials the tenant URL through the egress guard outside development", async () => {
    const guardedFetch = vi.spyOn(guardedEgress, "guardedFetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "0", result: SIGNATURE }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      submitRingsOuterTransaction({
        env: productionEnv,
        signedTxBase64: SIGNED_TX_BASE64,
        rpcUrl: TENANT_RPC_URL,
      })
    ).resolves.toBe(SIGNATURE);

    expect(guardedFetch).toHaveBeenCalledExactlyOnceWith(
      TENANT_RPC_URL,
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a loopback tenant URL before any request leaves", async () => {
    const guardedFetch = vi.spyOn(guardedEgress, "guardedFetch");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const outcome = submitRingsOuterTransaction({
      env: productionEnv,
      signedTxBase64: SIGNED_TX_BASE64,
      rpcUrl: LOOPBACK_RPC_URL,
    });

    await expect(outcome).rejects.toBeInstanceOf(RingsAdapterError);
    await expect(outcome).rejects.toHaveProperty("failureCode", "submit_failed");
    await expect(outcome).rejects.toHaveProperty(
      "cause",
      expect.any(guardedEgress.EgressBlockedError)
    );
    expect(guardedFetch).toHaveBeenCalledExactlyOnceWith(
      LOOPBACK_RPC_URL,
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

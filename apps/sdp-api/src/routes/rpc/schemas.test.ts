import { describe, expect, it } from "vitest";
import { RPC_RELAY_MAX_BATCH, rpcRelayPayloadSchema } from "@/routes/rpc/schemas";

describe("rpcRelayPayloadSchema", () => {
  const request = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [] });

  it("accepts a standard Solana method", () => {
    expect(rpcRelayPayloadSchema.safeParse(request("getVersion")).success).toBe(true);
    expect(rpcRelayPayloadSchema.safeParse(request("getAccountInfo")).success).toBe(true);
    expect(rpcRelayPayloadSchema.safeParse(request("sendTransaction")).success).toBe(true);
  });

  it("accepts a batch of standard methods", () => {
    expect(
      rpcRelayPayloadSchema.safeParse([request("getBalance"), request("getSlot")]).success
    ).toBe(true);
  });

  it("refuses a method outside the Solana JSON-RPC surface", () => {
    expect(rpcRelayPayloadSchema.safeParse(request("qn_estimatePriorityFees")).success).toBe(false);
    expect(rpcRelayPayloadSchema.safeParse(request("eth_call")).success).toBe(false);
  });

  it("refuses a method hidden inside a batch", () => {
    expect(
      rpcRelayPayloadSchema.safeParse([request("getVersion"), request("shutdown")]).success
    ).toBe(false);
  });

  it("bounds the batch size", () => {
    const batch = Array.from({ length: RPC_RELAY_MAX_BATCH + 1 }, () => request("getSlot"));
    expect(rpcRelayPayloadSchema.safeParse(batch).success).toBe(false);
    expect(rpcRelayPayloadSchema.safeParse(batch.slice(1)).success).toBe(true);
  });

  it("refuses an empty batch", () => {
    expect(rpcRelayPayloadSchema.safeParse([]).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { PrivateOperation } from "../types";
import { InMemoryRingsGateway } from "./in-memory-gateway";

const OPERATION = {
  walletId: "hrw_1",
  opType: "shield",
  intentKey: "sha256:abc",
} as PrivateOperation;

describe("InMemoryRingsGateway", () => {
  it("is deterministic: same inputs produce identical outputs", async () => {
    const a = new InMemoryRingsGateway({ now: () => "2026-08-17T00:00:00.000Z" });
    const b = new InMemoryRingsGateway({ now: () => "2026-08-17T00:00:00.000Z" });

    const [identityA, identityB] = await Promise.all([
      a.provisionIdentity({ walletId: "hrw_1", sdpAddress: "addr" }),
      b.provisionIdentity({ walletId: "hrw_1", sdpAddress: "addr" }),
    ]);
    expect(identityA.shieldedAddress).toBe(identityB.shieldedAddress);
    expect(identityA.keyRefs[0].material.reveal("test")).toEqual(
      identityB.keyRefs[0].material.reveal("test")
    );

    const [builtA, builtB] = await Promise.all([
      a.buildOperation({ operation: OPERATION, keyRefs: [] }),
      b.buildOperation({ operation: OPERATION, keyRefs: [] }),
    ]);
    expect(builtA.outerUnsignedTxBase64).toBe(builtB.outerUnsignedTxBase64);
  });

  it("returns all-green health by default and honours an override", async () => {
    expect(await new InMemoryRingsGateway().probeHealth()).toEqual({
      rpc: "green",
      prover: "green",
      photon: "green",
      gateway: "green",
    });

    const degraded = new InMemoryRingsGateway({
      health: { rpc: "green", prover: "red", photon: "amber", gateway: "green" },
    });
    expect((await degraded.probeHealth()).prover).toBe("red");
  });

  it("provisions exactly a viewing and a nullifier key, both simulated", async () => {
    const identity = await new InMemoryRingsGateway().provisionIdentity({
      walletId: "hrw_1",
      sdpAddress: "addr",
    });

    expect(identity.keyRefs.map((keyRef) => keyRef.kind)).toEqual(["viewing", "nullifier"]);
    expect(identity.keyRefs.every((keyRef) => keyRef.materialTag === "simulated")).toBe(true);
    // The wrapper must be real — the downstream chain handles SecretRef before
    // the live adapter exists.
    expect(JSON.stringify(identity.keyRefs[0].material)).toBe('"[REDACTED]"');
  });

  it("advances a monotonic sync cursor per wallet", async () => {
    const gateway = new InMemoryRingsGateway();

    expect((await gateway.syncPhoton({ walletId: "hrw_1", cursor: null })).cursor).toBe("slot:1");
    expect((await gateway.syncPhoton({ walletId: "hrw_1", cursor: "slot:1" })).cursor).toBe(
      "slot:2"
    );
    expect((await gateway.syncPhoton({ walletId: "hrw_2", cursor: null })).cursor).toBe("slot:1");
  });

  it("always marks proofs simulated", async () => {
    const proof = await new InMemoryRingsGateway({
      now: () => "2026-08-17T00:00:00.000Z",
    }).requestProof({ operationId: "hro_1", ringsMetadata: {} as never });

    expect(proof.source).toBe("simulated");
    expect(proof.createdAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("reports indexed only after the delay elapses on the injected clock", async () => {
    let now = "2026-08-17T00:00:00.000Z";
    const gateway = new InMemoryRingsGateway({ now: () => now, indexingDelayMs: 1000 });

    expect(await gateway.verifyIndexed("sig")).toBeNull();

    gateway.recordSubmission("sig");
    expect(await gateway.verifyIndexed("sig")).toBeNull();

    now = "2026-08-17T00:00:01.000Z";
    expect(await gateway.verifyIndexed("sig")).toMatchObject({ indexedAt: now });
  });

  it("lets a test inject a signable unsigned tx", async () => {
    const gateway = new InMemoryRingsGateway({ buildUnsignedTx: () => "c2lnbmFibGU=" });

    const built = await gateway.buildOperation({ operation: OPERATION, keyRefs: [] });
    expect(built.outerUnsignedTxBase64).toBe("c2lnbmFibGU=");
  });
});

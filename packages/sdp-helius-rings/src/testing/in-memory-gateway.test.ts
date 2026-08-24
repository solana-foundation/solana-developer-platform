import { describe, expect, it } from "vitest";
import type { PrivateOperation } from "../types";
import { InMemoryRingsGateway } from "./in-memory-gateway";

const OPERATION = {
  walletId: "hrw_1",
  opType: "shield",
  intentKey: "sha256:abc",
} as PrivateOperation;

const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("InMemoryRingsGateway", () => {
  it("is deterministic: same inputs produce identical outputs", async () => {
    const a = new InMemoryRingsGateway({ now: () => "2026-08-17T00:00:00.000Z" });
    const b = new InMemoryRingsGateway({ now: () => "2026-08-17T00:00:00.000Z" });

    const [identityA, identityB] = await Promise.all([
      a.provisionIdentity({ walletId: "hrw_1", sdpAddress: "addr" }),
      b.provisionIdentity({ walletId: "hrw_1", sdpAddress: "addr" }),
    ]);
    expect(identityA).toEqual(identityB);

    const [builtA, builtB] = await Promise.all([
      a.buildOperation({ operation: OPERATION, owner: OWNER }),
      b.buildOperation({ operation: OPERATION, owner: OWNER }),
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

  it("provisions a registered, merge-enabled identity owned by the SDP address", async () => {
    const result = await new InMemoryRingsGateway().provisionIdentity({
      walletId: "hrw_1",
      sdpAddress: "addr",
    });

    expect(result.identity.owner).toBe("addr");
    expect(result.identity.shieldedAddress).toMatch(/^rings1/);
    expect(result.registrationSignatures).toHaveLength(1);
    expect(result.mergingEnabled).toBe(true);
  });

  it("keeps gateway state and proof references redacted when serialized", async () => {
    const gateway = new InMemoryRingsGateway({ now: () => "2026-08-17T00:00:00.000Z" });

    const built = await gateway.buildOperation({ operation: OPERATION, owner: OWNER });
    expect(JSON.stringify(built.ringsMetadata)).toBe('"[REDACTED]"');

    const proof = await gateway.requestProof({
      operationId: "hro_1",
      ringsMetadata: built.ringsMetadata,
    });
    expect(JSON.stringify(proof.ref)).toBe('"[REDACTED]"');
  });

  it("reports a fresh full sync per call, without taking a resume position", async () => {
    const gateway = new InMemoryRingsGateway({ now: () => "2026-08-17T00:00:00.000Z" });

    const first = await gateway.syncPhoton({ walletId: "hrw_1", owner: OWNER });
    expect(first.report.storedNotes).toBe(1);
    expect(first.balances[0].amountRaw).toBe("1000000000");
    expect(first.observedAt).toBe("2026-08-17T00:00:00.000Z");

    const second = await gateway.syncPhoton({ walletId: "hrw_1", owner: OWNER });
    expect(second.report.storedNotes).toBe(2);

    // Per-wallet, so one wallet's syncs cannot advance another's.
    expect((await gateway.syncPhoton({ walletId: "hrw_2", owner: OWNER })).report.storedNotes).toBe(
      1
    );
  });

  it("reports a clean sync as not degraded", async () => {
    const { report, history } = await new InMemoryRingsGateway().syncPhoton({
      walletId: "hrw_1",
      owner: OWNER,
    });

    expect(report.degraded).toBe(false);
    expect(report.unparsedTransactions).toBe(0);
    expect(report.undecryptableCandidates).toBe(0);
    expect(history[0]).toMatchObject({ kind: "shield", direction: "inbound" });
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

    const built = await gateway.buildOperation({ operation: OPERATION, owner: OWNER });
    expect(built.outerUnsignedTxBase64).toBe("c2lnbmFibGU=");
  });
});

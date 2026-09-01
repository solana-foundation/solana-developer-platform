import type { PrivateOperation } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { InMemoryRingsGateway } from "./in-memory-rings-gateway";

const OPERATION = {
  walletId: "hrw_1",
  opType: "shield",
  intentKey: "sha256:abc",
} as PrivateOperation;

const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/**
 * Only the properties the service, route and poll tests actually lean on. The
 * double's plain return values are covered by the tests that consume them.
 */
describe("InMemoryRingsGateway", () => {
  it("is deterministic: same inputs produce identical outputs", async () => {
    const options = { now: () => "2026-08-17T00:00:00.000Z" };
    const [a, b] = await Promise.all([
      new InMemoryRingsGateway(options).buildOperation({ operation: OPERATION, owner: OWNER }),
      new InMemoryRingsGateway(options).buildOperation({ operation: OPERATION, owner: OWNER }),
    ]);

    expect(a.outerUnsignedTxBase64).toBe(b.outerUnsignedTxBase64);
    expect(a.proof.ref.reveal("adapter")).toBe(b.proof.ref.reveal("adapter"));
  });

  it("counts syncs per wallet, so one wallet cannot advance another", async () => {
    const gateway = new InMemoryRingsGateway();

    expect((await gateway.syncPhoton({ walletId: "hrw_1", owner: OWNER })).report.storedNotes).toBe(
      1
    );
    expect((await gateway.syncPhoton({ walletId: "hrw_1", owner: OWNER })).report.storedNotes).toBe(
      2
    );
    expect((await gateway.syncPhoton({ walletId: "hrw_2", owner: OWNER })).report.storedNotes).toBe(
      1
    );
  });

  it("reports indexed only after the delay elapses on the injected clock", async () => {
    let now = "2026-08-17T00:00:00.000Z";
    const gateway = new InMemoryRingsGateway({ now: () => now, indexingDelayMs: 1000 });

    // Unknown signatures stay null, so a test never sees an operation it did
    // not submit reported as indexed.
    expect(await gateway.verifyIndexed("sig")).toBeNull();

    gateway.recordSubmission("sig");
    expect(await gateway.verifyIndexed("sig")).toBeNull();

    now = "2026-08-17T00:00:01.000Z";
    expect(await gateway.verifyIndexed("sig")).toMatchObject({ indexedAt: now });
  });

  it("pins input notes on a spend, so a rebuild spends what the first build chose", async () => {
    const gateway = new InMemoryRingsGateway();
    const spend = { ...OPERATION, opType: "withdraw" } as PrivateOperation;

    expect(
      (await gateway.buildOperation({ operation: spend, owner: OWNER, pinnedInputs: ["note:a"] }))
        .inputNotes
    ).toEqual(["note:a"]);
    // A shield consumes nothing, so it never reports notes.
    expect(
      (await gateway.buildOperation({ operation: OPERATION, owner: OWNER })).inputNotes
    ).toEqual([]);
  });
});

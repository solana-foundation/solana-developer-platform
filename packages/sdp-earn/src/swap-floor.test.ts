import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSwapLegWithFloor, EarnSwapFloorError } from "./swap-floor";

describe("buildSwapLegWithFloor", () => {
  it("rounds tolerance down and returns the admitted leg unchanged", async () => {
    const leg = { instructions: ["admitted"] };
    const tolerances: number[] = [];
    let assertions = 0;
    const result = await buildSwapLegWithFloor({
      quote: { text: "87.5", atoms: 87_500_000n },
      minimumOutput: 87_000_000n,
      assertActive: () => assertions++,
      build: async (slippageBps) => {
        tolerances.push(slippageBps);
        return { value: leg, minimumOutput: { text: "87.1", atoms: 87_100_000n } };
      },
    });
    assert.equal(result, leg);
    assert.deepEqual(tolerances, [57]);
    assert.equal(assertions, 1);
  });

  it("retries a moving route once at zero tolerance", async () => {
    const tolerances: number[] = [];
    const result = await buildSwapLegWithFloor({
      quote: { text: "100", atoms: 100n },
      minimumOutput: 99n,
      assertActive: () => undefined,
      build: async (slippageBps) => {
        tolerances.push(slippageBps);
        const atoms = tolerances.length === 1 ? 98n : 99n;
        return { value: "leg", minimumOutput: { text: atoms.toString(), atoms } };
      },
    });
    assert.equal(result, "leg");
    assert.deepEqual(tolerances, [100, 0]);
  });

  it("refuses an insufficient quote before building", async () => {
    let builds = 0;
    await assert.rejects(
      buildSwapLegWithFloor({
        quote: { text: "98", atoms: 98n },
        minimumOutput: 99n,
        assertActive: () => undefined,
        build: async () => {
          builds++;
          throw new Error("must not build");
        },
      }),
      (cause) =>
        cause instanceof EarnSwapFloorError &&
        cause.stage === "quote" &&
        cause.availableAmount === "98"
    );
    assert.equal(builds, 0);
  });

  it("refuses a second shortfall without another build", async () => {
    const tolerances: number[] = [];
    await assert.rejects(
      buildSwapLegWithFloor({
        quote: { text: "100", atoms: 100n },
        minimumOutput: 99n,
        assertActive: () => undefined,
        build: async (slippageBps) => {
          tolerances.push(slippageBps);
          return { value: "leg", minimumOutput: { text: "98", atoms: 98n } };
        },
      }),
      (cause) =>
        cause instanceof EarnSwapFloorError &&
        cause.stage === "build" &&
        cause.availableAmount === "98"
    );
    assert.deepEqual(tolerances, [100, 0]);
  });

  it("does not rebuild a failed route already requested at zero tolerance", async () => {
    let builds = 0;
    await assert.rejects(
      buildSwapLegWithFloor({
        quote: { text: "99", atoms: 99n },
        minimumOutput: 99n,
        assertActive: () => undefined,
        build: async (slippageBps) => {
          builds++;
          assert.equal(slippageBps, 0);
          return { value: "leg", minimumOutput: { text: "98", atoms: 98n } };
        },
      }),
      EarnSwapFloorError
    );
    assert.equal(builds, 1);
  });

  it("bounds tolerance below 100% without converting token atoms to numbers", async () => {
    const atoms = (1n << 64n) - 1n;
    await buildSwapLegWithFloor({
      quote: { text: atoms.toString(), atoms },
      minimumOutput: 1n,
      assertActive: () => undefined,
      build: async (slippageBps) => {
        assert.equal(slippageBps, 9_999);
        return { value: "leg", minimumOutput: { text: "1", atoms: 1n } };
      },
    });
  });

  it("rejects a nonpositive floor before attempting a build", async () => {
    for (const minimumOutput of [0n, -1n]) {
      await assert.rejects(
        buildSwapLegWithFloor({
          quote: { text: "0", atoms: 0n },
          minimumOutput,
          assertActive: () => undefined,
          build: async () => {
            throw new Error("must not build");
          },
        }),
        RangeError
      );
    }
  });

  it("preserves provider validation failures without retrying", async () => {
    const malformed = new Error("invalid guaranteed output");
    let builds = 0;
    await assert.rejects(
      buildSwapLegWithFloor({
        quote: { text: "100", atoms: 100n },
        minimumOutput: 99n,
        assertActive: () => undefined,
        build: async () => {
          builds++;
          throw malformed;
        },
      }),
      (cause) => cause === malformed
    );
    assert.equal(builds, 1);
  });

  it("checks the operation deadline before each build", async () => {
    const expired = new Error("deadline expired");
    let assertions = 0;
    let builds = 0;
    await assert.rejects(
      buildSwapLegWithFloor({
        quote: { text: "100", atoms: 100n },
        minimumOutput: 99n,
        assertActive: () => {
          if (++assertions === 2) throw expired;
        },
        build: async () => {
          builds++;
          return { value: "leg", minimumOutput: { text: "98", atoms: 98n } };
        },
      }),
      (cause) => cause === expired
    );
    assert.equal(builds, 1);
    assert.equal(assertions, 2);
  });
});

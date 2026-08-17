import {
  KAMINO_DEVNET_KVAULT_PROGRAM_ID,
  KAMINO_KVAULT_PROGRAM_IDS,
  KAMINO_SLOT_DURATION_MS,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import { foreignKvaultProgramId, kaminoClusterConfig, kaminoProgramAllowlist } from "./programs";

describe("kaminoClusterConfig", () => {
  it("binds each cluster to its OWN kvault program", () => {
    expect(String(kaminoClusterConfig("devnet").kvaultProgramId)).toBe(
      KAMINO_KVAULT_PROGRAM_IDS.devnet
    );
    expect(String(kaminoClusterConfig("mainnet-beta").kvaultProgramId)).toBe(
      KAMINO_KVAULT_PROGRAM_IDS["mainnet-beta"]
    );
  });

  it("keeps the two kvault programs distinct — the whole premise of the table", () => {
    expect(String(kaminoClusterConfig("devnet").kvaultProgramId)).not.toBe(
      String(kaminoClusterConfig("mainnet-beta").kvaultProgramId)
    );
  });

  it("shares one klend program across clusters (verified deployed on both)", () => {
    expect(String(kaminoClusterConfig("devnet").klendProgramId)).toBe(
      String(kaminoClusterConfig("mainnet-beta").klendProgramId)
    );
  });

  it("shares one farms program across clusters, so farms is not a second trap", () => {
    expect(String(kaminoClusterConfig("devnet").farmsProgramId)).toBe(
      String(kaminoClusterConfig("mainnet-beta").farmsProgramId)
    );
  });

  /**
   * Slot duration scales every accrual figure the SDK computes and fails
   * SILENTLY when wrong. These are measurements (2026-08-15, `getBlockTime` over
   * a 4,000-slot span), not protocol constants — this test pins that they were
   * measured per cluster rather than defaulted to one value.
   */
  it("carries a MEASURED, per-cluster slot duration that is not the SDK default", () => {
    const devnet = kaminoClusterConfig("devnet").slotDurationMs;
    const mainnet = kaminoClusterConfig("mainnet-beta").slotDurationMs;
    expect(devnet).toBe(KAMINO_SLOT_DURATION_MS.devnet);
    expect(mainnet).toBe(KAMINO_SLOT_DURATION_MS["mainnet-beta"]);
    expect(devnet).not.toBe(mainnet);
    // 400 is klend-sdk's DEFAULT_RECENT_SLOT_DURATION_MS; neither cluster is it.
    expect(devnet).not.toBe(400);
    expect(mainnet).not.toBe(400);
  });
});

describe("kaminoProgramAllowlist", () => {
  it("never contains the other cluster's kvault program", () => {
    for (const cluster of ["devnet", "mainnet-beta"] as const) {
      const allowed = kaminoProgramAllowlist(cluster);
      expect(allowed.has(foreignKvaultProgramId(cluster))).toBe(false);
      expect(allowed.has(kaminoClusterConfig(cluster).kvaultProgramId)).toBe(true);
    }
  });
});

describe("@sdp/types re-export", () => {
  it("keeps the named devnet constant identical to the table entry", () => {
    // @sdp/earn imports the named constant; @sdp/kamino reads the table. They
    // must never drift, which is why one is derived from the other.
    expect(KAMINO_DEVNET_KVAULT_PROGRAM_ID).toBe(KAMINO_KVAULT_PROGRAM_IDS.devnet);
  });
});

import { custodyWalletMetadataSchema, custodyWalletSummarySchema } from "@sdp/types/custody";
import { describe, expect, it } from "vitest";

const WALLET_FIELDS = {
  id: "cwlt_test_1",
  provider: "privy",
  isRuntimeExecutionAllowed: true,
  walletId: "wal_test_1",
  publicKey: "11111111111111111111111111111111",
  label: null,
  purpose: null,
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("custody wallet schemas", () => {
  it.each([
    ["a config", { custodyConfigId: "cfg_test_1" }, true],
    ["a connection", { custodyConnectionId: "conn_test_1" }, true],
    [
      "both a config and a connection",
      { custodyConfigId: "cfg_test_1", custodyConnectionId: "conn_test_1" },
      false,
    ],
    ["no owner", {}, false],
  ])("reads a wallet owned by %s as valid: %s", (_owner, owner, valid) => {
    const wallet = { ...WALLET_FIELDS, ...owner };
    expect([
      custodyWalletSummarySchema.safeParse(wallet).success,
      custodyWalletMetadataSchema.safeParse(wallet).success,
    ]).toEqual([valid, valid]);
  });
});

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { describe, expect, it } from "vitest";
import {
  allWalletsHeldBack,
  HELD_BACK_WALLETS_KEY,
  heldBackWalletsHint,
  type MovementWallet,
  walletStartsMovement,
  walletsStartingMovement,
} from "./wallet-movement-support";

const fireblocksByok: PaymentsDashboardWallet = {
  id: "cwlt_fireblocks_byok",
  walletId: "vault_1",
  publicKey: "FbByok1111111111111111111111111111111111111",
  label: "Fireblocks vault",
  provider: "fireblocks",
  custodyConnectionId: "cconn_fireblocks",
  isRuntimeExecutionAllowed: true,
};
const fireblocksManaged: PaymentsDashboardWallet = {
  ...fireblocksByok,
  id: "cwlt_fireblocks_managed",
  label: "Managed vault",
  custodyConnectionId: undefined,
  custodyConfigId: "cc_fireblocks",
};
const privyByok: PaymentsDashboardWallet = {
  ...fireblocksByok,
  id: "cwlt_privy",
  label: "Privy wallet",
  provider: "privy",
  custodyConnectionId: "cconn_privy",
};
const noProvider: PaymentsDashboardWallet = {
  ...fireblocksByok,
  id: "cwlt_unknown",
  provider: undefined,
};

const t = (key: string) => key;

describe("walletStartsMovement", () => {
  it("holds a customer-connected Fireblocks wallet back from every start but a direct payment", () => {
    expect(walletStartsMovement(fireblocksByok, "payments.transfer")).toBe(true);
    for (const movement of [
      "payments.transfer_batch",
      "ramps.offramp_quote",
      "recurring.activate",
      "recurring.update",
      "earn.deposit",
      "issuance.authority",
      "dvp.create",
      "private_channels.transfer",
    ] as const) {
      expect(walletStartsMovement(fireblocksByok, movement)).toBe(false);
    }
  });

  it("never holds a wallet back from an exit", () => {
    expect(walletStartsMovement(fireblocksByok, "earn.withdraw")).toBe(true);
    expect(walletStartsMovement(fireblocksByok, "private_channels.withdraw")).toBe(true);
    expect(walletStartsMovement(fireblocksByok, "issuance.control")).toBe(true);
  });

  it("passes a managed Fireblocks wallet, a Privy connection and a wallet with no provider", () => {
    expect(walletStartsMovement(fireblocksManaged, "payments.transfer_batch")).toBe(true);
    expect(walletStartsMovement(privyByok, "payments.transfer_batch")).toBe(true);
    expect(walletStartsMovement(noProvider, "payments.transfer_batch")).toBe(true);
  });

  it("passes a provider this build does not know, and reads null ids as absent", () => {
    const row: MovementWallet = {
      provider: "some_future_custodian",
      custodyConnectionId: "cconn_future",
      custodyConfigId: null,
    };
    expect(walletStartsMovement(row, "earn.deposit")).toBe(true);
    expect(
      walletStartsMovement(
        { provider: "fireblocks", custodyConnectionId: null, custodyConfigId: "cc_1" },
        "earn.deposit"
      )
    ).toBe(true);
  });
});

describe("walletsStartingMovement", () => {
  it("keeps order and leaves only the held-back wallet out", () => {
    const offered = walletsStartingMovement(
      [fireblocksByok, fireblocksManaged, privyByok, noProvider],
      "recurring.activate"
    );
    expect(offered.map((wallet) => wallet.id)).toEqual([
      "cwlt_fireblocks_managed",
      "cwlt_privy",
      "cwlt_unknown",
    ]);
  });
});

describe("heldBackWalletsHint", () => {
  it("explains a picker only the rule emptied", () => {
    expect(allWalletsHeldBack([fireblocksByok], "earn.deposit")).toBe(true);
    expect(heldBackWalletsHint([fireblocksByok], "earn.deposit", t)).toBe(HELD_BACK_WALLETS_KEY);
  });

  it("says nothing for a project with no wallets or with one still offered", () => {
    expect(allWalletsHeldBack([], "earn.deposit")).toBe(false);
    expect(heldBackWalletsHint([], "earn.deposit", t)).toBeNull();
    expect(heldBackWalletsHint([fireblocksByok, privyByok], "earn.deposit", t)).toBeNull();
  });
});

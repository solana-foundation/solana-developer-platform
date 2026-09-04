import { describe, expect, it, vi } from "vitest";

const flagMocks = vi.hoisted(() => ({
  custody: vi.fn(),
  issuance: vi.fn(),
  policies: vi.fn(),
}));

const notFoundMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
);

vi.mock("@/flags", () => flagMocks);
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

import ApprovalsLayout from "./approvals/layout";
import CustodyWalletPoliciesLayout from "./custody/[walletId]/policy/layout";
import CustodyLayout from "./custody/layout";
import IssuanceLayout from "./issuance/layout";
import PoliciesLayout from "./policies/layout";
import TokensLayout from "./tokens/layout";
import WalletPoliciesLayout from "./wallets/[walletId]/policy/layout";
import WalletsLayout from "./wallets/layout";

describe("dashboard module feature gates", () => {
  it("404s every Custody route when Custody is disabled", async () => {
    flagMocks.custody.mockResolvedValue(false);

    await expect(CustodyLayout({ children: <div>Custody</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s every Wallets alias route when Custody is disabled", async () => {
    flagMocks.custody.mockResolvedValue(false);

    await expect(WalletsLayout({ children: <div>Wallets</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s the wallet-derived Tokens route when Custody is disabled", async () => {
    flagMocks.custody.mockResolvedValue(false);

    await expect(TokensLayout({ children: <div>Tokens</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s every Issuance route when Issuance is disabled", async () => {
    flagMocks.issuance.mockResolvedValue(false);

    await expect(IssuanceLayout({ children: <div>Issuance</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("404s every Policies route when Policies is disabled", async () => {
    flagMocks.policies.mockResolvedValue(false);

    await expect(PoliciesLayout({ children: <div>Policies</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("404s every Approvals route when Policies is disabled", async () => {
    flagMocks.policies.mockResolvedValue(false);

    await expect(ApprovalsLayout({ children: <div>Approvals</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("404s Custody wallet policy routes when Policies is disabled", async () => {
    flagMocks.policies.mockResolvedValue(false);

    await expect(
      CustodyWalletPoliciesLayout({ children: <div>Wallet policy</div> })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s Wallets alias policy routes when Policies is disabled", async () => {
    flagMocks.policies.mockResolvedValue(false);

    await expect(WalletPoliciesLayout({ children: <div>Wallet policy</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });
});

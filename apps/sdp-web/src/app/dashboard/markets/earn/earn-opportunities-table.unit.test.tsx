// @vitest-environment jsdom

import type { EarnStrategy } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EarnOpportunitiesTable } from "./earn-opportunities-table";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

const KAMINO: EarnStrategy = {
  id: "kamino-vault-one",
  provider: "kamino",
  providerReference: "vault-one",
  name: "Kamino USDC Vault",
  sourceKind: "defi",
  depositMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  apyType: "variable",
  currentApy: "0.05",
  liquidityTerm: "instant",
  status: "active",
  hostCluster: "mainnet-beta",
  fundable: true,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

afterEach(cleanup);

describe("EarnOpportunitiesTable vault capability", () => {
  it("keeps a production vault visible with a truthful disabled action", () => {
    render(<EarnOpportunitiesTable environment="production" strategies={[KAMINO]} />);

    expect(screen.getByText("Kamino USDC Vault")).not.toBeNull();
    expect(screen.getByText("DashboardEarn.opportunities.depositProductionClosed")).not.toBeNull();
    const deposit = screen.getByRole("button", {
      name: /DashboardEarn\.opportunities\.depositProductionClosedReason/,
    });
    expect(deposit.hasAttribute("disabled")).toBe(true);
    expect(deposit.getAttribute("title")).toBe(
      "DashboardEarn.opportunities.depositProductionClosedReason"
    );
  });

  it("opens a sandbox vault and marks the exact focus-return target", async () => {
    const onVaultDeposit = vi.fn();
    const user = userEvent.setup();
    render(
      <EarnOpportunitiesTable
        environment="sandbox"
        onVaultDeposit={onVaultDeposit}
        strategies={[KAMINO]}
      />
    );

    const deposit = screen.getByRole("button", { name: "DashboardEarn.opportunities.deposit" });
    expect(deposit.hasAttribute("disabled")).toBe(false);
    expect(deposit.getAttribute("data-modal-focus-fallback")).toBe(KAMINO.id);
    await user.click(deposit);
    expect(onVaultDeposit).toHaveBeenCalledWith(KAMINO);
  });
});

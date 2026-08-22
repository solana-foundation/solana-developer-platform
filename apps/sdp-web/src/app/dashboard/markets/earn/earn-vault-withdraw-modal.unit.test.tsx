// @vitest-environment jsdom

import type { EarnVaultPosition, EarnVaultWithdrawal } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "./earn-idempotency-key-store";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";

const mocks = vi.hoisted(() => ({
  createEarnVaultWithdrawal: vi.fn(),
  fetchEarnVaultWithdrawalsByRequestId: vi.fn(),
  useEarnVaultWithdrawalOutcomeToast: vi.fn(),
}));

vi.mock("./earn-program-data", () => ({
  createEarnVaultWithdrawal: mocks.createEarnVaultWithdrawal,
  fetchEarnVaultWithdrawalsByRequestId: mocks.fetchEarnVaultWithdrawalsByRequestId,
  useEarnVaultWithdrawalOutcomeToast: mocks.useEarnVaultWithdrawalOutcomeToast,
}));

const position: EarnVaultPosition = {
  id: "earn_position_1",
  provider: "kamino",
  providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  label: "Kamino USDC Vault",
  custodyWalletId: "cwlt_1",
  tokenMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  shareMint: "So11111111111111111111111111111111111111112",
  createdAt: "2026-08-21T00:00:00.000Z",
  closedAt: null,
  shares: "10",
  withdrawableShares: "6",
  tokenValue: "10.5",
};

function withdrawal(status: EarnVaultWithdrawal["status"]): EarnVaultWithdrawal {
  return {
    movementId: "earn_movement_1",
    positionId: position.id,
    provider: position.provider,
    providerReference: position.providerReference,
    status,
    signature: "sig_recorded_not_broadcast",
    shares: "6",
    shareMint: position.shareMint,
    failureReason: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    confirmedAt: null,
    settledAt: null,
  };
}

function renderModal(onWithdrawn = vi.fn()) {
  return {
    onWithdrawn,
    ...render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <EarnVaultWithdrawModal
          environment="sandbox"
          onClose={vi.fn()}
          onWithdrawn={onWithdrawn}
          position={position}
          projectId="prj_1"
        />
      </I18nProvider>
    ),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  vi.clearAllMocks();
  mocks.fetchEarnVaultWithdrawalsByRequestId.mockResolvedValue({ kind: "absent" });
});

afterEach(cleanup);

describe("EarnVaultWithdrawModal", () => {
  it("caps Max at unstaked withdrawable shares", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("button", { name: "Max" }));

    expect((screen.getByLabelText("Shares to redeem") as HTMLInputElement).value).toBe("6");
    expect(screen.getByText(/6 shares available to withdraw of 10 total/)).toBeTruthy();
  });

  it("disables Max when the withdrawable balance is unavailable", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <EarnVaultWithdrawModal
          environment="sandbox"
          onClose={vi.fn()}
          onWithdrawn={vi.fn()}
          position={{ ...position, withdrawableShares: undefined }}
          projectId="prj_1"
        />
      </I18nProvider>
    );

    expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/withdrawable balance is unavailable/)).toBeTruthy();
  });

  it("renders a recorded response as queued without a premature explorer link", async () => {
    const user = userEvent.setup();
    const recorded = withdrawal("requested");
    mocks.createEarnVaultWithdrawal.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kind: "withdrawal", withdrawal: recorded },
    });
    const { onWithdrawn } = renderModal();

    await user.type(screen.getByLabelText("Shares to redeem"), "6");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Withdrawal queued")).toBeTruthy();
    expect(
      screen.getByText(/signed and recorded, but broadcast has not been confirmed/)
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(onWithdrawn).toHaveBeenCalledWith(recorded);
  });
});

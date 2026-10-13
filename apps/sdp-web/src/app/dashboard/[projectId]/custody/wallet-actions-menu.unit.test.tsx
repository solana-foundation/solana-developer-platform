// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkWalletSignerMemoAction } from "./actions";
import { WalletActionsMenu } from "./wallet-actions-menu";

vi.mock("./actions", () => ({
  checkWalletSignerMemoAction: vi.fn(),
  requestDevnetSolanaFaucetAction: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(() => "toast"), success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canUseWalletSignerCheck: true } },
    sandboxProject: { id: "prj_sandbox" },
  }),
}));
// The menu's own items, without the popover that hosts them.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onSelect} disabled={disabled}>
      {children}
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WalletActionsMenu signer check", () => {
  // The check signs in simulation and broadcasts nothing. Under a kept key a
  // press after the user fixed the signer would replay the earlier failure.
  it("probes the signer afresh on every press, under no Idempotency-Key", async () => {
    vi.mocked(checkWalletSignerMemoAction)
      .mockResolvedValueOnce({ status: "error", message: "signer unreachable" })
      .mockResolvedValueOnce({ status: "success", walletId: "wallet_1", signature: "sig" });
    render(
      <WalletActionsMenu
        walletAddress="11111111111111111111111111111111"
        walletId="wallet_1"
        walletLabel="Ops"
      />
    );
    const user = userEvent.setup();
    const prove = () => screen.getByRole("button", { name: "DashboardCustody.proveOwnership" });

    await user.click(prove());
    await waitFor(() => expect(prove().hasAttribute("disabled")).toBe(false));
    await user.click(prove());
    await waitFor(() => expect(checkWalletSignerMemoAction).toHaveBeenCalledTimes(2));

    expect(vi.mocked(checkWalletSignerMemoAction).mock.calls).toEqual([["wallet_1"], ["wallet_1"]]);
  });
});

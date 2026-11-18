// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ClassifyStep, PermissionsStep } from "./draft-flow-steps";
import type { DraftState } from "./draft-model";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
// A native select, so the options a key may be held by can be read without opening a menu.
vi.mock("@sdp/ui/select", () => ({
  Select: ({
    ariaLabel,
    children,
    onValueChange,
    value,
  }: {
    ariaLabel?: string;
    children: ReactNode;
    onValueChange?: (value: string | null) => void;
    value?: string | null;
    placeholder?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      onChange={(event) => onValueChange?.(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Select</option>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: ComponentProps<"option">) => (
    <option value={value}>{children}</option>
  ),
}));

afterEach(() => cleanup());

const messages = getMessages("en");

const stablecoinDraft: DraftState = {
  assetClass: "stablecoin",
  name: "Treasury Fund",
  symbol: "",
  description: "",
  website: "",
  maxSupply: "",
  decimals: "6",
  allowlist: false,
  pauseTransfers: true,
  interestBearing: false,
  interestRate: "500",
  transferFee: false,
  transferFeeBasisPoints: "50",
  transferFeeMax: "100",
  issuerName: "",
  freezeAccounts: true,
  permanentDelegate: false,
  authorities: {
    "mint-authority": "wallet-a",
    "metadata-authority": "wallet-a",
    "freeze-authority": "wallet-a",
    "permanent-delegate": "wallet-a",
  },
};

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

function renderPermissions(wallets: PaymentsDashboardWallet[]) {
  return render(
    <I18nProvider locale="en" messages={messages}>
      <PermissionsStep
        draft={stablecoinDraft}
        wallets={wallets}
        walletsError={null}
        update={vi.fn()}
      />
    </I18nProvider>
  );
}

describe("PermissionsStep", () => {
  it("offers each key a managed Fireblocks wallet and a Privy connection, not a Fireblocks connection", () => {
    renderPermissions([fireblocksByok, fireblocksManaged, privyByok]);
    const mintAuthority = screen.getByRole("combobox", { name: "Mint authority" });
    const names = Array.from(mintAuthority.querySelectorAll("option")).map(
      (option) => option.textContent
    );
    expect(names).toEqual(["Select", "Managed vault", "Privy wallet"]);
    expect(screen.queryByText(/send direct payments only/)).toBeNull();
  });

  it("explains why no wallet is offered when only Fireblocks connections exist", () => {
    renderPermissions([fireblocksByok]);
    expect(screen.getByText(/send direct payments only/)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("link", { name: /wallet/i }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/wallets/setup"
    );
  });

  it("keeps a project with no wallets on its own words", () => {
    renderPermissions([]);
    expect(screen.getByText(/this project has none yet/)).toBeTruthy();
    expect(screen.queryByText(/send direct payments only/)).toBeNull();
  });
});

describe("ClassifyStep", () => {
  it("drops a stablecoin's controls when the draft becomes another kind of token", () => {
    const update = vi.fn();
    render(
      <I18nProvider locale="en" messages={messages}>
        <ClassifyStep draft={stablecoinDraft} update={update} />
      </I18nProvider>
    );
    const [, digital] = screen.getAllByRole("radio");
    fireEvent.click(digital as HTMLElement);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        assetClass: "digital-asset",
        decimals: "9",
        pauseTransfers: false,
        freezeAccounts: false,
        permanentDelegate: false,
      })
    );
  });
});

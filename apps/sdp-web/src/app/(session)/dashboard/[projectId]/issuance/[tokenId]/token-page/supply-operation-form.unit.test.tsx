// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import type { Token } from "@sdp/types/tokens";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as operationData from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/use-token-operation-data";
import { useTokenOperations } from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/use-token-operations";
import * as actionRunner from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/use-token-action-runner";
import * as workspace from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { EnglishI18n } from "@/test/i18n";
import { LockSupplyForm, SupplyOperationForm } from "./supply-operation-form";

const signerCopy = getMessages("en").DashboardIssuance.signer;
const AUTHORITY = "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe";
const OTHER_WALLET = "5wLf85zhVpJ7xBjDCE1KK8yTXyCrbbzoCUuv3Dwsd5PQ";

/** A deployed token whose mint authority is `AUTHORITY`. */
const TOKEN: Token = {
  id: "tok_test",
  projectId: "prj_test",
  organizationId: "org_test",
  signingCustodyWalletId: "cw_ops",
  signingWalletId: "wal_ops",
  mintAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  mintAuthority: AUTHORITY,
  metadataAuthority: AUTHORITY,
  freezeAuthority: AUTHORITY,
  ablListAddress: null,
  name: "Acme Dollar",
  symbol: "ACME",
  decimals: 6,
  description: null,
  uri: null,
  imageUrl: null,
  template: "stablecoin",
  extensions: {},
  totalSupply: "1000000",
  maxSupply: null,
  isMintable: true,
  isFreezable: true,
  requiresAllowlist: false,
  status: "active",
  deployedAt: "2026-11-05T00:00:00.000Z",
  createdBy: "user_test",
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
};

/** A custody wallet the project controls, able to sign. */
function wallet(id: string, label: string, publicKey: string): PaymentsDashboardWallet {
  return { id, walletId: `wal_${id}`, label, publicKey, isRuntimeExecutionAllowed: true };
}

/** Two wallets that could sign a burn: any of the project's wallets may burn what it holds. */
const BURN_SIGNERS = [
  wallet("cw_ops", "Operations", AUTHORITY),
  wallet("cw_treasury", "Treasury", OTHER_WALLET),
];

/** Two custody wallets holding the mint authority, either of which could sign the lock. */
const MINT_AUTHORITY_SIGNERS = [
  wallet("cw_ops", "Operations", AUTHORITY),
  wallet("cw_reserve", "Reserve", AUTHORITY),
];

/**
 * The token's operations over the project's custody wallets, with nothing fetched and an action
 * running when `pending`: the returned spy receives each action instead of the API.
 */
function stubOperations({
  authorityWallets,
  pending,
}: {
  authorityWallets: PaymentsDashboardWallet[];
  pending: boolean;
}) {
  const runAction = vi.fn();
  vi.mocked(vi.spyOn(workspace, "useDashboardWorkspace"), { partial: true }).mockReturnValue({
    sdpEnvironment: "sandbox",
  });
  vi.mocked(vi.spyOn(actionRunner, "useTokenActionRunner"), { partial: true }).mockReturnValue({
    isPending: pending,
    runAction,
  });
  vi.mocked(vi.spyOn(operationData, "useTokenOperationData"), { partial: true }).mockReturnValue({
    authorityWallets,
    authorityWalletsError: null,
    authorityWalletsLoading: false,
    allowlistEntries: [],
    frozenAccountsError: null,
    frozenAccountsLoading: false,
    frozenAccountsTotal: 0,
  });
  return runAction;
}

function useOperations() {
  return useTokenOperations({
    token: TOKEN,
    shouldLoadAuthorityWallets: true,
    canManageTokenAdmin: true,
  });
}

function BurnForm() {
  return <SupplyOperationForm token={TOKEN} ops={useOperations()} action="burn" />;
}

function LockForm() {
  return <LockSupplyForm ops={useOperations()} />;
}

/**
 * The picker under the "Signing wallet" label; the address field, with its wallet suggestions,
 * is a combobox too.
 */
function signerPicker(): HTMLElement {
  const block = screen.getByText(signerCopy.label).closest("div");
  if (!block) throw new Error("The signing wallet label sits outside its block");
  return within(block).getByRole("combobox");
}

/** Opens the signing wallet picker and chooses the option whose label matches. */
async function chooseSigner(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(signerPicker());
  await user.click(await screen.findByRole("option", { name }));
}

describe("SupplyOperationForm", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the burn's signing wallet on screen once chosen, so a wrong choice can be changed", async () => {
    // Any of the project's wallets may burn what it holds, so with two the form asks.
    const runAction = stubOperations({ authorityWallets: BURN_SIGNERS, pending: false });
    const user = userEvent.setup();
    render(
      <EnglishI18n>
        <BurnForm />
      </EnglishI18n>
    );
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: AUTHORITY } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "250000" } });
    const submit = screen.getByRole("button", { name: /^Burn 250,000\.00/ });
    expect(submit).toHaveProperty("disabled", true);

    // Treasury does not hold the source, so it cannot sign this burn.
    await chooseSigner(user, /Treasury/);
    expect(signerPicker().textContent).toContain("Treasury");
    expect(submit).toHaveProperty("disabled", true);

    await chooseSigner(user, /Operations/);
    expect(signerPicker().textContent).toContain("Operations");
    expect(submit).toHaveProperty("disabled", false);

    await user.click(submit);
    expect(runAction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        body: expect.objectContaining({ signingCustodyWalletId: "cw_ops" }),
      }),
      expect.objectContaining({ confirmationTitle: "Burn tokens?" })
    );
  });

  it("locks the burn's signing wallet while an action runs", () => {
    stubOperations({ authorityWallets: BURN_SIGNERS, pending: true });
    render(
      <EnglishI18n>
        <BurnForm />
      </EnglishI18n>
    );
    expect(signerPicker().hasAttribute("data-disabled")).toBe(true);
  });
});

describe("LockSupplyForm", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the lock's signing wallet on screen once chosen", async () => {
    // Two custody wallets hold the mint authority, so the lock asks which signs.
    stubOperations({ authorityWallets: MINT_AUTHORITY_SIGNERS, pending: false });
    const user = userEvent.setup();
    render(
      <EnglishI18n>
        <LockForm />
      </EnglishI18n>
    );

    await chooseSigner(user, /Reserve/);
    expect(signerPicker().textContent).toContain("Reserve");
  });

  it("locks the lock's signing wallet while an action runs", () => {
    stubOperations({ authorityWallets: MINT_AUTHORITY_SIGNERS, pending: true });
    render(
      <EnglishI18n>
        <LockForm />
      </EnglishI18n>
    );
    expect(signerPicker().hasAttribute("data-disabled")).toBe(true);
  });
});

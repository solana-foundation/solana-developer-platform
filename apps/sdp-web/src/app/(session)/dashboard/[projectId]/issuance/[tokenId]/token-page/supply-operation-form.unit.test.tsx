// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import type { Token } from "@sdp/types/tokens";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenOperations } from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/use-token-operations";
import { getMessages } from "@/i18n/messages";
import { EnglishI18n } from "@/test/i18n";
import { LockSupplyForm, SupplyOperationForm } from "./supply-operation-form";

const signerCopy = getMessages("en").DashboardIssuance.signer;
const HOLDER = "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe";
const TOKEN = { id: "tok_test", symbol: "ACME", mintAddress: HOLDER } as Token;

/** A custody wallet the project controls, able to sign. */
function wallet(id: string, label: string, publicKey: string): PaymentsDashboardWallet {
  return { id, walletId: `wal_${id}`, label, publicKey, isRuntimeExecutionAllowed: true };
}

/** Two wallets that could sign: any of the project's wallets can burn what it holds. */
const BURN_SIGNERS = [
  wallet("cw_ops", "Operations", HOLDER),
  wallet("cw_treasury", "Treasury", "5wLf85zhVpJ7xBjDCE1KK8yTXyCrbbzoCUuv3Dwsd5PQ"),
];

/**
 * The burn form over live form state, as the operations hook keeps it: choosing a signer writes
 * it into the burn form, and submitting sends what that form holds.
 */
function BurnWithSigners({
  onSubmit,
}: {
  onSubmit: (action: string, signingWalletId: string) => void;
}) {
  const [burnForm, setBurnForm] = useState({
    source: "",
    amount: "",
    memo: "",
    signingWalletId: "",
  });
  const ops = {
    isPending: false,
    mintForm: { destination: "", amount: "", memo: "", signingWalletId: "" },
    burnForm,
    setBurnForm,
    mintValidationErrors: { destination: null, amount: null },
    burnValidationErrors: { source: null, amount: null },
    fundManagementDisabledReasons: {},
    authorityWallets: BURN_SIGNERS,
    getActionSignerProps: () => ({
      signerWallets: BURN_SIGNERS,
      signerUnavailableReason: null,
      onSignerWalletIdChange: (signingWalletId: string) =>
        setBurnForm((previous) => ({ ...previous, signingWalletId })),
    }),
    submitFundManagementAction: (action: string) => onSubmit(action, burnForm.signingWalletId),
    closeFundManagementModal: vi.fn(),
  } as unknown as TokenOperations;
  return <SupplyOperationForm token={TOKEN} ops={ops} action="burn" />;
}

/** The lock form when two custody wallets hold the mint authority, over live form state. */
function LockWithSigners() {
  const [lockSupplyForm, setLockSupplyForm] = useState({ destination: "", signingWalletId: "" });
  const signers = [wallet("cw_ops", "Operations", HOLDER), wallet("cw_reserve", "Reserve", HOLDER)];
  const ops = {
    isPending: false,
    lockSupplyRemaining: "0",
    lockSupplyMinted: false,
    lockSupplyRevokeFailed: false,
    lockSupplyForm,
    setLockSupplyForm,
    lockSupplySignerSelection: { wallets: signers, defaultWalletId: "", unavailableReason: null },
    authorityWallets: signers,
    handleLockSupply: vi.fn(),
    closeLockSupplyModal: vi.fn(),
  } as unknown as TokenOperations;
  return <LockSupplyForm ops={ops} />;
}

function renderWith(node: ReactNode) {
  render(<EnglishI18n>{node}</EnglishI18n>);
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
  afterEach(cleanup);

  it("keeps the burn's signing wallet on screen once chosen, so it can be read and changed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWith(<BurnWithSigners onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: HOLDER } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "250000" } });
    const submit = screen.getByRole("button", { name: /^Burn 250,000\.00/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await chooseSigner(user, /Treasury/);
    expect(signerPicker().textContent).toContain("Treasury");
    expect(submit.disabled).toBe(false);

    await chooseSigner(user, /Operations/);
    expect(signerPicker().textContent).toContain("Operations");

    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("burn", "cw_ops");
  });
});

describe("LockSupplyForm", () => {
  afterEach(cleanup);

  it("keeps the lock's signing wallet on screen once chosen", async () => {
    const user = userEvent.setup();
    renderWith(<LockWithSigners />);

    await chooseSigner(user, /Reserve/);
    expect(signerPicker().textContent).toContain("Reserve");
  });
});

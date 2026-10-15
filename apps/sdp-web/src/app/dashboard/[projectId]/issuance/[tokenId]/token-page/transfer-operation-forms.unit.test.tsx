// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { TokenOperations } from "../asset-profile/use-token-operations";
import { FreezeAccountForm, PauseTransfersForm } from "./transfer-operation-forms";

const messages = getMessages("en");
const copy = messages.DashboardIssuance.newDesign.operations;
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const FREEZE_AUTHORITY = "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe";

/** A custody wallet holding the token's freeze authority. */
function freezeSigner(id: string, label: string): PaymentsDashboardWallet {
  return {
    id,
    walletId: `wal_${id}`,
    label,
    publicKey: FREEZE_AUTHORITY,
    isRuntimeExecutionAllowed: true,
  };
}

/** The freeze signer props the operations hook hands out, for the given authority wallets. */
function freezeSignerProps(
  signerWallets: PaymentsDashboardWallet[],
  onSignerWalletIdChange: (value: string) => void = vi.fn()
) {
  return {
    signerWallets,
    defaultSignerWalletId: signerWallets.length === 1 ? signerWallets[0].id : "",
    signerUnavailableReason: null,
    onSignerWalletIdChange,
  };
}

function makeOps(accountAddress = "") {
  return {
    isPending: false,
    handlePause: vi.fn(),
    handleFreeze: vi.fn(),
    freezeForm: { accountAddress, reason: "", signingWalletId: "" },
    setFreezeForm: vi.fn(),
    getActionSignerProps: () => freezeSignerProps([freezeSigner("cw_only", "Treasury")]),
  } as unknown as TokenOperations;
}

/**
 * The freeze form over live form state, as the operations hook keeps it: choosing a signer
 * writes it into the freeze form, and the freeze sends what that form holds.
 */
function FreezeWithSigners({
  signerWallets,
  onFreeze,
}: {
  signerWallets: PaymentsDashboardWallet[];
  onFreeze: (unfreeze: boolean, signingWalletId: string) => void;
}) {
  const [freezeForm, setFreezeForm] = useState({
    accountAddress: ADDRESS,
    reason: "",
    signingWalletId: "",
  });
  const ops = {
    isPending: false,
    freezeForm,
    setFreezeForm,
    getActionSignerProps: () =>
      freezeSignerProps(signerWallets, (signingWalletId) =>
        setFreezeForm((previous) => ({ ...previous, signingWalletId }))
      ),
    handleFreeze: (unfreeze: boolean) => onFreeze(unfreeze, freezeForm.signingWalletId),
  } as unknown as TokenOperations;
  return <FreezeAccountForm ops={ops} onClose={vi.fn()} />;
}

function renderWith(node: React.ReactNode) {
  render(
    <I18nProvider locale="en" messages={messages}>
      {node}
    </I18nProvider>
  );
}

describe("PauseTransfersForm", () => {
  afterEach(cleanup);

  it("pauses in place, with no second confirmation", () => {
    const ops = makeOps();
    const onClose = vi.fn();
    renderWith(<PauseTransfersForm ops={ops} paused={false} onClose={onClose} />);
    expect(screen.getByText(copy.pauseWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: copy.pauseTitle }));
    expect(ops.handlePause).toHaveBeenCalledWith(true, { confirmed: true });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("resumes a paused token", () => {
    const ops = makeOps();
    renderWith(<PauseTransfersForm ops={ops} paused onClose={vi.fn()} />);
    expect(screen.getByText(copy.resumeWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: copy.resumeTitle }));
    expect(ops.handlePause).toHaveBeenCalledWith(false, { confirmed: true });
  });
});

describe("FreezeAccountForm", () => {
  afterEach(cleanup);

  it("waits for an address", () => {
    renderWith(<FreezeAccountForm ops={makeOps()} onClose={vi.fn()} />);
    for (const name of [copy.freezeSubmit, copy.unfreezeSubmit]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("hands a valid address to the freeze, which confirms in its dialog", () => {
    const ops = makeOps(ADDRESS);
    const onClose = vi.fn();
    renderWith(<FreezeAccountForm ops={ops} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: copy.freezeSubmit }));
    expect(ops.handleFreeze).toHaveBeenCalledWith(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("thaws a frozen address through the same handler, which confirms in its dialog", () => {
    const ops = makeOps(ADDRESS);
    const onClose = vi.fn();
    renderWith(<FreezeAccountForm ops={ops} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: copy.unfreezeSubmit }));
    expect(ops.handleFreeze).toHaveBeenCalledExactlyOnceWith(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("signs with the only freeze authority wallet without asking", () => {
    renderWith(<FreezeAccountForm ops={makeOps(ADDRESS)} onClose={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it.each([
    { action: "freeze", label: copy.freezeSubmit, unfreeze: false },
    { action: "unfreeze", label: copy.unfreezeSubmit, unfreeze: true },
  ])(
    "asks which wallet signs when several hold the authority, and sends that one: $action",
    async ({ label, unfreeze }) => {
      const user = userEvent.setup();
      const onFreeze = vi.fn();
      renderWith(
        <FreezeWithSigners
          signerWallets={[
            freezeSigner("cw_ops", "Operations"),
            freezeSigner("cw_treasury", "Treasury"),
          ]}
          onFreeze={onFreeze}
        />
      );
      const submit = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);

      await user.click(screen.getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: /Treasury/ }));
      expect(submit.disabled).toBe(false);

      await user.click(submit);
      expect(onFreeze).toHaveBeenCalledExactlyOnceWith(unfreeze, "cw_treasury");
    }
  );
});

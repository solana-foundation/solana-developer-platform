// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { TokenOperations } from "../asset-profile/use-token-operations";
import { AuthorityForm } from "./authority-form";

const messages = getMessages("en");
const wallets = [
  {
    id: "w1",
    walletId: "p1",
    isRuntimeExecutionAllowed: true,
    publicKey: "Addr1",
    label: "Treasury",
  },
  { id: "w2", walletId: "p2", isRuntimeExecutionAllowed: true, publicKey: "Addr2", label: "Ops" },
] as PaymentsDashboardWallet[];

function buildOps(newAuthority: string) {
  return {
    authorityModalRow: {
      id: "freeze-authority",
      title: "Freeze authority",
      helper: "",
      value: "Addr1",
      authorityRole: "freeze",
    },
    authorityModalCurrentAuthority: "Addr1",
    authorityModalNewAuthority: newAuthority,
    authorityModalSignerWalletId: "w1",
    authorityModalSignerSelection: {
      wallets: [wallets[0]],
      defaultWalletId: "w1",
      unavailableReason: null,
    },
    authorityWallets: wallets,
    authorityWalletsError: null,
    isPending: false,
    setAuthorityModalNewAuthority: vi.fn(),
    setAuthorityModalSignerWalletId: vi.fn(),
    handleAuthorityModalConfirm: vi.fn(),
    handleAuthorityModalClose: vi.fn(),
  } as unknown as TokenOperations;
}

function renderForm(newAuthority: string) {
  const ops = buildOps(newAuthority);
  render(
    <I18nProvider locale="en" messages={messages}>
      <AuthorityForm ops={ops} />
    </I18nProvider>
  );
  return ops;
}

/** The form over operations that keep the new holder, as the token's operations hook does. */
function renderStatefulForm(initial: string) {
  const base = buildOps(initial);
  const submitted: string[] = [];
  function Harness() {
    const [newAuthority, setNewAuthority] = useState(initial);
    const ops = {
      ...base,
      authorityModalNewAuthority: newAuthority,
      setAuthorityModalNewAuthority: (value: string) => {
        base.setAuthorityModalNewAuthority(value);
        setNewAuthority(value);
      },
      handleAuthorityModalConfirm: async () => {
        submitted.push(newAuthority);
      },
    } as TokenOperations;
    return <AuthorityForm ops={ops} />;
  }
  render(
    <I18nProvider locale="en" messages={messages}>
      <Harness />
    </I18nProvider>
  );
  return { ops: base, submitted };
}

const save = () => screen.getByRole("button", { name: messages.DashboardIssuance.authority.save });

describe("AuthorityForm", () => {
  afterEach(cleanup);

  it("shows the holder and saves only a change", () => {
    renderForm("Addr1");
    expect(screen.getByText(messages.DashboardIssuance.newDesign.permissions.holder)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves a new holder in place and cancels back to the row", () => {
    const ops = renderForm("Addr2");
    fireEvent.click(save());
    expect(ops.handleAuthorityModalConfirm).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: messages.DashboardIssuance.newDesign.permissions.cancel })
    );
    expect(ops.handleAuthorityModalClose).toHaveBeenCalledOnce();
  });

  it("says what giving the authority up ends, and asks once more before sending it", () => {
    const ops = renderForm("");
    const authority = messages.DashboardIssuance.authority;
    expect(screen.getByText(authority.freezeNoneImpact)).toBeTruthy();
    fireEvent.click(save());
    expect(ops.handleAuthorityModalConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(authority.freezeNoneTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: authority.confirmNone }));
    expect(ops.handleAuthorityModalConfirm).toHaveBeenCalledOnce();
  });

  it("transfers the authority to a custom Solana address outside the project's wallets", () => {
    const authority = messages.DashboardIssuance.authority;
    const { ops, submitted } = renderStatefulForm("Addr1");
    // The project's wallets stay the default; a custom address is one step away.
    expect(screen.queryByRole("textbox", { name: "Freeze authority" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: authority.useCustom }));

    const input = screen.getByRole("textbox", { name: "Freeze authority" }) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(screen.getByText(authority.customWalletWarning)).toBeTruthy();
    // Empty is unfinished here, not None: no None warning, nothing to save.
    expect(screen.queryByText(authority.freezeNoneImpact)).toBeNull();
    expect((save() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "not-an-address" } });
    expect(screen.getByText(messages.DashboardIssuance.forms.enterSolanaAddress)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);

    const external = "So11111111111111111111111111111111111111112";
    fireEvent.change(input, { target: { value: external } });
    expect(screen.queryByText(messages.DashboardIssuance.forms.enterSolanaAddress)).toBeNull();
    fireEvent.click(save());
    expect(submitted).toEqual([external]);

    // Going back to the list restores the holder chosen there.
    fireEvent.click(screen.getByRole("button", { name: authority.chooseWallet }));
    expect(ops.setAuthorityModalNewAuthority).toHaveBeenLastCalledWith("Addr1");
    expect(screen.queryByRole("textbox", { name: "Freeze authority" })).toBeNull();
  });
});

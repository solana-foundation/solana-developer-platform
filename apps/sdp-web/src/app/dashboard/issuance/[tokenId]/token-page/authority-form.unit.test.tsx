// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function renderForm(newAuthority: string) {
  const ops = {
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
  render(
    <I18nProvider locale="en" messages={messages}>
      <AuthorityForm ops={ops} />
    </I18nProvider>
  );
  return ops;
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

  it("says what giving the authority up ends", () => {
    renderForm("");
    expect(screen.getByText(messages.DashboardIssuance.authority.freezeNoneImpact)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });
});

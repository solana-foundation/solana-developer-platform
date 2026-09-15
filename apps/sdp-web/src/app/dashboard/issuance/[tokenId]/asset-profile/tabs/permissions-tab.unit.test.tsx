// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { AssetProfileForm } from "../use-asset-profile-form";
import type { TokenOperations } from "../use-token-operations";
import { PermissionsTab } from "./permissions-tab";

afterEach(cleanup);

it.each(["cwlt_a", "provider_unresolved"])(
  "displays and edits a draft permission with initial assignment %s",
  async (assignedId) => {
    const user = userEvent.setup();
    const updateDraft = vi.fn();
    // SAFETY: only these fields are consumed by the loaded, undeployed branch.
    const ops = {
      authoritySummary: { hasExternal: false },
      authorityWalletsLoading: false,
      canDeployToken: true,
      permissionRows: [{ id: "mint-authority" }],
      authorityWallets: [
        { id: "cwlt_a", walletId: "provider_a", label: "Wallet A", publicKey: "address_a" },
        { id: "cwlt_b", walletId: "provider_b", label: "Wallet B", publicKey: "address_b" },
      ],
    } as TokenOperations;
    const draft: Pick<AssetProfileForm["draft"], "signingWalletId" | "authorityWalletIds"> = {
      signingWalletId: "cwlt_a",
      authorityWalletIds: { "mint-authority": assignedId },
    };
    // SAFETY: PermissionsTab only reads draft/saving and invokes updateDraft.
    const form = {
      draft,
      saving: false,
      errors: assignedId === "cwlt_a" ? {} : { authorityWalletIds: "Select a signer wallet" },
      updateDraft: (patch: Partial<AssetProfileForm["draft"]>) => updateDraft(patch),
    } as AssetProfileForm;
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PermissionsTab ops={ops} form={form} canManageTokenAdmin />
      </I18nProvider>
    );

    const select = screen.getByRole("combobox");
    expect(select.textContent).toContain(
      assignedId === "cwlt_a" ? "Wallet A" : "Select a signer wallet"
    );
    if (assignedId !== "cwlt_a")
      expect(screen.getByRole("alert").textContent).toBe("Select a signer wallet");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /Wallet B/ }));
    expect(updateDraft).toHaveBeenCalledWith({
      signingWalletId: "cwlt_b",
      authorityWalletIds: { "mint-authority": "cwlt_b" },
    });
  }
);

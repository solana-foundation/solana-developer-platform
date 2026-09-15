// @vitest-environment jsdom

import type { TokenAllowlistEntry } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TokenActionAdminForms } from "./token-action-admin-forms";
import {
  createInitialAuthorityForm,
  createInitialForceBurnForm,
  createInitialFreezeForm,
  createInitialSeizeForm,
} from "./token-management-workspace.utils";

const entry: TokenAllowlistEntry = {
  id: "tal_test",
  tokenId: "tok_test",
  address: "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe",
  label: "Blocked address",
  status: "active",
  addedBy: "user_test",
  createdAt: "2026-09-15T00:00:00.000Z",
  revokedAt: null,
};

vi.mock("@/lib/dashboard-swr", () => ({
  usePersistedDashboardSWR: (key: readonly unknown[]) => ({
    data: key.length === 2 ? { labels: [] } : { entries: [entry], total: 26 },
    error: null,
    isLoading: false,
    isValidating: false,
  }),
}));

function renderControlList(
  enableControlListSearch: boolean,
  signerUnavailableReason: string | null
) {
  const props: ComponentProps<typeof TokenActionAdminForms> = {
    activeAction: "allowlist",
    isPending: false,
    seizeForm: createInitialSeizeForm(),
    setSeizeForm: vi.fn(),
    forceBurnForm: createInitialForceBurnForm(),
    setForceBurnForm: vi.fn(),
    authorityForm: createInitialAuthorityForm(),
    setAuthorityForm: vi.fn(),
    freezeForm: createInitialFreezeForm(),
    setFreezeForm: vi.fn(),
    allowlistForm: { address: entry.address, label: "Recipient" },
    setAllowlistForm: vi.fn(),
    tokenId: entry.tokenId,
    enableControlListSearch,
    allowlistEntries: [entry],
    allowlistError: null,
    controlListLabel: "Blocked recipients",
    controlListDescription: null,
    controlListAddActionLabel: "Block recipient",
    controlListEmptyState: "No blocked recipients",
    freezeHint: null,
    signerWallets: [],
    walletOptions: [],
    signerUnavailableReason,
    seizeValidationErrors: { source: null, destination: null, amount: null },
    seizeValidationReason: null,
    forceBurnValidationErrors: { source: null, amount: null },
    forceBurnValidationReason: null,
    tokenStatus: "active",
    onSignerWalletIdChange: vi.fn(),
    onSeize: vi.fn(),
    onForceBurn: vi.fn(),
    onAuthorityUpdate: vi.fn(),
    onPause: vi.fn(),
    onFreeze: vi.fn(),
    onAddAllowlist: vi.fn(),
    onRemoveAllowlist: vi.fn(),
  };
  const view = render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TokenActionAdminForms {...props} />
    </I18nProvider>
  );
  return { ...view, props };
}

afterEach(cleanup);

describe.each([false, true])("control-list signing availability (search=%s)", (searchable) => {
  it("blocks add/remove and form submission while keeping the list readable", () => {
    const reason = "Signing is disabled for this wallet.";
    const { container, props } = renderControlList(searchable, reason);
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Block recipient" });
    const remove = screen.getByRole<HTMLButtonElement>("button", { name: /remove/i });
    expect(add.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText(entry.address)).toBeTruthy();
    fireEvent.click(add);
    fireEvent.click(remove);
    const form = container.querySelector("form");
    if (!form) throw new Error("Control-list form not rendered");
    fireEvent.submit(form);
    expect(props.onAddAllowlist).not.toHaveBeenCalled();
    expect(props.onRemoveAllowlist).not.toHaveBeenCalled();
    if (searchable) {
      const search = screen.getByPlaceholderText<HTMLInputElement>(/Search Blocked recipients/);
      expect(search.disabled).toBe(false);
      fireEvent.change(search, { target: { value: "recipient" } });
      expect(search.value).toBe("recipient");
      expect(screen.getByRole<HTMLButtonElement>("button", { name: /next page/i }).disabled).toBe(
        false
      );
    }
  });

  it("keeps mutation actions usable when no signer restriction applies", () => {
    const { props } = renderControlList(searchable, null);
    const add = screen.getByRole<HTMLButtonElement>("button", { name: "Block recipient" });
    const remove = screen.getByRole<HTMLButtonElement>("button", { name: /remove/i });
    expect(add.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    fireEvent.click(add);
    fireEvent.click(remove);
    expect(props.onAddAllowlist).toHaveBeenCalledOnce();
    expect(props.onRemoveAllowlist).toHaveBeenCalledWith(entry.id);
  });
});

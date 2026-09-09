// @vitest-environment jsdom

import type { Token } from "@sdp/types";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { useTokenOperations } from "./use-token-operations";

const mocks = vi.hoisted(() => ({ runAction: vi.fn(), environment: "sandbox" }));
const source = "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe";
const destination = "5wLf85zhVpJ7xBjDCE1KK8yTXyCrbbzoCUuv3Dwsd5PQ";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));
vi.mock("../use-token-action-runner", () => ({
  useTokenActionRunner: () => ({ runAction: mocks.runAction, isPending: false }),
}));
vi.mock("./use-token-operation-data", () => ({
  useTokenOperationData: () => ({
    authorityWallets: [{ id: "wal_test", walletId: "wal_test", publicKey: source }],
    authorityWalletsLoading: false,
    authorityWalletsError: null,
    allowlistEntries: [],
    frozenAccounts: [],
    transactions: [],
    revalidateAfterSuccess: vi.fn(),
  }),
}));

const token: Token = {
  id: "tok_test",
  projectId: "prj_test",
  organizationId: "org_test",
  signingWalletId: "wal_test",
  mintAddress: destination,
  mintAuthority: source,
  metadataAuthority: source,
  freezeAuthority: source,
  ablListAddress: null,
  name: "QA Dollar",
  symbol: "QAD",
  decimals: 6,
  description: null,
  uri: null,
  imageUrl: null,
  template: "stablecoin",
  extensions: { permanentDelegate: source },
  totalSupply: "10",
  maxSupply: "100",
  isMintable: true,
  isFreezable: true,
  requiresAllowlist: false,
  status: "active",
  deployedAt: "2026-09-09T00:00:00.000Z",
  createdBy: "user_test",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderOperations() {
  return renderHook(
    () =>
      useTokenOperations({
        token,
        shouldLoadSupportingData: true,
        shouldLoadAuthorityWallets: true,
        canManageTokenAdmin: true,
      }),
    { wrapper: Wrapper }
  );
}

beforeEach(() => {
  mocks.runAction.mockClear();
  mocks.environment = "sandbox";
});
afterEach(cleanup);

describe("token operation confirmations", () => {
  it.each([false, true])("shows the affected wallet and token for unfreeze=%s", (unfreeze) => {
    const { result } = renderOperations();
    act(() => result.current.setFreezeForm((form) => ({ ...form, accountAddress: ` ${source} ` })));
    act(() => result.current.handleFreeze(unfreeze));
    expect(mocks.runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `/api/dashboard/issuance/tokens/tok_test/${unfreeze ? "unfreeze" : "freeze"}`,
        body: expect.objectContaining({ accountAddress: source }),
      }),
      expect.objectContaining({
        requiresConfirmation: true,
        confirmationWarning: expect.stringContaining(
          unfreeze ? "again" : "other holders are unaffected"
        ),
        confirmationDetails: expect.arrayContaining([
          { label: "Token", value: "QA Dollar (QAD)" },
          { label: "Wallet Address", value: source },
          { label: "Network", value: "Devnet" },
        ]),
      })
    );
  });

  it("shows both addresses and amount before force transfer", () => {
    const { result } = renderOperations();
    act(() =>
      result.current.setSeizeForm((form) => ({ ...form, source, destination, amount: "1" }))
    );
    act(() => result.current.handleSeize());
    expect(mocks.runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          seize: expect.objectContaining({ source, destination, amount: "1" }),
        }),
      }),
      expect.objectContaining({
        requiresConfirmation: true,
        confirmationWarning: expect.stringContaining("without the holder's approval"),
        confirmationDetails: expect.arrayContaining([
          { label: "Amount", value: "1 QAD" },
          { label: "Source", value: source },
          { label: "Destination", value: destination },
          { label: "Network", value: "Devnet" },
        ]),
      })
    );
  });

  it("warns that force burn is irreversible and identifies Mainnet", () => {
    mocks.environment = "production";
    const { result } = renderOperations();
    act(() => result.current.setForceBurnForm((form) => ({ ...form, source, amount: "1" })));
    act(() => result.current.handleForceBurn());
    expect(mocks.runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          forceBurn: expect.objectContaining({ source, amount: "1" }),
        }),
      }),
      expect.objectContaining({
        requiresConfirmation: true,
        confirmationWarning: expect.stringContaining("cannot be undone"),
        confirmationDetails: expect.arrayContaining([
          { label: "Amount", value: "1 QAD" },
          { label: "Source", value: source },
          { label: "Network", value: "Mainnet" },
        ]),
      })
    );
  });
});

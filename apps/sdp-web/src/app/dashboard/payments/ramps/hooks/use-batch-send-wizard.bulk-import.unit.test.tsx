// @vitest-environment jsdom

/**
 * Regression coverage for SOLA9-364: bulk import used to store rows in a map
 * keyed by counterparty account id, so two valid rows for the same account
 * silently collapsed into one recipient leg and the earlier amount was dropped
 * without an error. Duplicate account ids must now be rejected loudly, before
 * any wizard state is mutated, and distinct rows must still import and submit
 * one leg each.
 */

import type { PaymentsDashboardWallet } from "@sdp/types";
import { SOL_MINT } from "@sdp/types";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { resetTransferBatchIdempotencyStateForTests } from "../../transfer-batch-idempotency";
import { type BulkImportRow, validateBulkRows } from "../bulk-import";
import { useBatchSendWizard } from "./use-batch-send-wizard";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastLoading: vi.fn(() => "toast-id"),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: false, orgId: null, userId: null }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments",
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

const ACCOUNT_ID = "cpa_duplicate_import";
const SECOND_ACCOUNT_ID = "cpa_distinct_import";
const COUNTERPARTY_ID = "cpty_duplicate_import";
const SECOND_COUNTERPARTY_ID = "cpty_distinct_import";
const RECIPIENT_ADDRESS = "11111111111111111111111111111111";

const accounts = [
  {
    counterpartyId: COUNTERPARTY_ID,
    counterpartyAccountId: ACCOUNT_ID,
    name: "Duplicate import recipient",
    address: RECIPIENT_ADDRESS,
    label: null,
  },
  {
    counterpartyId: SECOND_COUNTERPARTY_ID,
    counterpartyAccountId: SECOND_ACCOUNT_ID,
    name: "Distinct import recipient",
    address: RECIPIENT_ADDRESS,
    label: null,
  },
];

const wallet: PaymentsDashboardWallet = {
  id: "wallet_duplicate_import",
  walletId: "provider_wallet_duplicate_import",
  isRuntimeExecutionAllowed: true,
  custodyConfigId: "custody_duplicate_import",
  publicKey: RECIPIENT_ADDRESS,
  label: "Import test wallet",
  balances: [
    {
      token: "SOL",
      mint: SOL_MINT,
      amount: "1000000000",
      uiAmount: "1",
      decimals: 9,
    },
  ],
};

const fetchMock = vi.fn<typeof fetch>();
const submittedBodies: unknown[] = [];

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("org:admin")}
        flags={{
          assetProfiles: false,
          custody: true,
          dvp: false,
          earn: false,
          heliusRings: false,
          issuance: false,
          markets: false,
          payments: true,
          policies: false,
          privateChannels: false,
        }}
        serverDashboardCacheScope={{ orgId: "org-import", userId: "user-import" }}
        projects={[]}
        initialSelectedProjectId={null}
        shouldRepairInitialProjectCookie={false}
      >
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

function renderImportWizard() {
  return renderHook(
    () =>
      useBatchSendWizard({
        wallets: [wallet],
        walletsError: null,
        issuedTokenSymbolsByMint: {},
        cluster: "devnet",
        onExit: vi.fn(),
      }),
    { wrapper }
  );
}

beforeEach(() => {
  submittedBodies.length = 0;
  resetTransferBatchIdempotencyStateForTests();
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const requestUrl = new URL(String(input), "https://dashboard.example.test");

    if (requestUrl.pathname === "/api/dashboard/wallets") {
      return Response.json({ data: { wallets: [wallet] } });
    }

    if (requestUrl.pathname === "/api/dashboard/counterparty/accounts") {
      return Response.json({
        data: {
          accounts,
          total: accounts.length,
          page: Number(requestUrl.searchParams.get("page") ?? "1"),
          pageSize: Number(requestUrl.searchParams.get("pageSize") ?? String(accounts.length)),
        },
      });
    }

    if (requestUrl.pathname.endsWith("/batch/estimate")) {
      return Response.json({
        data: { estimate: { recipientCount: 2, transactionCount: 1 } },
      });
    }

    if (requestUrl.pathname.endsWith("/batch") && init?.method === "POST") {
      submittedBodies.push(JSON.parse(String(init.body)));
      return Response.json({
        data: {
          batch: { status: "processing" },
          recipients: [{}],
          transfers: [],
        },
      });
    }

    return Response.json({ data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("batch send wizard bulk import duplicate rows", () => {
  it("rejects two rows for the same account instead of silently collapsing them", async () => {
    const duplicateRows: BulkImportRow[] = [
      { accountId: ACCOUNT_ID, currency: SOL_MINT, amount: "0.1" },
      { accountId: ACCOUNT_ID, currency: SOL_MINT, amount: "0.2" },
    ];

    const { result } = renderImportWizard();
    await waitFor(() => expect(result.current.recipientsLoading).toBe(false));

    let importError: unknown = null;
    await act(async () => {
      try {
        await result.current.bulkImport(duplicateRows);
      } catch (error) {
        importError = error;
      }
    });

    expect(importError).toBeInstanceOf(Error);
    expect((importError as Error).message).toMatch(/Duplicate/);
    expect(result.current.recipients).toEqual([]);
    expect(result.current.totalAmount).toBe("0");
  });

  it("still imports every distinct account row and submits one leg per row", async () => {
    const distinctRows: BulkImportRow[] = [
      { accountId: ACCOUNT_ID, currency: SOL_MINT, amount: "0.1" },
      { accountId: SECOND_ACCOUNT_ID, currency: SOL_MINT, amount: "0.2" },
    ];
    const validation = validateBulkRows(distinctRows);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toHaveLength(2);

    const { result } = renderImportWizard();
    await waitFor(() => expect(result.current.recipientsLoading).toBe(false));

    await act(async () => {
      await result.current.bulkImport(validation.valid);
    });
    act(() => result.current.selectWallet(wallet.id));

    expect(result.current.recipients).toHaveLength(2);
    expect(result.current.totalAmount).toBe("0.3");

    await act(async () => result.current.handlePrimary());
    await waitFor(() => expect(result.current.currentStepId).toBe("REVIEW"));
    await act(async () => result.current.handlePrimary());

    expect(submittedBodies).toHaveLength(1);
    const submitted = submittedBodies[0] as {
      recipients: Array<{ counterpartyAccountId: string; amount: string }>;
    };
    expect(submitted.recipients).toHaveLength(2);
    expect(submitted.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ counterpartyAccountId: ACCOUNT_ID, amount: "0.1" }),
        expect.objectContaining({ counterpartyAccountId: SECOND_ACCOUNT_ID, amount: "0.2" }),
      ])
    );
  });

  it("reports row-specific duplicate errors from validateBulkRows before the wizard is touched", () => {
    const duplicateRows: BulkImportRow[] = [
      { accountId: ACCOUNT_ID, currency: SOL_MINT, amount: "0.1" },
      { accountId: ACCOUNT_ID, currency: SOL_MINT, amount: "0.2" },
    ];

    const { valid, errors } = validateBulkRows(duplicateRows);
    expect(errors).toEqual([
      {
        row: 2,
        message: "Duplicate counterparty_wallet_id",
        duplicateAccountId: ACCOUNT_ID,
      },
    ]);
    expect(valid).toEqual([duplicateRows[0]]);
  });
});

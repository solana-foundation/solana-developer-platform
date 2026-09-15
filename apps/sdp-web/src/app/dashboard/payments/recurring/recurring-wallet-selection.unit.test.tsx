// @vitest-environment jsdom

import type {
  Counterparty,
  CounterpartyAccount,
  PaymentRecurringPayment,
  PaymentsDashboardWallet,
} from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RecurringPaymentCreateWorkspace } from "./recurring-payment-create-workspace";
import { RecurringPaymentDetailWorkspace } from "./recurring-payment-detail-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
  }),
  useOptionalDashboardWorkspace: () => null,
}));

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const source: PaymentsDashboardWallet = {
  id: "cwlt_source",
  walletId: "privy_shared",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "USDC", mint: MINT, amount: "10000000", uiAmount: "10", decimals: 6 }],
};
const recurring: PaymentRecurringPayment = {
  id: "prp_test",
  organizationId: "org_test",
  projectId: "proj_test",
  sourceCustodyWalletId: source.id,
  sourceProviderWalletId: source.walletId,
  sourceAddress: source.publicKey,
  counterpartyId: "cpty_receiver",
  counterpartyAccountId: "cpa_receiver",
  destinationAddress: source.publicKey,
  destinationTokenAccount: null,
  token: MINT,
  amount: "1",
  periodHours: 24,
  firstCollectionAt: null,
  nextCollectionDueAt: null,
  planId: null,
  subscriptionId: null,
  planPda: null,
  planCreatedAt: null,
  planCreationSignature: null,
  subscriptionPda: null,
  subscriptionAuthorityAddress: null,
  authorizationSignature: null,
  status: "active",
  metadataUri: null,
  createdBy: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};
const counterparty: Counterparty = {
  id: "cpty_receiver",
  organizationId: "org_test",
  projectId: "proj_test",
  externalId: null,
  displayName: "Receiver",
  entityType: "business",
  status: "active",
  createdBy: null,
  createdAt: recurring.createdAt,
  updatedAt: recurring.updatedAt,
};
const account: CounterpartyAccount = {
  id: "cpa_receiver",
  organizationId: "org_test",
  projectId: "proj_test",
  counterpartyId: counterparty.id,
  accountKind: "crypto_wallet",
  label: "Receiving wallet",
  details: { address: source.publicKey },
  providerAccountData: {},
  status: "active",
  createdAt: recurring.createdAt,
  updatedAt: recurring.updatedAt,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Recurring Payment exact source selection", () => {
  it("does not carry a previous wallet preload into another Project's inventory", async () => {
    let inventory = [source];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: inventory } });
      return Response.json({
        data: { counterparties: [counterparty], accounts: [account], total: 1 },
      });
    });
    const first = render(
      <RecurringPaymentCreateWorkspace
        wallets={[source]}
        walletsError={null}
        issuedTokenSymbolsByMint={{}}
        issuedTokensByMint={{}}
        counterpartiesResult={{ ok: true, data: [counterparty] }}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Counterparty" }));
    await user.click(screen.getByRole("button", { name: /Receiver/ }));
    first.unmount();

    const other = { ...source, id: "cwlt_other_project", label: "Other Project" };
    inventory = [other];
    render(
      <RecurringPaymentDetailWorkspace
        recurringPayment={{
          ...recurring,
          projectId: "proj_other",
          sourceCustodyWalletId: other.id,
        }}
        wallet={other}
        wallets={[other]}
        issuedTokensByMint={{}}
        counterpartyAccounts={[account]}
        counterpartyLabel="Receiver"
        amountLabel="1 USDC"
        collectionAttempts={[]}
        collectionAttemptsTotal={0}
      />,
      { wrapper }
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit payment" }));
    await user.click(screen.getByRole("button", { name: "Funding wallet" }));
    expect(await screen.findByRole("button", { name: /Other Project/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Treasury/ })).toBeNull();
  });

  it("saves a pending payment with a Connection wallet even when signing is unavailable", async () => {
    const unavailable = { ...source, isRuntimeExecutionAllowed: false };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: [unavailable] } });
      if (String(input).includes("/accounts?"))
        return Response.json({ data: { accounts: [account] } });
      if (init?.method === "POST") writes.push(JSON.parse(String(init.body)));
      return Response.json({
        data: {
          counterparties: [counterparty],
          total: 1,
          recurringPayment: { ...recurring, status: "pending_activation" },
        },
      });
    });
    render(
      <RecurringPaymentCreateWorkspace
        wallets={[unavailable]}
        walletsError={null}
        issuedTokenSymbolsByMint={{}}
        issuedTokensByMint={{}}
        counterpartiesResult={{ ok: true, data: [counterparty] }}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Counterparty" }));
    await user.click(screen.getByRole("button", { name: /Receiver/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Destination account" }));
    await user.click(screen.getByRole("button", { name: /Receiving wallet/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Funding wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    expect(screen.getByText(/Signing is disabled for this wallet\./)).toBeTruthy();
    await user.type(screen.getByRole("spinbutton", { name: "Amount" }), "1");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Create recurring payment" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ sourceCustodyWalletId: source.id, amount: "1" });
  });

  it.each(["current", "replacement"])(
    "prevents active source replacement when the %s wallet cannot sign",
    async (unavailableWallet) => {
      const currentSource = {
        ...source,
        isRuntimeExecutionAllowed: unavailableWallet !== "current",
      };
      const replacement = {
        ...source,
        id: "cwlt_replacement",
        label: "Replacement",
        isRuntimeExecutionAllowed: unavailableWallet !== "replacement",
      };
      const writes: unknown[] = [];
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") writes.push(JSON.parse(String(init.body)));
        return Response.json({
          data: { wallets: [currentSource, replacement], recurringPayment: recurring },
        });
      });
      render(
        <RecurringPaymentDetailWorkspace
          recurringPayment={recurring}
          wallet={currentSource}
          wallets={[currentSource, replacement]}
          issuedTokensByMint={{}}
          counterpartyAccounts={[]}
          counterpartyLabel="Receiver"
          amountLabel="1 USDC"
          collectionAttempts={[]}
          collectionAttemptsTotal={0}
        />,
        { wrapper }
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Actions" }));
      const edit = screen.getByRole("menuitem", { name: "Edit payment" });
      if (unavailableWallet === "current") {
        // Nothing about an active payment can be saved without its wallet's
        // signature, so the editor stays shut and the band carries the reason.
        expect(edit.getAttribute("aria-disabled")).toBe("true");
        expect(
          screen.getByText(
            /You cannot collect, change, or cancel this payment until signing is enabled for Treasury/
          )
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
        return;
      }
      await user.click(edit);
      await user.click(screen.getByRole("button", { name: "Funding wallet" }));
      await user.click(screen.getByRole("button", { name: /Replacement/ }));
      const save = screen.getByRole("button", { name: "Save" });
      expect((save as HTMLButtonElement).disabled).toBe(true);
      const form = save.closest("form");
      if (!form) throw new Error("Expected the payment edit form");
      fireEvent.submit(form);
      await waitFor(() => expect(writes).toEqual([]));
    }
  );
});

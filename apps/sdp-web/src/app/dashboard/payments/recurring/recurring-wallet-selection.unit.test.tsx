// @vitest-environment jsdom

import type {
  Counterparty,
  CounterpartyAccount,
  PaymentRecurringPayment,
  PaymentsDashboardWallet,
} from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    flags: { custody: true },
  }),
  useOptionalDashboardWorkspace: () => null,
}));

// Devnet USDC: the mocked dashboard runs in the sandbox environment, and the
// recurring mint rule only allows USD stablecoins deployed on the active
// cluster (or tokens issued in the project).
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const source: PaymentsDashboardWallet = {
  id: "cwlt_source",
  walletId: "privy_shared",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  isRuntimeExecutionAllowed: true,
  balances: [{ token: "USDC", mint: MINT, amount: "10000000", uiAmount: "10", decimals: 6 }],
};
const recurring: PaymentRecurringPayment & { sourceCustodyWalletId: string } = {
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
      // A restricted replacement is listed and badged, but not on offer: the
      // click changes nothing and the current wallet stays selected.
      const replacementOption = screen.getByRole("button", { name: /Replacement/ });
      expect(replacementOption.getAttribute("aria-disabled")).toBe("true");
      expect(replacementOption.textContent).toContain("Restricted");
      fireEvent.click(replacementOption);
      expect(screen.getByRole("button", { name: /Replacement/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Funding wallet" }).textContent).toContain(
        "Treasury"
      );
      await waitFor(() => expect(writes).toEqual([]));
    }
  );

  it("resets the currency to the new wallet's inventory when switching funding wallets", async () => {
    // A valid non-SOL mint that is neither USDC nor a well-known token.
    const otherMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYC";
    const replacement = {
      ...source,
      id: "cwlt_replacement",
      label: "Replacement",
      balances: [
        {
          token: "WOOF",
          mint: otherMint,
          amount: "5",
          uiAmount: "5",
          decimals: 6,
        },
      ],
    };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: [source, replacement] } });
      if (init?.method === "PATCH") writes.push(JSON.parse(String(init.body)));
      return Response.json({
        data: { wallets: [source, replacement], recurringPayment: recurring },
      });
    });
    render(
      <RecurringPaymentDetailWorkspace
        recurringPayment={recurring}
        wallet={source}
        wallets={[source, replacement]}
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
    await user.click(screen.getByRole("menuitem", { name: "Edit payment" }));
    const editor = screen.getByRole("dialog", { name: "Edit payment" });
    expect(within(editor).getByText(/USDC/)).toBeTruthy();
    await user.click(within(editor).getByRole("button", { name: "Funding wallet" }));
    await user.click(screen.getByRole("button", { name: /Replacement/ }));
    // The stale USDC mint is not in the replacement wallet's inventory, and
    // WOOF is not recurring-eligible, so nothing eligible is selected: the
    // currency clears instead of pairing the new wallet with an ineligible or
    // stale mint.
    await waitFor(() => {
      expect(within(editor).queryByText(/USDC/)).toBeNull();
      expect(within(editor).queryByText(/WOOF/)).toBeNull();
    });
  });

  it("skips an ineligible first balance when falling back after a wallet switch", async () => {
    // A valid non-SOL mint that is neither a well-known token nor issued in
    // this project, so it is not eligible for recurring payments.
    const ineligibleMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYC";
    const eligibleDevnetMint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const replacement = {
      ...source,
      id: "cwlt_replacement",
      label: "Replacement",
      balances: [
        {
          token: "WOOF",
          mint: ineligibleMint,
          amount: "5",
          uiAmount: "5",
          decimals: 6,
        },
        {
          token: "USDC",
          mint: eligibleDevnetMint,
          amount: "7",
          uiAmount: "7",
          decimals: 6,
        },
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: [source, replacement] } });
      return Response.json({
        data: { wallets: [source, replacement], recurringPayment: recurring },
      });
    });
    render(
      <RecurringPaymentDetailWorkspace
        recurringPayment={recurring}
        wallet={source}
        wallets={[source, replacement]}
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
    await user.click(screen.getByRole("menuitem", { name: "Edit payment" }));
    const editor = screen.getByRole("dialog", { name: "Edit payment" });
    await user.click(within(editor).getByRole("button", { name: "Funding wallet" }));
    await user.click(screen.getByRole("button", { name: /Replacement/ }));
    // The fallback must not select WOOF, which sits first in the wallet's
    // balances but is not recurring-eligible; it skips to the eligible USDC.
    await waitFor(() => {
      expect(within(editor).getByText(/USDC/)).toBeTruthy();
      expect(within(editor).queryByText(/WOOF/)).toBeNull();
    });
  });

  it("offers only recurring-eligible currencies and keeps the one picked", async () => {
    // Neither well-known nor issued in this project, so never eligible.
    const unknownMint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYC";
    const pausedIssuedMint = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const activeIssuedMint = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
    const balance = (token: string, mint: string) => ({
      token,
      mint,
      amount: "5",
      uiAmount: "5",
      decimals: 6,
    });
    const replacement = {
      ...source,
      id: "cwlt_replacement",
      label: "Replacement",
      balances: [
        balance("WOOF", unknownMint),
        balance("HALT", pausedIssuedMint),
        balance("LIVE", activeIssuedMint),
        balance("USDC", MINT),
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("/wallets?"))
        return Response.json({ data: { wallets: [source, replacement] } });
      return Response.json({
        data: { wallets: [source, replacement], recurringPayment: recurring },
      });
    });
    render(
      <RecurringPaymentDetailWorkspace
        recurringPayment={recurring}
        wallet={source}
        wallets={[source, replacement]}
        issuedTokensByMint={{
          [pausedIssuedMint]: {
            id: "tok_halt",
            mintAddress: pausedIssuedMint,
            symbol: "HALT",
            imageUrl: null,
            status: "paused",
          },
          [activeIssuedMint]: {
            id: "tok_live",
            mintAddress: activeIssuedMint,
            symbol: "LIVE",
            imageUrl: null,
            status: "active",
          },
        }}
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
    await user.click(screen.getByRole("menuitem", { name: "Edit payment" }));
    const editor = screen.getByRole("dialog", { name: "Edit payment" });
    await user.click(within(editor).getByRole("button", { name: "Funding wallet" }));
    await user.click(screen.getByRole("button", { name: /Replacement/ }));
    await user.click(within(editor).getByRole("button", { name: "Currency" }));

    expect(screen.getByRole("button", { name: /USDC/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /WOOF/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /HALT/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /LIVE/ }));
    await waitFor(() => {
      expect(within(editor).getByText(/LIVE/)).toBeTruthy();
      expect(within(editor).queryByText(/USDC/)).toBeNull();
    });
  });
});

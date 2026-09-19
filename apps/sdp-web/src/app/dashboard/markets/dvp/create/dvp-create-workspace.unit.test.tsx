// @vitest-environment jsdom

/**
 * The create form, rendered.
 *
 * Covers what the hook tests cannot: that the pieces are wired to each other.
 * The form's job is to keep someone from creating a trade that moves the wrong
 * amount, so the assertions are about what it refuses and what it discloses,
 * not about layout.
 */

import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { shortenAddress } from "../../../payments/payments-overview.utils";
import type { DvpCreateContext } from "./dvp-create.data";
import { DvpCreateWorkspace } from "./dvp-create-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PARTY_B = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";
const PARTY_A = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
/** Somewhere neither party funds from, so re-seeding cannot produce it by accident. */
const REDIRECT = "8kQmPzRw2Fy6Tn4VdHsXbLcJgAeUq3MvNrZtYwSfDh5B";

const context: DvpCreateContext = {
  error: null,
  wallets: [
    {
      id: "cwlt_1",
      address: PARTY_A,
      label: "Treasury",
      custodyConfigId: "cc_config",
      isRuntimeExecutionAllowed: true,
      balances: [],
    },
  ],
  counterpartyAccounts: [
    {
      counterpartyAccountId: "cpa_1",
      name: "Acme OTC",
      label: "Settlement wallet",
      address: "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC",
    },
  ],
  tokens: [
    {
      mint: "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1",
      label: "TBOND",
      name: "Test Bond",
      decimals: 6,
      tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
    },
  ],
};

function renderForm(
  overrides: Partial<DvpCreateContext> = {},
  cluster: "devnet" | "mainnet-beta" = "devnet"
) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpCreateWorkspace cluster={cluster} context={{ ...context, ...overrides }} />
    </I18nProvider>
  );
}

const BUYER_ROW = 0;
const SELLER_ROW = 1;

/**
 * Switches one party row's mode; the rows render buyer first.
 *
 * @param row - Which party row, BUYER_ROW or SELLER_ROW.
 * @param name - The mode's label.
 * @returns Nothing.
 */
function pickMode(row: number, name: RegExp): void {
  fireEvent.click(screen.getAllByRole("radio", { name })[row]);
}

/**
 * Switches one party slot to its address mode and types an address.
 *
 * @param label - The party slot's accessible label.
 * @param row - Which party row, BUYER_ROW or SELLER_ROW.
 * @param query - The address text to enter.
 * @returns Nothing.
 */
function searchParty(label: RegExp, row: number, query: string): void {
  pickMode(row, /paste an address/i);
  fireEvent.change(screen.getByLabelText(label), {
    target: { value: query },
  });
}

/** Fills the seller slot by picking the registered counterparty. */
function fillPartyA(): void {
  pickMode(SELLER_ROW, /^counterparty$/i);
  fireEvent.click(screen.getByRole("button", { name: /delivering the asset/i }));
  fireEvent.click(screen.getByText("Acme OTC"));
}

/**
 * Fills the cash payer slot with a pasted address.
 *
 * @param address - The address to enter.
 * @returns Nothing.
 */
function fillPartyB(address: string): void {
  searchParty(/paying the cash/i, BUYER_ROW, address);
}

/** Picks the issued token in the asset slot, which starts unselected. */
function fillAssetMint() {
  fireEvent.click(screen.getByRole("button", { name: /^asset/i }));
  fireEvent.click(screen.getByText("TBOND"));
}

/** Picks the first stablecoin in the cash slot, which also starts unselected. */
function fillCashMint() {
  fireEvent.click(screen.getByRole("button", { name: /^cash/i }));
  fireEvent.click(screen.getByText("USDC"));
}

/** Fills both legs' amounts, the last input the legs step gates on. */
function fillAmounts() {
  fireEvent.change(screen.getByLabelText(/asset amount/i), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText(/cash amount/i), { target: { value: "25" } });
}

/** The seller payout picker's trigger, which names whatever that side resolves to. */
function sellerPayoutTrigger(): HTMLElement {
  return screen.getByRole("button", { name: /seller payout address/i });
}

/** Turns the default off, which reveals both payout pickers seeded from their parties. */
function revealPayouts(): void {
  fireEvent.click(screen.getByRole("switch", { name: /pay proceeds/i }));
}

/**
 * Sends the seller's proceeds to an address that is not its party.
 *
 * @param address - The address to redirect to.
 * @returns Nothing.
 */
function redirectSellerPayout(address: string): void {
  fireEvent.click(sellerPayoutTrigger());
  fireEvent.change(screen.getByPlaceholderText(/search, or paste a solana address/i), {
    target: { value: address },
  });
  fireEvent.click(screen.getByText(shortenAddress(address)));
}

/**
 * Fills the one configuring step and continues to review. Continue is disabled
 * until the step is complete, so navigating IS the assertion that the step can
 * be satisfied.
 */
async function advanceToReview() {
  fillPartyA();
  fillPartyB(PARTY_B);
  fillAssetMint();
  fillCashMint();
  fillAmounts();
  // Both mints are inspected for eligibility, so Continue is disabled until
  // those answers land, the same wait a person sees.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /continue/i }).hasAttribute("disabled")).toBe(false)
  );
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

/**
 * Every chosen mint is inspected, listed ones included, and the form waits for
 * that answer. Unless a test says otherwise, the mint comes back eligible.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          mint: {
            decimals: 6,
            name: "Test Bond",
            symbol: "TBOND",
            tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
            eligible: true,
            blockedBy: null,
          },
        },
      }),
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DvpCreateWorkspace", () => {
  // Continue gates each stage, so an empty form cannot even reach the review
  // stage where Create lives.
  it("cannot leave the parties stage until both slots are filled", () => {
    renderForm();

    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("selects an SDP wallet by default and fills the slot", () => {
    renderForm();

    expect(screen.getAllByRole("radio", { name: /^sdp wallet$/i })[SELLER_ROW]).toHaveProperty(
      "checked",
      true
    );
    fireEvent.click(screen.getByRole("button", { name: /delivering the asset/i }));
    expect(screen.getByText("Treasury")).toBeTruthy();
    fireEvent.click(screen.getByText("Treasury"));
    expect(screen.getByRole("button", { name: /delivering the asset/i }).textContent).toContain(
      "Treasury"
    );
  });

  it("lists registered counterparties in counterparty mode", () => {
    renderForm();

    pickMode(BUYER_ROW, /^counterparty$/i);
    fireEvent.click(screen.getByRole("button", { name: /paying the cash/i }));
    expect(screen.getByText("Acme OTC")).toBeTruthy();
  });

  it("accepts valid pasted addresses and rejects malformed ones", () => {
    renderForm();

    searchParty(/delivering the asset/i, SELLER_ROW, PARTY_A);
    fillPartyB(PARTY_B);
    expect(screen.queryByText("Not a valid Solana address")).toBeNull();

    fireEvent.change(screen.getByLabelText(/paying the cash/i), { target: { value: "garbage" } });
    expect(screen.getByText("Not a valid Solana address")).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("trims a pasted address so surrounding whitespace never blocks Continue", async () => {
    renderForm();
    fillPartyA();
    fillPartyB(`  ${PARTY_B}  `);
    fillAssetMint();
    fillCashMint();
    fillAmounts();

    expect(screen.queryByText("Not a valid Solana address")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", false)
    );
  });

  it("clears a filled slot when its mode changes", async () => {
    renderForm();
    fillPartyA();
    fillPartyB(PARTY_B);
    fillAssetMint();
    fillCashMint();
    fillAmounts();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", false)
    );

    pickMode(SELLER_ROW, /^sdp wallet$/i);
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("reaches review once every stage is answered, and only then offers Create", async () => {
    renderForm();
    await advanceToReview();

    expect(screen.getByRole("button", { name: /create trade/i })).toBeTruthy();
  });

  // The scale is enforced at the keystroke: a digit the mint cannot represent
  // never lands in the field, so no correction hint is ever needed.
  it("blocks typing more decimal places than the mint supports", () => {
    renderForm();
    fillAssetMint();
    const input = screen.getByLabelText(/asset amount/i) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1.999999" } });
    fireEvent.change(input, { target: { value: "1.9999999" } });

    expect(input.value).toBe("1.999999");
  });

  // The program refuses one address on both sides, and the parties step is the
  // cheap place to say so rather than a provider-call round trip.
  it("refuses to proceed when both slots resolve to the same address", () => {
    renderForm();

    searchParty(/delivering the asset/i, SELLER_ROW, PARTY_B);
    fillPartyB(PARTY_B);

    expect(screen.getByText(/Both sides are the same address/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  // The program is devnet-only, so filling in the whole form on another
  // cluster would end in a refusal at submit.
  it("warns before you start when the project is not on devnet", () => {
    renderForm({}, "mainnet-beta");

    expect(screen.getByText(/deployed on devnet only/i)).toBeTruthy();
  });

  it("does not warn on devnet", () => {
    renderForm();

    expect(screen.queryByText(/deployed on devnet only/i)).toBeNull();
  });

  // A failed token load must not read as "you have no tokens", and the form
  // still has to be usable with a pasted mint.
  // PRO-2016. An org that has issued nothing still has an asset leg to fill.
  // The list used to be the issued tokens alone, so this picker came up empty
  // and the wizard could not be completed at all.
  it("offers catalogue assets when the org has issued no tokens", () => {
    renderForm({ tokens: [] });

    fireEvent.click(screen.getByRole("button", { name: /^asset/i }));

    expect(screen.queryByText(/no options available/i)).toBeNull();
    expect(screen.getByText("USDC")).toBeTruthy();
  });

  // The paste escape hatch is real but was invisible: the search box said
  // "Search for assets" and the empty panel said the list was unavailable.
  it("says a mint address can be pasted", () => {
    renderForm({ tokens: [] });

    fireEvent.click(screen.getByRole("button", { name: /^asset/i }));

    expect(screen.getByPlaceholderText(/search, or paste a mint address/i)).toBeTruthy();
  });

  it("surfaces a context error rather than showing an empty picker silently", () => {
    renderForm({ error: "Token list failed (500).", tokens: [] });

    expect(screen.getByText("Token list failed (500).")).toBeTruthy();
  });

  // "ATD (6 decimals)" is a fact about how the chain stores the amount, not a
  // reason to choose one token over another — and with both legs usually at six
  // it was the same suffix on every option. The scale is stated where it can
  // act on the number: the amount field's hint and its conversion line.
  it("names the token in the picker without its decimal count", () => {
    const { container } = renderForm();

    expect(container.textContent).not.toContain("decimals)");
  });

  // PRO-1951. An issued token can carry a transfer hook. Picking one says so at
  // the field, and Continue stays disabled, instead of a 400 at the very end.
  it("refuses a transfer-hook token at the field, before any amount is typed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            mint: {
              decimals: 6,
              name: "Test Bond",
              symbol: "TBOND",
              tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
              eligible: false,
              blockedBy: "TransferHook",
            },
          },
        }),
      })
    );
    renderForm();

    fillPartyA();
    fillPartyB(PARTY_B);
    fillAssetMint();
    fillCashMint();
    fillAmounts();

    expect(
      await screen.findByText(
        "This token runs a transfer hook, which SDP can't settle, cancel or reclaim yet. Pick another token."
      )
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /continue/i }).hasAttribute("disabled")).toBe(true)
    );
  });

  // PRO-2015. Re-seeding a payout from its party keeps the DEFAULT honest; it
  // must not reach a redirect somebody chose. Losing that silently sends the
  // proceeds to an address the form no longer shows.
  it("keeps a chosen payout address when that side's party is edited", () => {
    renderForm();
    fillPartyA();
    fillPartyB(PARTY_B);
    revealPayouts();
    redirectSellerPayout(REDIRECT);

    // Correct the seller after choosing the redirect, the order somebody
    // fixing a typo would use.
    searchParty(/delivering the asset/i, SELLER_ROW, PARTY_A);

    expect(sellerPayoutTrigger().textContent).toContain(shortenAddress(REDIRECT));
  });

  // The other half of the same rule: a payout still sitting on the party's own
  // address is a default, so it has to follow the party it mirrors.
  it("re-seeds a payout that was never changed away from its party", () => {
    renderForm();
    fillPartyA();
    fillPartyB(PARTY_B);
    revealPayouts();

    expect(sellerPayoutTrigger().textContent).toContain("Acme OTC");

    searchParty(/delivering the asset/i, SELLER_ROW, PARTY_A);

    expect(sellerPayoutTrigger().textContent).toContain(shortenAddress(PARTY_A));
  });
});

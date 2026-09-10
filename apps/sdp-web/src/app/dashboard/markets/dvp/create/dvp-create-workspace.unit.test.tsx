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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { DvpCreateContext } from "./dvp-create.data";
import { DvpCreateWorkspace } from "./dvp-create-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PARTY_B = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

const context: DvpCreateContext = {
  error: null,
  wallets: [
    {
      id: "cwlt_1",
      address: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn",
      label: "Treasury",
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

/** Opens a party combobox by its label and types into its search box. */
function searchParty(trigger: RegExp, query: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  fireEvent.change(screen.getByPlaceholderText(/paste a Solana address/i), {
    target: { value: query },
  });
}

/** Fills the seller slot by picking the registered counterparty. */
function fillPartyA() {
  fireEvent.click(screen.getByRole("button", { name: /delivering the asset/i }));
  fireEvent.click(screen.getByText("Acme OTC"));
}

/**
 * Fills the cash payer slot by pasting an address and picking the option it
 * surfaces. The last match is the open popover's option — a pasted address
 * already selected in the other slot shows the same text in its trigger.
 */
function fillPartyB(address: string = PARTY_B) {
  searchParty(/paying the cash/i, address);
  const options = screen.getAllByText("Use this address");
  fireEvent.click(options[options.length - 1]);
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

/**
 * Fills the one configuring step and continues to review. Continue is disabled
 * until the step is complete, so navigating IS the assertion that the step can
 * be satisfied.
 */
function advanceToReview() {
  fillPartyA();
  fillPartyB();
  fillAssetMint();
  fillCashMint();
  fillAmounts();
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

afterEach(cleanup);

describe("DvpCreateWorkspace", () => {
  // Continue gates each stage, so an empty form cannot even reach the review
  // stage where Create lives.
  it("cannot leave the parties stage until both slots are filled", () => {
    renderForm();

    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  // One combobox per slot: registered counterparties are options — custody
  // wallets deliberately are not, a wallet is not a counterparty — and a
  // pasted base58 address surfaces as an option of its own.
  it("offers counterparties and pasted addresses, never custody wallets", () => {
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: /paying the cash/i }));

    expect(screen.getByText("Acme OTC")).toBeTruthy();
    expect(screen.queryByText("Treasury")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/paste a Solana address/i), {
      target: { value: PARTY_B },
    });
    expect(screen.getByText("Use this address")).toBeTruthy();
  });

  it("reaches review once every stage is answered, and only then offers Create", () => {
    renderForm();
    advanceToReview();

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

  // A malformed paste never becomes an option, so the slot cannot hold an
  // invalid address at all — refusal happens before selection, not after.
  it("offers no address option for a paste that is not a Solana address", () => {
    renderForm();

    searchParty(/paying the cash/i, "nope");

    expect(screen.queryByText("Use this address")).toBeNull();
  });

  // The program refuses one address on both sides, and the parties step is the
  // cheap place to say so rather than a provider-call round trip.
  it("refuses to proceed when both slots resolve to the same address", () => {
    renderForm();

    searchParty(/delivering the asset/i, PARTY_B);
    fireEvent.click(screen.getByText("Use this address"));
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
});

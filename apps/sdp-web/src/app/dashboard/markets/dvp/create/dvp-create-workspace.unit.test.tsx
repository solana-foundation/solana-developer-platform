// @vitest-environment jsdom

/**
 * The create form, rendered.
 *
 * Covers what the hook tests cannot: that the pieces are wired to each other.
 * The form's job is to keep someone from creating a trade that moves the wrong
 * amount, so the assertions are about what it refuses and what it discloses,
 * not about layout.
 */

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
      decimals: 6,
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
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

/** Fills the second party slot with a pasted address (the first is preselect). */
function fillPartyB(address: string = PARTY_B) {
  fireEvent.change(screen.getByRole("textbox", { name: /second party/i }), {
    target: { value: address },
  });
}

/** Fills both legs' amounts, the last input the legs step gates on. */
function fillAmounts() {
  fireEvent.change(screen.getByLabelText(/asset amount/i), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText(/cash amount/i), { target: { value: "25" } });
}

/**
 * Walks the wizard to a stage, filling only what the previous stages require.
 *
 * Continue is disabled until a stage is complete, so navigating IS the
 * assertion that each stage can be satisfied on its own — which is most of
 * what staging bought.
 */
function advanceTo(stage: "legs" | "terms" | "review") {
  const next = () => fireEvent.click(screen.getByRole("button", { name: /continue/i }));
  fillPartyB();
  next(); // parties -> legs
  if (stage === "legs") return;

  fillAmounts();
  next(); // legs -> terms
  if (stage === "terms") return;

  next(); // terms -> review
}

afterEach(cleanup);

describe("DvpCreateWorkspace", () => {
  // Continue gates each stage, so an empty form cannot even reach the review
  // stage where Create lives.
  it("cannot leave the parties stage until both slots are filled", () => {
    renderForm();

    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("offers the three ways to name a party in each slot", () => {
    renderForm();

    expect(screen.getAllByText("My wallets").length).toBe(2);
    expect(screen.getAllByText("Counterparties").length).toBe(2);
    expect(screen.getAllByText("Paste address").length).toBe(2);
  });

  it("reaches review once every stage is answered, and only then offers Create", () => {
    renderForm();
    advanceTo("review");

    expect(screen.getByRole("button", { name: /create trade/i })).toBeTruthy();
  });

  // The whole point of the conversion: the amount the chain receives is shown
  // before it is sent, so a three-orders-of-magnitude mistake is visible.
  it("discloses the base units a typed amount resolves to", () => {
    renderForm();
    advanceTo("legs");

    fireEvent.change(screen.getByLabelText(/asset amount/i), { target: { value: "10.5" } });

    expect(screen.getAllByText(/10500000/).length).toBeGreaterThan(0);
  });

  // Truncating would move a different amount than the one on screen, so the
  // form has to say so rather than rounding.
  it("refuses an amount finer than the mint allows, and says why", () => {
    renderForm();
    advanceTo("legs");

    fireEvent.change(screen.getByLabelText(/asset amount/i), { target: { value: "1.9999999" } });

    expect(screen.getByText(/More decimal places than/i)).toBeTruthy();
  });

  it("flags a pasted party address that is not a Solana address", () => {
    renderForm();

    fireEvent.change(screen.getByRole("textbox", { name: /second party/i }), {
      target: { value: "nope" },
    });

    expect(screen.getByText(/does not look like a Solana address/i)).toBeTruthy();
  });

  // The program refuses one address on both sides, and the parties step is the
  // cheap place to say so rather than a provider-call round trip.
  it("refuses to proceed when both slots resolve to the same address", () => {
    renderForm();

    fireEvent.change(screen.getByRole("textbox", { name: /second party/i }), {
      target: { value: "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn" },
    });

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

  // The payer defaults to the project settlement wallet, editable on review.
  it("defaults the payer to the project settlement wallet on review", () => {
    renderForm();
    advanceTo("review");

    expect(screen.getByText("Project settlement wallet (default)")).toBeTruthy();
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

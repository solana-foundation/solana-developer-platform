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

afterEach(cleanup);

describe("DvpCreateWorkspace", () => {
  it("cannot be submitted until both legs and a counterparty are set", () => {
    renderForm();

    expect(screen.getByRole("button", { name: /create trade/i })).toHaveProperty("disabled", true);
  });

  // The whole point of the conversion: the amount the chain receives is shown
  // before it is sent, so a three-orders-of-magnitude mistake is visible.
  it("discloses the base units a typed amount resolves to", () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/asset amount/i), { target: { value: "10.5" } });

    expect(screen.getByText(/10500000/)).toBeTruthy();
  });

  // Truncating would move a different amount than the one on screen, so the
  // form has to say so rather than rounding.
  it("refuses an amount finer than the mint allows, and says why", () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/asset amount/i), { target: { value: "1.9999999" } });

    expect(screen.getByText(/More decimal places than/i)).toBeTruthy();
  });

  it("flags a counterparty that is not a Solana address", () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/counterparty address/i), {
      target: { value: "nope" },
    });

    expect(screen.getByText(/does not look like a Solana address/i)).toBeTruthy();
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

  // Both sides are on screen at once, because choosing one reverses the
  // direction of everything else on the form.
  it("offers both sides of the trade as a choice", () => {
    renderForm();

    expect(screen.getByText(/you deliver the asset/i)).toBeTruthy();
    expect(screen.getByText(/you deliver the cash/i)).toBeTruthy();
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

  /**
   * Flipping the direction changes which leg you fund, and the two cards were
   * written for one direction only: the cash card stayed captioned as the
   * counterparty's even when you were the one funding it. The moving balance
   * was the only signal, and a balance is a hint, not a label.
   */
  describe("which leg is whose", () => {
    it("marks the asset leg as yours by default", () => {
      const { container } = renderForm();

      expect(container.textContent).toContain("You deliver");
      expect(container.textContent).toContain("They deliver");
    });

    it("does not tell you the other side pays the cash when you do", () => {
      const { container } = renderForm();

      fireEvent.click(screen.getByLabelText(/you deliver the cash/i));

      expect(container.textContent).toContain("What you pay with");
      expect(container.textContent).not.toContain("What the other side pays with");
    });
  });
});

// @vitest-environment jsdom

import type { RampProviderEstimateResult } from "@sdp/types/payments";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ProviderQuoteCard } from "./provider-card.redesign";

vi.mock("next/image", () => ({ default: () => null }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

afterEach(cleanup);

const moonpay = { id: "moonpay", title: "MoonPay" } as const;

describe("ProviderQuoteCard", () => {
  it("explains a failed quote without relaying the provider's own error text", () => {
    const estimate: RampProviderEstimateResult = {
      provider: "moonpay",
      status: "error",
      error: "Request failed with status 502",
    };
    render(
      <ProviderQuoteCard
        name="provider"
        option={moonpay}
        active={false}
        estimate={estimate}
        onSelect={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      screen.getByText("The provider did not return a quote. Try another amount or provider.")
    ).toBeTruthy();
    expect(screen.queryByText("Request failed with status 502")).toBeNull();
  });

  it("names the minimum when the amount is below what the provider takes", () => {
    const estimate: RampProviderEstimateResult = {
      provider: "moonpay",
      status: "error",
      error: "Amount is below the minimum",
      reason: "amount_below_minimum",
      limit: { amount: "19.92405", currency: "USDC" },
    };
    render(
      <ProviderQuoteCard
        name="provider"
        option={moonpay}
        active={false}
        estimate={estimate}
        onSelect={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByText("Minimum is 19.92405 USDC")).toBeTruthy();
  });

  it("shows a payout's rate beside its fee, so the figures add up", () => {
    const estimate: RampProviderEstimateResult = {
      provider: "moonpay",
      status: "ok",
      estimate: {
        provider: "moonpay",
        direction: "offramp",
        fiatCurrency: "USD",
        assetRail: "usdc.solana",
        fiatAmount: "22.95",
        cryptoAmount: "25",
        exchangeRate: "0.998",
        fees: { currency: "USD", total: "2" },
      },
    };
    render(
      <ProviderQuoteCard
        name="provider"
        option={moonpay}
        active={false}
        estimate={estimate}
        onSelect={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByText(/1 USDC = 0\.998 USD/)).toBeTruthy();
  });

  it("asks for an amount before any quote exists", () => {
    render(
      <ProviderQuoteCard name="provider" option={moonpay} active={false} onSelect={vi.fn()} />,
      {
        wrapper,
      }
    );

    expect(screen.getByText("Enter an amount to see a quote")).toBeTruthy();
  });
});

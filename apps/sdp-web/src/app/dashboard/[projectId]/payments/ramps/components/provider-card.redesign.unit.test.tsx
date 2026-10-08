// @vitest-environment jsdom

import type { RampProviderEstimateResult } from "@sdp/types";
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

const bvnk = { id: "bvnk", title: "BVNK" } as const;

describe("ProviderQuoteCard", () => {
  it("explains a failed quote without relaying the provider's own error text", () => {
    const estimate: RampProviderEstimateResult = {
      provider: "bvnk",
      status: "error",
      error: "Request failed with status 502",
    };
    render(
      <ProviderQuoteCard
        name="provider"
        option={bvnk}
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

  it("asks for an amount before any quote exists", () => {
    render(<ProviderQuoteCard name="provider" option={bvnk} active={false} onSelect={vi.fn()} />, {
      wrapper,
    });

    expect(screen.getByText("Enter an amount to see a quote")).toBeTruthy();
  });
});

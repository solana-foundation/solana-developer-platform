// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { ClassifyStep } from "./draft-flow-steps.redesign";
import type { DraftState } from "./draft-model";

const messages = getMessages("en");

const stablecoinDraft: DraftState = {
  assetClass: "stablecoin",
  name: "Treasury Fund",
  symbol: "",
  description: "",
  website: "",
  maxSupply: "",
  decimals: "6",
  allowlist: false,
  pauseTransfers: true,
  interestBearing: false,
  interestRate: "500",
  transferFee: false,
  transferFeeBasisPoints: "50",
  transferFeeMax: "100",
  issuerName: "",
  freezeAccounts: true,
  permanentDelegate: false,
  authorities: {
    "mint-authority": "wallet-a",
    "metadata-authority": "wallet-a",
    "freeze-authority": "wallet-a",
    "permanent-delegate": "wallet-a",
  },
};

describe("ClassifyStep", () => {
  it("drops a stablecoin's controls when the draft becomes another kind of token", () => {
    const update = vi.fn();
    render(
      <I18nProvider locale="en" messages={messages}>
        <ClassifyStep draft={stablecoinDraft} update={update} />
      </I18nProvider>
    );
    const [, digital] = screen.getAllByRole("radio");
    fireEvent.click(digital as HTMLElement);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        assetClass: "digital-asset",
        decimals: "9",
        pauseTransfers: false,
        freezeAccounts: false,
        permanentDelegate: false,
      })
    );
  });
});

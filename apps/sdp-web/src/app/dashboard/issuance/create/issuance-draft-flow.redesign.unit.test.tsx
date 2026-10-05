// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import { IssuanceDraftFlow } from "./issuance-draft-flow.redesign";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: "sandbox" }),
}));
vi.mock("./actions", () => ({ saveIssuanceDraft: vi.fn() }));

const messages = getMessages("en");
const wallets = [
  {
    id: "wallet-treasury",
    label: "Treasury",
    address: "Treasury1111111111111111111111111111111111",
  },
] as unknown as PaymentsDashboardWallet[];

function renderFlow(demo: boolean) {
  return render(
    <I18nProvider locale="en" messages={messages}>
      <PaymentsDemoProvider value={demo}>
        <IssuanceDraftFlow wallets={wallets} walletsError={null} resumeId={null} />
      </PaymentsDemoProvider>
    </I18nProvider>
  );
}

const draftText = messages.DashboardIssuance.newDesign.draft;

describe("IssuanceDraftFlow in demo mode", () => {
  it("opens every step filled in, so Continue alone reaches Create draft", () => {
    renderFlow(true);
    expect(screen.getByDisplayValue("Harbor Dollar")).toBeTruthy();

    for (let step = 0; step < 4; step += 1) {
      const next = screen.getByRole("button", { name: draftText.continue });
      expect((next as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(next);
    }
    const create = screen.getByRole("button", { name: draftText.createDraft });
    expect((create as HTMLButtonElement).disabled).toBe(false);
  });

  it("starts empty outside demo mode", () => {
    renderFlow(false);
    expect(screen.queryByDisplayValue("Harbor Dollar")).toBeNull();
    const next = screen.getByRole("button", { name: draftText.continue });
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });
});

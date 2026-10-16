// @vitest-environment jsdom

import type { CounterpartyAccount } from "@sdp/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { ComplianceSnapshot } from "../payments-workspace.types";
import { NewSolanaAddressForm } from "./new-solana-address-form";

const screening = vi.hoisted(() => ({ next: null as ComplianceSnapshot | null }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../payments-workspace.data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../payments-workspace.data")>()),
  runComplianceCheck: vi.fn(async () => screening.next),
}));

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function snapshot(riskScore: number): ComplianceSnapshot {
  return {
    address: ADDRESS,
    checkedAt: "2026-09-25T00:00:00.000Z",
    providers: [
      { provider: "range", status: "ok", riskScore, evaluatedAt: "2026-09-25T00:00:00.000Z" },
    ],
  };
}

const account = { id: "cpa_new", accountKind: "crypto_wallet" } as CounterpartyAccount;

function renderForm() {
  const onAdded = vi.fn();
  const onCancel = vi.fn();
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    writes.push(JSON.parse(String(init?.body)));
    return Response.json({ data: { account } });
  });
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <NewSolanaAddressForm
        counterpartyId="cpty_jane"
        idPrefix="test-add"
        onAdded={onAdded}
        onCancel={onCancel}
      />
    </I18nProvider>
  );
  return { onAdded, onCancel, writes, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  screening.next = null;
});

describe("NewSolanaAddressForm", () => {
  it("says so when the text is not a Solana address, without screening it", async () => {
    const { user, writes } = renderForm();
    await user.type(screen.getByLabelText("Address"), "not-an-address");
    await user.click(screen.getByRole("button", { name: "Screen and add" }));

    expect(screen.getByText("Enter a valid Solana address.")).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it("saves a cleanly screened address straight away", async () => {
    screening.next = snapshot(1);
    const { user, writes, onAdded } = renderForm();
    await user.type(screen.getByLabelText("Label"), "Ops wallet");
    await user.type(screen.getByLabelText("Address"), ADDRESS);
    await user.click(screen.getByRole("button", { name: "Screen and add" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(account));
    expect(writes).toEqual([
      {
        accountKind: "crypto_wallet",
        label: "Ops wallet",
        details: { network: "solana", address: ADDRESS },
      },
    ]);
  });

  it("stops on a flag and leaves the choice: add anyway or do not", async () => {
    screening.next = snapshot(9);
    const { user, writes, onAdded, onCancel } = renderForm();
    await user.type(screen.getByLabelText("Address"), ADDRESS);
    await user.click(screen.getByRole("button", { name: "Screen and add" }));

    expect(
      await screen.findByText(
        "One or more checks flagged this wallet or couldn't be completed. Add it anyway?"
      )
    ).toBeTruthy();
    expect(writes).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Do not add" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Add anyway" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(account));
    expect(writes).toHaveLength(1);
  });
});

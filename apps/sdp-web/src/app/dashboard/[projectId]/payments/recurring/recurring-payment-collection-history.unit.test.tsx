// @vitest-environment jsdom

import type { PaymentSubscriptionCollectionAttempt } from "@sdp/types/payments";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RecurringPaymentRunHistory } from "./recurring-payment-collection-history";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: "sandbox" }),
}));

const MINT_BEFORE_EDIT = "MintBeforeEdit1111111111111111111111111111";
const MINT_AFTER_EDIT = "MintAfterEdit11111111111111111111111111111";
const TOKEN_LABELS: Record<string, string> = {
  [MINT_BEFORE_EDIT]: "USDC",
  [MINT_AFTER_EDIT]: "PYUSD",
};

function collectionAttempt(
  id: string,
  token: string,
  amount: string
): PaymentSubscriptionCollectionAttempt {
  return {
    id,
    organizationId: "org_test",
    projectId: "prj_test",
    subscriptionId: "sub_test",
    transferId: null,
    token,
    amount,
    dueAt: "2026-01-01T00:00:00.000Z",
    attemptedAt: null,
    status: "pending",
    signature: null,
    error: null,
    metadata: { source: "automated", recurringPaymentId: "rp_test", initiatedByKeyId: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("RecurringPaymentRunHistory", () => {
  it("labels each run with its own token, across an edit that changed the token", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <RecurringPaymentRunHistory
          attempts={[
            collectionAttempt("psca_after_edit", MINT_AFTER_EDIT, "25.5"),
            collectionAttempt("psca_before_edit", MINT_BEFORE_EDIT, "10"),
          ]}
          tokenLabelForMint={(mint) => TOKEN_LABELS[mint]}
          pendingActivation={false}
        />
      </I18nProvider>
    );

    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[2].textContent)
    ).toEqual(["25.50 PYUSD", "10.00 USDC"]);
  });
});

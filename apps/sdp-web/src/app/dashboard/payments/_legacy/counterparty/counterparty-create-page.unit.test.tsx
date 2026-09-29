import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createdCounterparty: null as { id: string; displayName: string } | null,
  push: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("./counterparty-create-context", () => ({
  CounterpartyCreateProvider: ({ children }: { children: ReactNode }) => children,
  useCounterpartyCreate: () => ({
    submit: mocks.submit,
    submitting: false,
    submitError: null,
    createdCounterparty: mocks.createdCounterparty,
  }),
}));

import { CounterpartyCreateDialog } from "./counterparty-create-dialog";
import { CounterpartyCreatePage } from "./counterparty-create-page";
import { CryptoAccountsPhase } from "./crypto-accounts-phase";

type ActionElement = ReactElement<{ onClick: () => void }>;
type FooterElement = ReactElement<{ children: [ActionElement, ActionElement] }>;

function embeddedFooter(onCancel?: () => void): FooterElement {
  const page = CounterpartyCreatePage({ embedded: true, onCancel }) as ReactElement<{
    children: [ReactElement, ReactElement, FooterElement];
  }>;
  return page.props.children[2];
}

beforeEach(() => {
  mocks.createdCounterparty = null;
  mocks.push.mockReset();
  mocks.submit.mockReset();
});

describe("counterparty create flow", () => {
  it("cancels through the injected action when embedded", () => {
    const onCancel = vi.fn();

    embeddedFooter(onCancel).props.children[0].props.onClick();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("submits directly from the footer with no review step", () => {
    embeddedFooter(vi.fn()).props.children[1].props.onClick();

    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it("returns the standalone page to the counterparty directory on cancel", () => {
    const frame = CounterpartyCreatePage({}) as ReactElement<{ footer: FooterElement }>;

    frame.props.footer.props.children[0].props.onClick();

    expect(mocks.push).toHaveBeenCalledWith("/dashboard/payments/counterparty");
  });

  it("passes the dialog close action through the create page", () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const dialog = CounterpartyCreateDialog({ open: true, onClose, onCreated }) as ReactElement<{
      children: ReactElement<{ children: ReactElement<{ children: ReactElement }> }>;
    }>;
    const provider = dialog.props.children.props.children;
    const page = provider.props.children as ReactElement<{
      embedded?: boolean;
      onCancel?: () => void;
    }>;

    expect(page.type).toBe(CounterpartyCreatePage);
    expect(page.props.embedded).toBe(true);
    expect(page.props.onCancel).toBe(onClose);
  });

  it("uses the standalone optional-account layout after page creation", () => {
    mocks.createdCounterparty = { id: "cp_123", displayName: "Northstar Labs" };

    const phase = CounterpartyCreatePage({}) as ReactElement<{
      embedded: boolean;
      steps: readonly { label: string; title: string }[];
    }>;

    expect(phase.type).toBe(CryptoAccountsPhase);
    expect(phase.props.embedded).toBe(false);
    expect(phase.props.steps.map((step) => step.label)).toEqual([
      "DashboardPayments.counterparty.basics",
      "DashboardPayments.counterparty.cryptoWallet",
    ]);
  });

  it("preserves the embedded optional-account layout inside the dialog", () => {
    mocks.createdCounterparty = { id: "cp_123", displayName: "Northstar Labs" };

    const phase = CounterpartyCreatePage({ embedded: true, onCancel: vi.fn() }) as ReactElement<{
      embedded: boolean;
    }>;

    expect(phase.type).toBe(CryptoAccountsPhase);
    expect(phase.props.embedded).toBe(true);
  });
});

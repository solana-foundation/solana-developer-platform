import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  step: 0,
  createdCounterparty: null as { id: string; displayName: string } | null,
  push: vi.fn(),
  goNext: vi.fn(),
  goBack: vi.fn(),
  submit: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/use-dashboard-router", () => ({
  useDashboardRouter: () => ({ push: mocks.push }),
}));

vi.mock("../counterparty-create-context", () => ({
  CounterpartyCreateProvider: ({ children }: { children: ReactNode }) => children,
  useCounterpartyCreate: () => ({
    step: mocks.step,
    steps: ["basics", "identity", "address", "review"],
    currentStepId: mocks.step === 0 ? "basics" : "identity",
    direction: 1,
    createdCounterparty: mocks.createdCounterparty,
    goNext: mocks.goNext,
    goBack: mocks.goBack,
    submit: mocks.submit,
    submitting: false,
    finish: mocks.finish,
  }),
}));

import { CounterpartyCreateDialog } from "../counterparty-create-dialog";
import { CounterpartyCreatePage } from "../counterparty-create-page";
import { CryptoAccountsPhase } from "../crypto-accounts-phase";
import { StepFooter } from "./step-footer";

type ActionElement = ReactElement<{ onClick: () => void }>;

function secondaryAction(onCancel?: () => void): ActionElement {
  const footer = StepFooter({ onCancel }) as ReactElement<{
    children: [ActionElement, ReactElement];
  }>;
  return footer.props.children[0];
}

beforeEach(() => {
  mocks.step = 0;
  mocks.createdCounterparty = null;
  mocks.push.mockReset();
  mocks.goNext.mockReset();
  mocks.goBack.mockReset();
  mocks.submit.mockReset();
  mocks.finish.mockReset();
});

describe("counterparty create cancel behavior", () => {
  it("uses the injected cancel action on the first step", () => {
    const onCancel = vi.fn();

    secondaryAction(onCancel).props.onClick();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("returns a standalone create page to the counterparty directory", () => {
    secondaryAction().props.onClick();

    expect(mocks.push).toHaveBeenCalledWith("/dashboard/payments/counterparty");
  });

  it("keeps Back behavior after the first step", () => {
    const onCancel = vi.fn();
    mocks.step = 1;

    secondaryAction(onCancel).props.onClick();

    expect(mocks.goBack).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("passes the dialog close action through the create page to the footer", () => {
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

    const frame = CounterpartyCreatePage({ onCancel: page.props.onCancel }) as ReactElement<{
      footer: ReactElement<{ onCancel?: () => void }>;
    }>;
    expect(frame.props.footer.type).toBe(StepFooter);
    expect(frame.props.footer.props.onCancel).toBe(onClose);
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
      "DashboardPayments.counterparty.personal",
      "DashboardPayments.counterparty.address",
      "DashboardPayments.counterparty.review",
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

import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flaggedAddress: null as { message: string } | null,
  submitting: false,
  push: vi.fn(),
  submit: vi.fn(),
  attachFlaggedAddress: vi.fn(),
  skipFlaggedAddress: vi.fn(),
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
    basics: { values: {}, errors: {}, setField: vi.fn() },
    submit: mocks.submit,
    submitting: mocks.submitting,
    submitError: null,
    flaggedAddress: mocks.flaggedAddress,
    attachFlaggedAddress: mocks.attachFlaggedAddress,
    skipFlaggedAddress: mocks.skipFlaggedAddress,
  }),
}));

import { CounterpartyCreateDialog } from "./counterparty-create-dialog";
import { CounterpartyCreatePage } from "./counterparty-create-page";

type ActionElement = ReactElement<{ onClick: () => void; disabled: boolean }>;
type FooterElement = ReactElement<{ children: [ActionElement, ActionElement] }>;
type ContentElement = ReactElement<{ children: [ReactElement, ReactElement] }>;

function embeddedFooter(onCancel?: () => void): FooterElement {
  const page = CounterpartyCreatePage({ embedded: true, onCancel }) as ReactElement<{
    children: [ReactElement, ContentElement, FooterElement];
  }>;
  return page.props.children[2];
}

function standalonePage() {
  return CounterpartyCreatePage({}) as ReactElement<{
    footer: FooterElement;
    children: ContentElement;
  }>;
}

/** The flagged-address dialog's rendered modal, from the page's content. */
function flaggedDialog(content: ContentElement) {
  const dialog = content.props.children[1] as ReactElement<Record<string, never>> & {
    type: (props: Record<string, never>) => ReactElement<{
      isOpen: boolean;
      children: ReactElement<{
        children: [ReactElement, ReactElement<{ children: ActionElement[] }>];
      }>;
    }>;
  };
  return dialog.type({});
}

beforeEach(() => {
  mocks.flaggedAddress = null;
  mocks.submitting = false;
  mocks.push.mockReset();
  mocks.submit.mockReset();
  mocks.attachFlaggedAddress.mockReset();
  mocks.skipFlaggedAddress.mockReset();
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
    standalonePage().props.footer.props.children[0].props.onClick();

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

  it("keeps the flagged-address dialog closed until the screening flags one", () => {
    const modal = flaggedDialog(standalonePage().props.children);

    expect(modal.props.isOpen).toBe(false);
  });

  it("holds the form and offers Add anyway or Skip while an address is flagged", () => {
    mocks.flaggedAddress = { message: "flagged" };
    const page = standalonePage();

    // The contact already exists: a second submit would create it again.
    expect(page.props.footer.props.children[1].props.disabled).toBe(true);

    const modal = flaggedDialog(page.props.children);
    expect(modal.props.isOpen).toBe(true);
    const [skip, addAnyway] = modal.props.children.props.children[1].props.children;
    skip.props.onClick();
    addAnyway.props.onClick();
    expect(mocks.skipFlaggedAddress).toHaveBeenCalledOnce();
    expect(mocks.attachFlaggedAddress).toHaveBeenCalledOnce();
  });
});

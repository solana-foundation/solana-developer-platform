// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { TokenOperations } from "../asset-profile/use-token-operations";
import { FreezeAccountForm, PauseTransfersForm } from "./transfer-operation-forms";

const messages = getMessages("en");
const copy = messages.DashboardIssuance.newDesign.operations;
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function makeOps(accountAddress = "") {
  return {
    isPending: false,
    handlePause: vi.fn(),
    handleFreeze: vi.fn(),
    freezeForm: { accountAddress, reason: "", signingWalletId: "" },
    setFreezeForm: vi.fn(),
  } as unknown as TokenOperations;
}

function renderWith(node: React.ReactNode) {
  render(
    <I18nProvider locale="en" messages={messages}>
      {node}
    </I18nProvider>
  );
}

describe("PauseTransfersForm", () => {
  afterEach(cleanup);

  it("pauses in place, with no second confirmation", () => {
    const ops = makeOps();
    const onClose = vi.fn();
    renderWith(<PauseTransfersForm ops={ops} paused={false} onClose={onClose} />);
    expect(screen.getByText(copy.pauseWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: copy.pauseTitle }));
    expect(ops.handlePause).toHaveBeenCalledWith(true, { confirmed: true });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("resumes a paused token", () => {
    const ops = makeOps();
    renderWith(<PauseTransfersForm ops={ops} paused onClose={vi.fn()} />);
    expect(screen.getByText(copy.resumeWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: copy.resumeTitle }));
    expect(ops.handlePause).toHaveBeenCalledWith(false, { confirmed: true });
  });
});

describe("FreezeAccountForm", () => {
  afterEach(cleanup);

  it("waits for an address", () => {
    renderWith(<FreezeAccountForm ops={makeOps()} onClose={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: copy.freezeSubmit }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("hands a valid address to the freeze, which confirms in its dialog", () => {
    const ops = makeOps(ADDRESS);
    const onClose = vi.fn();
    renderWith(<FreezeAccountForm ops={ops} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: copy.freezeSubmit }));
    expect(ops.handleFreeze).toHaveBeenCalledWith(false);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

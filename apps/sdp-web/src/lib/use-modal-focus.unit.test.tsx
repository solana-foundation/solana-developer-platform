// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./use-modal-focus";

interface FocusHarnessProps {
  scope: "program" | "strategy";
  scopeId: string;
  panelKey?: string;
  restoreTiming?: "immediate" | "animation-frame";
}

function FocusHarness({ scope, scopeId, panelKey = "form", restoreTiming }: FocusHarnessProps) {
  const contentRef = useModalFocus({
    focusKey: panelKey,
    initialFocusSelector: "[data-modal-focus-target]",
    fallbackAttribute:
      scope === "program"
        ? "data-earn-withdraw-focus-fallback"
        : "data-earn-vault-deposit-focus-fallback",
    fallbackValue: scopeId,
    restoreTiming,
    contentDataKey: "panel",
  });

  return (
    <div role="dialog" aria-label="Earn focus harness">
      <div ref={contentRef} data-testid="content" tabIndex={-1}>
        <button type="button" data-modal-focus-target>
          First
        </button>
        <button type="button">Last</button>
      </div>
    </div>
  );
}

function appendButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  document.body.append(button);
  return button;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useModalFocus", () => {
  it("focuses each panel target and contains forward and reverse Tab navigation", async () => {
    const view = render(<FocusHarness scope="strategy" scopeId="strategy_1" />);
    const first = view.getByRole("button", { name: "First" });
    const last = view.getByRole("button", { name: "Last" });

    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(view.getByTestId("content").dataset.panel).toBe("form");

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    view.getByTestId("content").focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    view.rerender(
      <FocusHarness scope="strategy" scopeId="strategy_1" panelKey="outcome:deposit" />
    );
    await waitFor(() => {
      expect(view.getByTestId("content").dataset.panel).toBe("outcome:deposit");
      expect(document.activeElement).toBe(first);
    });
  });

  it("restores a strategy modal to its connected trigger immediately", async () => {
    const trigger = appendButton("Open strategy");
    trigger.focus();
    const view = render(<FocusHarness scope="strategy" scopeId="strategy_1" />);

    await waitFor(() => expect(document.activeElement?.textContent).toBe("First"));
    view.unmount();

    expect(document.activeElement).toBe(trigger);
  });

  it("restores a strategy modal to its scoped fallback immediately", async () => {
    const removedTrigger = appendButton("Removed strategy trigger");
    removedTrigger.focus();
    const view = render(<FocusHarness scope="strategy" scopeId="strategy_1" />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("First"));

    removedTrigger.remove();
    const fallback = appendButton("Strategy fallback");
    fallback.setAttribute("data-earn-vault-deposit-focus-fallback", "strategy_1");
    view.unmount();

    expect(document.activeElement).toBe(fallback);
  });

  it("restores a program modal to its scoped fallback on the next frame", async () => {
    const removedTrigger = appendButton("Removed trigger");
    removedTrigger.focus();
    const view = render(
      <FocusHarness
        scope="program"
        scopeId={'program_"with-special-characters"'}
        restoreTiming="animation-frame"
      />
    );
    await waitFor(() => expect(document.activeElement?.textContent).toBe("First"));

    removedTrigger.remove();
    const wrongProgram = appendButton("Wrong program");
    wrongProgram.setAttribute("data-earn-withdraw-focus-fallback", "program_other");
    const fallback = appendButton("Program fallback");
    fallback.setAttribute("data-earn-withdraw-focus-fallback", 'program_"with-special-characters"');
    view.unmount();

    await waitFor(() => expect(document.activeElement).toBe(fallback));
  });

  it("leaves Escape unconsumed for the common Modal close handler", async () => {
    const view = render(<FocusHarness scope="strategy" scopeId="strategy_1" />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("First"));
    const downstreamListener = vi.fn();
    document.addEventListener("keydown", downstreamListener);

    expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(true);
    expect(downstreamListener).toHaveBeenCalledOnce();

    document.removeEventListener("keydown", downstreamListener);
    view.unmount();
  });
});

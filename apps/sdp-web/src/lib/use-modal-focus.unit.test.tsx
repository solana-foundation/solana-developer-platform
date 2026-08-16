// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./use-modal-focus";

type Panel = "wallet" | "amount" | "result";

function Dialog({ onClose }: { onClose: () => void }) {
  const [panel, setPanel] = useState<Panel>("wallet");
  const contentRef = useModalFocus<HTMLDivElement>("vault-one", panel);

  return (
    <div aria-label="Deposit" role="dialog">
      <div data-modal-focus-panel={panel} ref={contentRef}>
        {panel === "wallet" ? (
          <>
            <h2 data-modal-focus-heading tabIndex={-1}>
              Choose wallet
            </h2>
            <input aria-label="Treasury wallet" type="radio" />
            <button onClick={() => setPanel("amount")} type="button">
              Continue
            </button>
          </>
        ) : null}
        {panel === "amount" ? (
          <>
            <h2 data-modal-focus-heading tabIndex={-1}>
              Enter amount
            </h2>
            <input aria-label="Amount" />
            <button onClick={() => setPanel("result")} type="button">
              Submit
            </button>
          </>
        ) : null}
        {panel === "result" ? (
          <>
            <h2 data-modal-focus-heading tabIndex={-1}>
              Deposit submitted
            </h2>
            <button onClick={onClose} type="button">
              Done
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-modal-focus-fallback="vault-one" onClick={() => setOpen(true)} type="button">
        Open deposit
      </button>
      {open ? <Dialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    window.clearTimeout(frame);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useModalFocus", () => {
  it("focuses each replacement panel and returns focus when the modal closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Open deposit" });
    await user.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("radio")));

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox")));

    await user.click(screen.getByRole("button", { name: "Submit" }));
    const resultHeading = screen.getByRole("heading", { name: "Deposit submitted" });
    await waitFor(() => expect(document.activeElement).toBe(resultHeading));

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("recovers focus into the dialog when it has escaped", async () => {
    render(
      <>
        <button type="button">Outside</button>
        <Dialog onClose={() => {}} />
      </>
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("radio")));

    screen.getByRole("button", { name: "Outside" }).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("radio"));

    screen.getByRole("button", { name: "Outside" }).focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
  });
});

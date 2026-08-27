import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HoldToConfirmButton } from "./hold-to-confirm-button";

// Static contract of the destructive-approval gate. The hold timing itself (rAF fill,
// early-release cancel, disabled-mid-hold bail) is interactive and covered by the
// manual verification pass; these assertions pin the accessibility surface.
describe("HoldToConfirmButton", () => {
  function render(disabled = false) {
    return renderToStaticMarkup(
      <HoldToConfirmButton
        label="Hold to approve"
        holdingLabel="Keep holding…"
        disabled={disabled}
        onConfirm={() => {}}
      />
    );
  }

  it("renders a labelled button with progressbar semantics at 0%", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Hold to approve"');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('type="button"');
  });

  it("suppresses touch scrolling and text selection during holds", () => {
    const markup = render();
    expect(markup).toContain("touch-none");
    expect(markup).toContain("select-none");
  });

  it("respects disabled", () => {
    expect(render(true)).toContain("disabled");
  });

  it("includes a polite live region for screen-reader hold announcements", () => {
    expect(render()).toContain('aria-live="polite"');
  });

  it("reserves room for both labels so a hold cannot resize the button", () => {
    // Swapping the text outright grew the button mid-press, which tipped the
    // surrounding flex-wrap and dropped the whole row of controls onto a
    // second line while the reader was holding one of them.
    const markup = render();
    expect(markup).toContain("Hold to approve");
    expect(markup).toContain("Keep holding…");
    // Stacked in one grid cell, so the width is the wider of the two whatever
    // state it is in.
    expect(markup).toContain("col-start-1 row-start-1");
  });
});

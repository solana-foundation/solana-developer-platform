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
});

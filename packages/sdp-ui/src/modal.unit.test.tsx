// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./modal";
import { EnglishUiI18nProvider } from "./testing/english-ui-i18n";

afterEach(cleanup);

function renderModal(props: Partial<Parameters<typeof Modal>[0]> = {}) {
  render(
    <EnglishUiI18nProvider>
      <Modal ariaLabel="Deposit" isOpen {...props}>
        <p>Body</p>
      </Modal>
    </EnglishUiI18nProvider>
  );
  // The dialog's wrapper is what places it in the viewport.
  return screen.getByRole("dialog").parentElement;
}

describe("Modal placement", () => {
  it("centres the dialog by default", () => {
    const wrapper = renderModal();

    expect(wrapper?.className).toContain("items-center");
    expect(wrapper?.className).not.toContain("items-start");
  });

  it("pins the dialog's top edge when a flow asks for it", () => {
    // A multi-step flow changes height at each step; a centred dialog would move its header.
    const wrapper = renderModal({ placement: "top" });

    expect(wrapper?.className).toContain("items-start");
    expect(wrapper?.className).not.toContain("items-center");
  });
});

describe("Modal entrance", () => {
  const animate = vi.fn<Element["animate"]>();
  let reducedMotion = false;
  // The handoff rule reads the clock, so each case starts well clear of the last one's close.
  let clock = 0;

  beforeEach(() => {
    animate.mockClear();
    reducedMotion = false;
    clock += 60_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    // jsdom implements neither Web Animations nor matchMedia.
    Element.prototype.animate = animate;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
      media: query,
    }));
  });

  afterEach(() => {
    // Unmounted under the mocked clock, so the close it records stays in this case's time.
    cleanup();
    Reflect.deleteProperty(Element.prototype, "animate");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function entrances() {
    return animate.mock.contexts.map((element, call) => ({
      element,
      keyframes: animate.mock.calls[call]?.[0],
    }));
  }

  function dialogTree(name: string | null) {
    return (
      <EnglishUiI18nProvider>
        {name === null ? null : (
          <Modal key={name} ariaLabel={name} isOpen>
            <p>{name}</p>
          </Modal>
        )}
      </EnglishUiI18nProvider>
    );
  }

  it("fades the backdrop in and scales the dialog up as it opens", () => {
    const backdrop = renderModal()?.parentElement;

    expect(entrances()).toEqual([
      { element: backdrop, keyframes: [{ opacity: 0 }, { opacity: 1 }] },
      {
        element: screen.getByRole("dialog"),
        keyframes: [{ transform: "scale(0.97)" }, { transform: "none" }],
      },
    ]);
  });

  it("opens without motion for a viewer who asks for reduced motion", () => {
    reducedMotion = true;
    renderModal();

    expect(animate).not.toHaveBeenCalled();
  });

  it("opens in place when it takes over from a dialog that closes in the same update", () => {
    // A loading dialog swapped for the real one as its lazy chunk lands.
    const { rerender } = render(dialogTree("Loading"));
    animate.mockClear();

    rerender(dialogTree("Deposit"));

    expect(screen.getByRole("dialog", { name: "Deposit" })).toBeTruthy();
    expect(animate).not.toHaveBeenCalled();
  });

  it("enters again once the last dialog has been closed a while", () => {
    const { rerender } = render(dialogTree("Loading"));
    rerender(dialogTree(null));
    animate.mockClear();
    clock += 500;

    rerender(dialogTree("Deposit"));

    expect(animate).toHaveBeenCalledTimes(2);
  });
});

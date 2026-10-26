// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

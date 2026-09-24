// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/contexts/theme-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { HomepageGlobe } from "./homepage-globe";
import type { GlobeOptions } from "./scenes/globe/mount-globe";
import "@/test/match-media";

const scene = vi.hoisted(() => ({
  dispose: vi.fn(),
  options: null as GlobeOptions | null,
  webgl: true,
}));

vi.mock("motion/react", () => ({
  useInView: () => true,
  useReducedMotion: () => false,
}));

vi.mock("./scenes/globe/load-globe", () => ({
  loadGlobe: async () => ({
    mountGlobe: (_host: HTMLElement, options: GlobeOptions) => {
      scene.options = options;
      return scene.webgl ? scene.dispose : null;
    },
  }),
}));

afterEach(() => {
  cleanup();
  scene.dispose.mockReset();
  scene.options = null;
  scene.webgl = true;
});

function renderGlobe(withTags = true) {
  return render(
    <ThemeProvider>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <HomepageGlobe withTags={withTags} />
      </I18nProvider>
    </ThemeProvider>
  );
}

describe("HomepageGlobe", () => {
  it("describes the illustration to assistive technology", () => {
    renderGlobe();

    expect(
      screen.getByRole("img", {
        name: "Payments crossing the network, confirmed in under a second",
      })
    ).toBeTruthy();
  });

  it("mounts the scene on the theme's paper ground and labels the current payment", async () => {
    const { container } = renderGlobe();
    await waitFor(() => expect(scene.options).not.toBeNull());

    expect(scene.options?.ground).toBe("paper");
    expect(scene.options?.reducedMotion).toBe(false);

    act(() => scene.options?.tags?.onArcChange({ from: "fra", to: "sin", amountIndex: 0 }));

    expect(container.textContent).toContain("12,500.00 USDC");
    expect(container.textContent).toContain("from Frankfurt");
    expect(container.textContent).toContain("Confirmed");
    expect(container.textContent).toContain("Singapore · under a second");
  });

  it("does not pass tag elements when tags are off", async () => {
    renderGlobe(false);
    await waitFor(() => expect(scene.options).not.toBeNull());

    expect(scene.options?.tags).toBeUndefined();
  });

  it("hides itself when WebGL is unavailable", async () => {
    scene.webgl = false;
    renderGlobe();

    await waitFor(() => expect(screen.getByRole("img").getAttribute("data-failed")).toBe("true"));
  });

  it("disposes the scene on unmount", async () => {
    const { unmount } = renderGlobe();
    await waitFor(() => expect(scene.options).not.toBeNull());

    unmount();

    expect(scene.dispose).toHaveBeenCalledTimes(1);
  });
});

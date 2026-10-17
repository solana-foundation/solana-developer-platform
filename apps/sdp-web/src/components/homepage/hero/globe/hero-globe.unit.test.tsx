// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";

const mocks = vi.hoisted(() => ({
  reduced: false,
  webgl: true,
  createGlobeScene: vi.fn(),
  drawStaticGlobe: vi.fn(() => true),
}));

function t(key: MessageKey, values?: TranslationValues) {
  return translate(getMessages("en"), key, values);
}

vi.mock("@/i18n/provider", () => ({ useTranslations: () => t }));
vi.mock("@/lib/webgl", () => ({ supportsWebGL: () => mocks.webgl }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => mocks.reduced,
}));
vi.mock("./scene", () => ({ createGlobeScene: mocks.createGlobeScene }));
vi.mock("./static-globe", () => ({ drawStaticGlobe: mocks.drawStaticGlobe }));

import { HeroGlobe } from "./hero-globe";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

async function renderGlobe() {
  const view = render(<HeroGlobe />);
  /* the dynamic imports settle */
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view.container.querySelector<HTMLElement>('[role="img"]');
}

beforeEach(() => {
  mocks.reduced = false;
  mocks.webgl = true;
  mocks.createGlobeScene.mockReset();
  mocks.drawStaticGlobe.mockClear();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HeroGlobe", () => {
  it("draws the still planet and never loads three.js without WebGL", async () => {
    mocks.webgl = false;
    const globe = await renderGlobe();
    expect(globe?.dataset.mode).toBe("static");
    expect(mocks.createGlobeScene).not.toHaveBeenCalled();
    expect(mocks.drawStaticGlobe).toHaveBeenCalledTimes(1);
  });

  it("falls back to the still planet when the renderer cannot be made", async () => {
    mocks.createGlobeScene.mockReturnValue(null);
    const globe = await renderGlobe();
    expect(mocks.createGlobeScene).toHaveBeenCalledTimes(1);
    expect(globe?.dataset.mode).toBe("static");
  });

  it("runs the live scene, hands it the catalog's tag words, and disposes it on unmount", async () => {
    const scene = { setActive: vi.fn(), dispose: vi.fn() };
    mocks.createGlobeScene.mockReturnValue(scene);
    const globe = await renderGlobe();
    expect(globe?.dataset.mode).toBe("live");
    const options = mocks.createGlobeScene.mock.calls[0][0];
    expect(options.reduced).toBe(false);
    expect(options.labels.from("Lagos")).toBe("from Lagos");
    expect(options.labels.confirmed).toBe("Confirmed");
    expect(options.labels.landed("Lagos")).toBe("Lagos · under a second");
    expect(scene.setActive).toHaveBeenCalledWith(true);
    cleanup();
    expect(scene.dispose).toHaveBeenCalled();
  });

  it("rests while the tab is hidden", async () => {
    const scene = { setActive: vi.fn(), dispose: vi.fn() };
    mocks.createGlobeScene.mockReturnValue(scene);
    await renderGlobe();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scene.setActive).toHaveBeenLastCalledWith(false);
  });

  it("asks the scene for its still, already-landed state under reduced motion", async () => {
    mocks.reduced = true;
    mocks.createGlobeScene.mockReturnValue({ setActive: vi.fn(), dispose: vi.fn() });
    await renderGlobe();
    expect(mocks.createGlobeScene.mock.calls[0][0].reduced).toBe(true);
  });

  it("swaps to the still planet when the WebGL context is lost", async () => {
    const scene = { setActive: vi.fn(), dispose: vi.fn() };
    mocks.createGlobeScene.mockReturnValue(scene);
    const globe = await renderGlobe();
    await act(async () => {
      mocks.createGlobeScene.mock.calls[0][0].onLost();
    });
    expect(scene.dispose).toHaveBeenCalled();
    expect(globe?.dataset.mode).toBe("static");
    /* the lost scene is no longer told when the tab hides */
    scene.setActive.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scene.setActive).not.toHaveBeenCalled();
  });
});

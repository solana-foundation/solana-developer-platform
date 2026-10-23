// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { setReducedMotion, stubMatchMedia } from "@/test/media-queries";
import { setVisibility } from "@/test/visibility";
import { HeroGlobe } from "./hero-globe";
import * as sceneModule from "./scene";
import * as staticGlobeModule from "./static-globe";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

/* the browser's canvas: a WebGL context, or none at all */
function stubWebGL(supported: boolean) {
  // SAFETY: the WebGL probe calls only `getExtension` on the context; every member is a stub that
  // returns null.
  const context = new Proxy({}, { get: () => () => null }) as WebGL2RenderingContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(supported ? context : null);
}

let createGlobeScene: MockInstance<typeof sceneModule.createGlobeScene>;
let drawStaticGlobe: MockInstance<typeof staticGlobeModule.drawStaticGlobe>;

async function renderGlobe() {
  const view = render(<HeroGlobe />, { wrapper: EnglishI18n });
  /* the dynamic imports settle */
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view.container.querySelector<HTMLElement>('[role="img"]');
}

beforeEach(() => {
  stubMatchMedia();
  setReducedMotion(false);
  stubWebGL(true);
  createGlobeScene = vi.spyOn(sceneModule, "createGlobeScene").mockReturnValue(null);
  drawStaticGlobe = vi.spyOn(staticGlobeModule, "drawStaticGlobe").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HeroGlobe", () => {
  it("draws the still planet and never builds the live scene without WebGL", async () => {
    stubWebGL(false);
    const globe = await renderGlobe();
    expect(globe?.dataset.mode).toBe("static");
    expect(createGlobeScene).not.toHaveBeenCalled();
    expect(drawStaticGlobe).toHaveBeenCalledTimes(1);
  });

  it("falls back to the still planet when the renderer cannot be made", async () => {
    createGlobeScene.mockReturnValue(null);
    const globe = await renderGlobe();
    expect(createGlobeScene).toHaveBeenCalledTimes(1);
    expect(globe?.dataset.mode).toBe("static");
  });

  it("runs the live scene, hands it the catalog's tag words, and disposes it on unmount", async () => {
    const scene = { setActive: vi.fn(), dispose: vi.fn() };
    createGlobeScene.mockReturnValue(scene);
    const globe = await renderGlobe();
    expect(globe?.dataset.mode).toBe("live");
    const options = createGlobeScene.mock.calls[0][0];
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
    createGlobeScene.mockReturnValue(scene);
    await renderGlobe();
    setVisibility("hidden");
    expect(scene.setActive).toHaveBeenLastCalledWith(false);
  });

  it("asks the scene for its still, already-landed state under reduced motion", async () => {
    setReducedMotion(true);
    createGlobeScene.mockReturnValue({ setActive: vi.fn(), dispose: vi.fn() });
    await renderGlobe();
    expect(createGlobeScene.mock.calls[0][0].reduced).toBe(true);
  });

  it("swaps to the still planet when the WebGL context is lost", async () => {
    const scene = { setActive: vi.fn(), dispose: vi.fn() };
    createGlobeScene.mockReturnValue(scene);
    const globe = await renderGlobe();
    await act(async () => {
      createGlobeScene.mock.calls[0][0].onLost();
    });
    expect(scene.dispose).toHaveBeenCalled();
    expect(globe?.dataset.mode).toBe("static");
    /* the lost scene is no longer told when the tab hides */
    scene.setActive.mockClear();
    setVisibility("hidden");
    expect(scene.setActive).not.toHaveBeenCalled();
  });
});

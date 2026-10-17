// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";

const mocks = vi.hoisted(() => ({
  reduced: false,
  webgl: true,
  createRingScene: vi.fn(),
}));

function t(key: MessageKey, values?: TranslationValues) {
  return translate(getMessages("en"), key, values);
}

vi.mock("@/i18n/server", () => ({ getTranslations: async () => t }));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => t }));
vi.mock("@/lib/webgl", () => ({ supportsWebGL: () => mocks.webgl }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => mocks.reduced,
}));
vi.mock("./builders/ring-scene", () => ({ createRingScene: mocks.createRingScene }));

import { BuildersStage } from "./builders/builders-stage";
import { FILMS, filmUrl, SERIES_URL } from "./builders/films";
import { cameraAt, cameraDistance, captionOpacity } from "./builders/ring-scene-math";
import { BuildersSection } from "./builders-section";

let observers: FakeIntersectionObserver[] = [];

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[] = [];
  readonly scrollMargin = "";
  constructor(
    readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.rootMargin = options?.rootMargin ?? "";
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  /* every observed element reports `isIntersecting` */
  report(isIntersecting: boolean) {
    const rect = DOMRect.fromRect();
    this.callback(
      [
        {
          isIntersecting,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: null,
          intersectionRatio: isIntersecting ? 1 : 0,
          target: document.body,
          time: 0,
        },
      ],
      this
    );
  }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/* the section comes within a screen of the viewport */
async function nearScreen() {
  const near = observers.find((o) => o.rootMargin === "200px 0px");
  await act(async () => {
    near?.report(true);
  });
  await settle();
}

beforeEach(() => {
  mocks.reduced = false;
  mocks.webgl = true;
  mocks.createRingScene.mockReset();
  observers = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BuildersSection", () => {
  it("is a named night section with the films as links that open YouTube in a new tab", async () => {
    const markup = renderToStaticMarkup(await BuildersSection());
    const root = document.createElement("div");
    root.innerHTML = markup;
    const section = root.querySelector("section");
    expect(section?.id).toBe("builders");
    expect(section?.dataset.ground).toBe("night");
    expect(section?.getAttribute("aria-label")).toBe("Meet the builders");
    expect(root.querySelector("h2 .sr-only")?.textContent).toBe("Meet the builders");
    expect(root.querySelector("h3 .sr-only")?.textContent).toBe("In their own words");

    const links = [...root.querySelectorAll("a")];
    for (const film of FILMS) {
      const link = links.find((a) => a.href === filmUrl(film.id));
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toBe("noreferrer");
      expect(link?.getAttribute("aria-label")).toBe(
        `${film.name}: watch the conversation on YouTube (opens in a new tab)`
      );
    }
    const series = links.filter((a) => a.href === SERIES_URL);
    expect(series.length).toBeGreaterThan(0);
    for (const link of series) {
      expect(link.getAttribute("aria-label")).toContain("opens in a new tab");
    }
  });
});

describe("BuildersStage", () => {
  it("does not fetch the scene before the section nears the screen, then draws it", async () => {
    const dispose = vi.fn();
    mocks.createRingScene.mockReturnValue({ setActive: vi.fn(), dispose });
    const view = render(<BuildersStage />);
    await settle();
    expect(mocks.createRingScene).not.toHaveBeenCalled();

    await nearScreen();
    /* the scene module arrives through a dynamic import */
    await vi.waitFor(() => expect(mocks.createRingScene).toHaveBeenCalledTimes(1));
    await settle();
    expect(mocks.createRingScene.mock.calls[0]?.[0].turns).toBe(1.25);
    const room = view.container.querySelector<HTMLElement>("[data-mode]");
    expect(room?.dataset.mode).toBe("live");
    /* the links stay in the page beside the ring, without stills */
    expect(view.container.querySelectorAll("img")).toHaveLength(0);
    expect(
      view.container.querySelectorAll(`a[href="${filmUrl(FILMS[0].id)}"]`).length
    ).toBeGreaterThan(0);

    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("shows the still grid of films under reduced motion and never loads the scene", async () => {
    mocks.reduced = true;
    const view = render(<BuildersStage />);
    await nearScreen();
    expect(mocks.createRingScene).not.toHaveBeenCalled();
    expect(view.container.querySelector<HTMLElement>("[data-mode]")?.dataset.mode).toBe("still");
    const stills = view.container.querySelectorAll("img");
    expect(stills).toHaveLength(FILMS.length);
    for (const still of stills) expect(still.getAttribute("alt")).toBe("");
  });

  it("shows the still grid when WebGL is not available", async () => {
    mocks.webgl = false;
    const view = render(<BuildersStage />);
    await nearScreen();
    expect(mocks.createRingScene).not.toHaveBeenCalled();
    expect(view.container.querySelector<HTMLElement>("[data-mode]")?.dataset.mode).toBe("still");
  });

  it("shows the still grid when the scene cannot start", async () => {
    mocks.createRingScene.mockReturnValue(null);
    const view = render(<BuildersStage />);
    await nearScreen();
    await vi.waitFor(() => expect(mocks.createRingScene).toHaveBeenCalled());
    await settle();
    expect(view.container.querySelector<HTMLElement>("[data-mode]")?.dataset.mode).toBe("still");
  });
});

describe("captionOpacity", () => {
  it("shows the opening words as the shot arrives and fades them out before the middle", () => {
    expect(captionOpacity(0, 0, 2)).toBe(1);
    expect(captionOpacity(0.3, 0, 2)).toBe(1);
    expect(captionOpacity(0.45, 0, 2)).toBeCloseTo(0.5);
    expect(captionOpacity(0.6, 0, 2)).toBe(0);
  });

  it("brings the closing words in after the middle and keeps them", () => {
    expect(captionOpacity(0.4, 1, 2)).toBe(0);
    expect(captionOpacity(0.55, 1, 2)).toBeCloseTo(0.5);
    expect(captionOpacity(1, 1, 2)).toBe(1);
  });
});

describe("cameraAt", () => {
  const cz = cameraDistance(1440);
  /* the shot's moves end at 1, 2, 4, 7.5 and 8.5 of its 8.5 */
  const at = (beat: number) => cameraAt(beat / 8.5, cz);

  function expectShot(
    shot: ReturnType<typeof cameraAt>,
    [x, y, z]: [number, number, number],
    look: number
  ) {
    expect(shot.position[0]).toBeCloseTo(x);
    expect(shot.position[1]).toBeCloseTo(y);
    expect(shot.position[2]).toBeCloseTo(z);
    expect(shot.look).toBeCloseTo(look);
  }

  it("starts outside the ring, level, looking a little up", () => {
    expect(cz).toBe(8);
    expectShot(at(0), [0, 0, cz], 1);
    expectShot(at(1), [0, 0, cz], 1);
  });

  it("rises to look down into the ring, dives in and lingers among the tiles", () => {
    expectShot(at(1.5), [0, 2.5, (cz + 5) / 2], 0.5);
    expectShot(at(2), [0, 5, 5], 0);
    expectShot(at(4), [1.5, 2, 2], 0);
    expectShot(at(7.5), [0.3, 0, 0.4], 0);
  });

  it("ends pulled out low, the ring above, and holds past the end", () => {
    expectShot(at(8.5), [-6, -1, cz], -1.7);
    expectShot(cameraAt(1.2, cz), [-6, -1, cz], -1.7);
  });

  it("stands further back on a narrow screen", () => {
    expect(cameraDistance(390)).toBe(6);
    expect(cameraDistance(900)).toBe(7);
  });
});

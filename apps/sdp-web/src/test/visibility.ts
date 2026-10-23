import { act } from "@testing-library/react";
import { vi } from "vitest";

let observers: FakeIntersectionObserver[] = [];

/** An observer that never reports on its own: {@link intersect} reports for it. */
export class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  readonly scrollMargin = "";
  readonly targets: Element[] = [];
  readonly disconnect = vi.fn();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve(target: Element) {
    this.targets.splice(this.targets.indexOf(target), 1);
  }
  takeRecords() {
    return [];
  }
}

/**
 * Stubs `IntersectionObserver` with {@link FakeIntersectionObserver}. Call from `beforeEach`, before
 * the first render; undo with `vi.unstubAllGlobals()`.
 *
 * @returns The observers made from now on, oldest first.
 */
export function stubIntersectionObserver(): readonly FakeIntersectionObserver[] {
  observers = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return observers;
}

/**
 * Every observer reports each element it observes as in or out of view, as the browser does on a
 * scroll.
 *
 * @param entry - Fields of each entry to report instead of the defaults, e.g. the element's box.
 */
export function intersect(
  isIntersecting: boolean,
  entry: Partial<IntersectionObserverEntry> = {}
): void {
  const rect = DOMRect.fromRect();
  act(() => {
    for (const observer of [...observers]) {
      observer.callback(
        observer.targets.map((target) => ({
          isIntersecting,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: null,
          intersectionRatio: isIntersecting ? 1 : 0,
          target,
          time: 0,
          ...entry,
        })),
        observer
      );
    }
  });
}

/**
 * Sets `document.visibilityState` and fires `visibilitychange`, as the browser does when the tab
 * hides or shows. Undo with `vi.restoreAllMocks()`.
 */
export function setVisibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

import { vi } from "vitest";

const REDUCED_MOTION = "prefers-reduced-motion";

let reducedMotion = false;
let otherQueries: (query: string) => boolean = () => false;
/* motion's `useReducedMotion` asks once per module instance and keeps that list, listening for
   its `change`; the lists live here, not in a stub, so re-stubbing between tests keeps them */
const reducedMotionLists = new Set<FakeMediaQueryList>();

class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  onchange = null;
  constructor(readonly media: string) {
    super();
  }
  get matches() {
    return this.media.includes(REDUCED_MOTION) ? reducedMotion : otherQueries(this.media);
  }
  /* the deprecated pair: motion and the homepage listen with `addEventListener` */
  addListener(): never {
    throw new Error("FakeMediaQueryList: use addEventListener");
  }
  removeListener(): never {
    throw new Error("FakeMediaQueryList: use removeEventListener");
  }
}

function matchMedia(query: string): MediaQueryList {
  const list = new FakeMediaQueryList(query);
  if (query.includes(REDUCED_MOTION)) reducedMotionLists.add(list);
  return list;
}

/**
 * Stubs `window.matchMedia`: the reduced-motion query answers {@link setReducedMotion}, every
 * other query `matches` (none by default). Call from `beforeEach`, before the first render, so
 * motion's `useReducedMotion` reads the stub; undo with `vi.unstubAllGlobals()`.
 *
 * @param matches - Whether a query other than reduced motion matches, e.g. a narrow screen's.
 */
export function stubMatchMedia(matches: (query: string) => boolean = () => false): void {
  otherQueries = matches;
  vi.stubGlobal("matchMedia", matchMedia);
}

/**
 * Sets the reader's reduced-motion preference and tells the lists already handed out, as the
 * browser does. `useReducedMotion` reads it when a component mounts, so set it before `render`.
 */
export function setReducedMotion(value: boolean): void {
  reducedMotion = value;
  for (const list of reducedMotionLists) {
    list.dispatchEvent(Object.assign(new Event("change"), { matches: value, media: list.media }));
  }
}

import assert from "node:assert/strict";
import { it } from "node:test";
import { observeTableOfContents } from "@/lib/table-of-contents-observer";

it("tracks active-panel headings and stops both subscriptions after cleanup", () => {
  const globals = ["IntersectionObserver", "MutationObserver"] as const;
  const originals = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const intersections: TestIntersectionObserver[] = [];
  const mutations: TestMutationObserver[] = [];

  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    observed: Element[] = [];
    disconnects = 0;

    constructor(private readonly callback: IntersectionObserverCallback) {
      intersections.push(this);
    }

    observe(element: Element) {
      this.observed.push(element);
    }

    disconnect() {
      this.disconnects += 1;
      this.observed = [];
    }

    unobserve(target: Element) {
      this.observed = this.observed.filter((element) => element !== target);
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    intersect(target: Element) {
      const bounds: DOMRectReadOnly = {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        toJSON: () => ({}),
      };
      this.callback(
        [
          {
            target,
            isIntersecting: true,
            boundingClientRect: bounds,
            intersectionRect: bounds,
            rootBounds: null,
            intersectionRatio: 1,
            time: 0,
          },
        ],
        this
      );
    }
  }

  class TestMutationObserver implements MutationObserver {
    disconnects = 0;
    target: Node | undefined;

    constructor(private readonly callback: MutationCallback) {
      mutations.push(this);
    }

    observe(target: Node) {
      this.target = target;
    }

    disconnect() {
      this.disconnects += 1;
    }

    takeRecords(): MutationRecord[] {
      return [];
    }

    mutate() {
      this.callback([], this);
    }
  }

  Object.defineProperty(globalThis, globals[0], {
    configurable: true,
    value: TestIntersectionObserver,
  });
  Object.defineProperty(globalThis, globals[1], {
    configurable: true,
    value: TestMutationObserver,
  });

  try {
    const headings = ["api", "embedded", "outside"].map((id) => {
      // SAFETY: the observer reads only id and closest; both are supplied here.
      const element = { id } as HTMLElement;
      const heading = { element, inactive: id === "embedded" };
      Object.defineProperty(element, "closest", {
        value: () => (heading.inactive ? element : null),
      });
      return heading;
    });
    const [api, embedded, outside] = headings;
    assert(api && embedded && outside);
    // SAFETY: the observer uses only ownerDocument.getElementById and contains.
    const article = {
      ownerDocument: {
        getElementById: (id: string) =>
          headings.find((heading) => heading.element.id === id)?.element ?? null,
      },
      contains: (element: Node | null) => element !== outside.element,
    } as HTMLElement;
    const items = headings.map(({ element }) => ({ url: `#${element.id}` }));
    const visible: string[][] = [];
    const active: string[] = [];
    const cleanup = observeTableOfContents(
      article,
      items,
      (next) => visible.push(next.map((item) => item.url)),
      (id) => active.push(id)
    );
    const [intersection] = intersections;
    const [mutation] = mutations;
    assert(intersection && mutation);
    assert.equal(mutation.target, article);
    assert.deepEqual(visible, [["#api"]]);
    intersection.intersect(embedded.element);
    assert.deepEqual(active, []);
    intersection.intersect(api.element);
    assert.deepEqual(active, ["#api"]);

    api.inactive = true;
    embedded.inactive = false;
    mutation.mutate();
    assert.deepEqual(visible, [["#api"], ["#embedded"]]);
    assert.deepEqual(intersection.observed, [embedded.element]);
    intersection.intersect(embedded.element);
    assert.deepEqual(active, ["#api", "#embedded"]);

    const previousDisconnects = intersection.disconnects;
    cleanup();
    assert.equal(intersection.disconnects, previousDisconnects + 1);
    assert.equal(mutation.disconnects, 1);
    api.inactive = false;
    mutation.mutate();
    intersection.intersect(api.element);
    assert.deepEqual(visible, [["#api"], ["#embedded"]]);
    assert.deepEqual(active, ["#api", "#embedded"]);
  } finally {
    globals.forEach((name, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

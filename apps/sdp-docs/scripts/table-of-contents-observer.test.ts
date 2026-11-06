import assert from "node:assert/strict";
import { it } from "node:test";
import { observeTableOfContents } from "@/lib/table-of-contents-observer";

it("tracks active-panel headings and stops both subscriptions after cleanup", () => {
  const globals = ["IntersectionObserver", "MutationObserver"] as const;
  const originals = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const intersections: TestIntersectionObserver[] = [];
  const mutations: TestMutationObserver[] = [];

  class TestIntersectionObserver {
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

    intersect(target: Element) {
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
  }

  class TestMutationObserver {
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

    mutate() {
      this.callback([], this as unknown as MutationObserver);
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
    const headings = ["api", "embedded", "outside"].map((id) => ({
      id,
      inactive: id === "embedded",
      closest() {
        return this.inactive ? {} : null;
      },
    }));
    const [api, embedded, outside] = headings;
    assert(api && embedded && outside);
    const article = {
      ownerDocument: {
        getElementById: (id: string) => headings.find((heading) => heading.id === id),
      },
      contains: (element: unknown) => element !== outside,
    } as unknown as HTMLElement;
    const items = headings.map(({ id }) => ({ url: `#${id}` }));
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
    intersection.intersect(embedded as unknown as Element);
    assert.deepEqual(active, []);
    intersection.intersect(api as unknown as Element);
    assert.deepEqual(active, ["#api"]);

    api.inactive = true;
    embedded.inactive = false;
    mutation.mutate();
    assert.deepEqual(visible, [["#api"], ["#embedded"]]);
    assert.deepEqual(intersection.observed, [embedded]);
    intersection.intersect(embedded as unknown as Element);
    assert.deepEqual(active, ["#api", "#embedded"]);

    const previousDisconnects = intersection.disconnects;
    cleanup();
    assert.equal(intersection.disconnects, previousDisconnects + 1);
    assert.equal(mutation.disconnects, 1);
    api.inactive = false;
    mutation.mutate();
    intersection.intersect(api as unknown as Element);
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

import { type RefObject, useEffect, useRef, useState } from "react";
import { supportsWebGL } from "./webgl";

/**
 * Whether the element has come within 200px of the screen, once: a scene fetches nothing (three.js,
 * its data) until then. Without IntersectionObserver it is near at once.
 */
export function useNearScreen(ref: RefObject<Element | null>) {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return near;
}

/**
 * What counts as on screen for `watchActive`: at least `threshold` of the element showing, or any
 * of it within `rootMargin` of the screen.
 */
export type ActiveWatch = { threshold: number } | { rootMargin: string };

/**
 * Whether one observer entry puts the element on screen under `watch`. An observer reports
 * `isIntersecting` for any visible edge, so a threshold is checked against the ratio itself.
 *
 * @param entry - The observer's entry for the element.
 * @param watch - What counts as on screen.
 * @returns True when the element is on screen.
 */
function isOnScreen(entry: IntersectionObserverEntry, watch: ActiveWatch): boolean {
  if ("threshold" in watch)
    return entry.isIntersecting && entry.intersectionRatio >= watch.threshold;
  return entry.isIntersecting;
}

/**
 * Reports whether a loop may run: `element` is on screen (by `watch`) and the tab is visible.
 * Calls `onChange` on every change of either; without IntersectionObserver the element counts as
 * on screen. Returns the stop function.
 *
 * @param element - The element whose visibility gates the loop.
 * @param watch - What counts as on screen.
 * @param onChange - Called with whether the loop may run, on every change.
 * @returns The function that stops watching.
 */
export function watchActive(
  element: Element,
  watch: ActiveWatch,
  onChange: (active: boolean) => void
) {
  const watchesScreen = typeof IntersectionObserver !== "undefined";
  let onScreen = !watchesScreen;
  const update = () => onChange(onScreen && document.visibilityState === "visible");
  const observer = watchesScreen
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) onScreen = isOnScreen(entry, watch);
        update();
      }, watch)
    : null;
  document.addEventListener("visibilitychange", update);
  if (observer) observer.observe(element);
  else update();

  return () => {
    observer?.disconnect();
    document.removeEventListener("visibilitychange", update);
  };
}

/** A drawn scene as its section drives it. */
export type LiveScene = {
  setActive: (active: boolean) => void;
  dispose: () => void;
};

/** waiting: not loaded yet; live: drawing; fallback: the section shows its still version. */
export type LazySceneMode = "waiting" | "live" | "fallback";

type LazySceneOptions<Module, Settings> = {
  /** Fetches the scene's module (a dynamic import). */
  load: () => Promise<Module>;
  /**
   * Builds the scene from it with `settings`, or returns null when it cannot start; `onLost`:
   * WebGL went away.
   */
  create: (module: Module, settings: Settings, onLost: () => void) => LiveScene | null;
  /** What the scene is built with (e.g. reduced motion); a change of it rebuilds the scene. */
  settings: Settings;
  /** How much of the element must be on screen for the scene to draw. */
  activeThreshold: number;
  /** Shows the fallback at once and loads nothing (e.g. under reduced motion). */
  disabled?: boolean;
};

/**
 * The lifecycle the page's WebGL scenes share. Nothing loads until `ref` nears the screen; then,
 * given WebGL, `load` fetches the scene and `create` builds it, and it draws only while `ref` is
 * on screen and the tab is visible. No WebGL, a scene that cannot start, a failed fetch or a lost
 * context fall back.
 */
export function useLazyScene<Module, Settings>(
  ref: RefObject<Element | null>,
  options: LazySceneOptions<Module, Settings>
): LazySceneMode {
  const { settings, activeThreshold, disabled = false } = options;
  const [mode, setMode] = useState<LazySceneMode>("waiting");
  const near = useNearScreen(ref);
  /* the latest `load` and `create`, so new closures each render do not rebuild the scene */
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const element = ref.current;
    if (disabled) {
      setMode("fallback");
      return;
    }
    if (!near || !element) return;
    if (!supportsWebGL()) {
      setMode("fallback");
      return;
    }

    let cancelled = false;
    let scene: LiveScene | null = null;
    let stopWatching = () => {};
    const stop = () => {
      stopWatching();
      scene?.dispose();
      scene = null;
    };

    latest.current
      .load()
      .then((module) => {
        if (cancelled) return;
        const built = latest.current.create(module, settings, () => {
          stop();
          setMode("fallback");
        });
        if (!built) {
          setMode("fallback");
          return;
        }
        scene = built;
        setMode("live");
        stopWatching = watchActive(element, { threshold: activeThreshold }, (active) =>
          scene?.setActive(active)
        );
      })
      .catch((error: unknown) => {
        console.error("homepage scene failed to load", error);
        if (!cancelled) setMode("fallback");
      });

    return () => {
      cancelled = true;
      stop();
      /* a rebuild (settings changed) shows the waiting state, not an empty live box */
      setMode((current) => (current === "live" ? "waiting" : current));
    };
  }, [ref, near, disabled, settings, activeThreshold]);

  return mode;
}

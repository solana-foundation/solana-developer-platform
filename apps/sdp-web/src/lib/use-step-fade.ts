"use client";

import { playEntrance } from "@sdp/ui/motion";
import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Fades a flow's step in each time `step` changes after the first render: opacity only, so
 * nothing moves, and the step keeps its mounted state. The first render has nothing to fade
 * from, and a viewer who asks for reduced motion gets none.
 *
 * @param step - The step on screen.
 * @returns The ref for the element that holds the step.
 */
export function useStepFade<T extends HTMLElement>(step: number | string): RefObject<T | null> {
  const ref = useRef<T>(null);
  const shownStep = useRef(step);
  // Before paint, so the new step never shows one frame at full strength first.
  useLayoutEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (ref.current !== null) playEntrance(ref.current, [{ opacity: 0 }, { opacity: 1 }]);
  }, [step]);
  return ref;
}

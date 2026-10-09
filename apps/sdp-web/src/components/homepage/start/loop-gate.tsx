"use client";

import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from "react";
import { watchActive } from "@/lib/use-scene-active";

/**
 * The close's section element. Its CSS loops (the pill's breath, the mark's drift) run only while
 * `data-loops="on"`: the section is near the screen and the tab is visible.
 */
export function LoopGate(props: ComponentPropsWithoutRef<"section">) {
  const ref = useRef<HTMLElement>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return watchActive(element, { rootMargin: "200px 0px" }, setRunning);
  }, []);

  return <section ref={ref} data-loops={running ? "on" : "off"} {...props} />;
}

"use client";

import { useInView, useReducedMotion } from "motion/react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { NARROW_QUERY } from "../layout";
import { restartAttribute } from "../restart-animation";
import { useRiseArrived } from "../rise";
import { Bubble } from "./bubble";
import {
  ServiceIcon,
  STACK_PRODUCTS,
  STACK_SERVICES,
  type StackProduct,
  type StackService,
} from "./service-icons";
import styles from "./stack.module.css";
import {
  KNOB_HITS_PRODUCT,
  KNOB_HITS_SDP,
  KNOB_LAUNCH_DELAY_MS,
  KNOB_RUN_MS,
  knobPosition,
  knobVisible,
  PRODUCT_CYCLE_MS,
  PRODUCT_WIDE_START_MS,
  RECEIVED_AMOUNTS,
  ROUTE_START_DELAY_MS,
  SERVICE_CYCLE_MS,
} from "./stack-timeline";

export type StackDrawingCopy = {
  labels: { partners: string; sdp: string; product: string };
  aria: { partners: string; sdp: string; product: string };
  services: Record<StackService, string>;
  products: Record<StackProduct, string>;
  /** The received note for each of `RECEIVED_AMOUNTS`, in order. */
  received: readonly string[];
};

type KnobRun = { t: number; launched: boolean; hitSdp: boolean; hitProduct: boolean };

/** A knob run that waits a beat after its service appears, then leaves. */
function newKnobRun(): KnobRun {
  return { t: -KNOB_LAUNCH_DELAY_MS, launched: false, hitSdp: false, hitProduct: false };
}

/**
 * Moves the knob `dt` further along the track, firing each moment once: it leaves, it passes
 * behind SDP (and turns violet), it lands in the product (and turns mint). True when it is done.
 */
function advanceKnob(
  run: KnobRun,
  dt: number,
  knob: HTMLElement,
  on: { launch: () => void; reachSdp: () => void; reachProduct: () => void }
): boolean {
  run.t += dt;
  if (run.t < 0) return false;
  if (!run.launched) {
    run.launched = true;
    delete knob.dataset.tone;
    on.launch();
  }
  const x = knobPosition(run.t);
  knob.style.left = `${x.toFixed(3)}%`;
  knob.toggleAttribute("data-show", knobVisible(run.t));
  if (!run.hitSdp && x >= KNOB_HITS_SDP) {
    run.hitSdp = true;
    knob.dataset.tone = "violet";
    on.reachSdp();
  }
  if (!run.hitProduct && x >= KNOB_HITS_PRODUCT) {
    run.hitProduct = true;
    knob.dataset.tone = "mint";
    on.reachProduct();
  }
  return run.t >= KNOB_RUN_MS;
}

type Timeline = {
  started: boolean;
  serviceClock: number;
  serviceIndex: number;
  /** The knob's run; negative time is the wait before it leaves. */
  run: KnobRun | null;
  productClock: number;
  productIndex: number;
  receivedIndex: number;
};

/**
 * The route: the partner services' bubble shows each service in turn and sends a knob carrying
 * its mark along the track; the knob passes behind SDP (which beats) and turns violet, then lands
 * in the product (which beats, and a received note rises from it). Under reduced motion it is a
 * still picture of the first service, SDP and the first product.
 */
export function StackDrawing({ copy }: { copy: StackDrawingCopy }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const srcRef = useRef<HTMLDivElement>(null);
  const sdpRef = useRef<HTMLDivElement>(null);
  const productRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const toastRef = useRef<HTMLSpanElement>(null);
  const timeline = useRef<Timeline>({
    started: false,
    serviceClock: 0,
    serviceIndex: 0,
    run: null,
    productClock: 0,
    productIndex: 0,
    receivedIndex: 0,
  });

  const reducedMotion = useReducedMotion();
  const riseArrived = useRiseArrived();
  const seen = useInView(gridRef, { once: true, amount: 0.3 });
  const onScreen = useInView(gridRef);
  const [landed, setLanded] = useState(false);
  const [tabVisible, setTabVisible] = useState(true);
  const [serviceIndex, setServiceIndex] = useState(0);
  const [productIndex, setProductIndex] = useState(0);
  const [knobService, setKnobService] = useState<StackService>(STACK_SERVICES[0]);
  const [receivedIndex, setReceivedIndex] = useState(0);

  const blockArrived = riseArrived ?? seen;
  useEffect(() => {
    if (!blockArrived) return;
    const timer = window.setTimeout(() => setLanded(true), ROUTE_START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [blockArrived]);

  useEffect(() => {
    const update = () => setTabVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const running = !reducedMotion && seen && landed && onScreen && tabVisible;

  useEffect(() => {
    if (!running) return;
    const state = timeline.current;
    if (!state.started) {
      state.started = true;
      state.run = newKnobRun();
      state.productClock = window.matchMedia(NARROW_QUERY).matches ? 0 : PRODUCT_WIDE_START_MS;
    }

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(1000, now - last);
      last = now;

      state.serviceClock += dt;
      if (state.serviceClock >= SERVICE_CYCLE_MS) {
        state.serviceClock = 0;
        state.serviceIndex = (state.serviceIndex + 1) % STACK_SERVICES.length;
        setServiceIndex(state.serviceIndex);
        restartAttribute(srcRef.current, "data-beat");
        state.run = newKnobRun();
      }

      if (state.run && knobRef.current) {
        const finished = advanceKnob(state.run, dt, knobRef.current, {
          launch: () => setKnobService(STACK_SERVICES[state.serviceIndex]),
          reachSdp: () => restartAttribute(sdpRef.current, "data-beat"),
          reachProduct: () => {
            restartAttribute(productRef.current, "data-beat");
            setReceivedIndex(state.receivedIndex);
            state.receivedIndex = (state.receivedIndex + 1) % RECEIVED_AMOUNTS.length;
            restartAttribute(toastRef.current, "data-up");
          },
        });
        if (finished) state.run = null;
      }

      state.productClock += dt;
      if (state.productClock >= PRODUCT_CYCLE_MS) {
        state.productClock = 0;
        state.productIndex = (state.productIndex + 1) % STACK_PRODUCTS.length;
        setProductIndex(state.productIndex);
        restartAttribute(productRef.current, "data-beat");
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  // By hand: moving a mouse over the drawing sends a wave from the services to the product; when
  // it stops, the pieces settle.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || reducedMotion) return;
    const parts = [
      { ref: srcRef, x: 17 },
      { ref: sdpRef, x: 50 },
      { ref: productRef, x: 83 },
    ];
    let energy = 0;
    let phase = 0;
    let hovering = false;
    let lastX = 0;
    let lastY = 0;
    let frame = 0;
    let last = 0;

    const settle = (now: number) => {
      const dt = Math.min(1000, now - last);
      last = now;
      energy *= 0.93 ** (dt / 16);
      const done = energy < 0.003;
      for (const part of parts) {
        const el = part.ref.current;
        if (!el) continue;
        el.style.scale = done
          ? ""
          : (1 + 0.022 * energy * Math.sin(phase - (part.x / 100) * 4.2)).toFixed(4);
      }
      if (done) {
        energy = 0;
        frame = 0;
        return;
      }
      frame = requestAnimationFrame(settle);
    };

    const onEnter = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      hovering = true;
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onLeave = () => {
      hovering = false;
    };
    const onMove = (event: PointerEvent) => {
      if (!hovering) return;
      const distance = Math.hypot(event.clientX - lastX, event.clientY - lastY);
      lastX = event.clientX;
      lastY = event.clientY;
      energy = Math.min(1, energy + distance / 110);
      phase += distance * 0.025;
      if (!frame) {
        last = performance.now();
        frame = requestAnimationFrame(settle);
      }
    };

    grid.addEventListener("pointerenter", onEnter);
    grid.addEventListener("pointerleave", onLeave);
    grid.addEventListener("pointermove", onMove);
    return () => {
      grid.removeEventListener("pointerenter", onEnter);
      grid.removeEventListener("pointerleave", onLeave);
      grid.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [reducedMotion]);

  const serviceWords = STACK_SERVICES.map((service) => ({
    key: service,
    content: (
      <>
        <span className={styles.wordIcon}>
          <ServiceIcon service={service} />
        </span>
        {copy.services[service]}
      </>
    ),
  }));
  const sdpWords = [
    {
      key: "sdp",
      content: (
        <Image
          className={styles.lockup}
          src="/homepage/v6/logo-sdp-lockup-bare.svg"
          alt=""
          width={260}
          height={100}
        />
      ),
    },
  ];
  const productWords = STACK_PRODUCTS.map((product) => ({
    key: product,
    content: copy.products[product],
  }));

  return (
    <div ref={gridRef} className={styles.grid} data-paused={onScreen ? undefined : ""}>
      <span className={styles.label} style={{ left: "17%" }} aria-hidden="true">
        {copy.labels.partners}
      </span>
      <span className={styles.label} style={{ left: "50%" }} aria-hidden="true">
        {copy.labels.sdp}
      </span>
      <span className={styles.label} style={{ left: "83%" }} aria-hidden="true">
        {copy.labels.product}
      </span>
      <span className={styles.track} aria-hidden="true" />
      <span ref={knobRef} className={styles.knob} aria-hidden="true">
        <ServiceIcon service={knobService} />
      </span>
      <Bubble
        ref={srcRef}
        className={styles.src}
        tone="grey"
        ariaLabel={copy.aria.partners}
        words={serviceWords}
        activeIndex={serviceIndex}
      />
      <Bubble
        ref={sdpRef}
        className={styles.sdp}
        tone="violet"
        ariaLabel={copy.aria.sdp}
        words={sdpWords}
        activeIndex={0}
      />
      <Bubble
        ref={productRef}
        className={styles.product}
        tone="mint"
        ariaLabel={copy.aria.product}
        words={productWords}
        activeIndex={productIndex}
      />
      <span ref={toastRef} className={styles.toast} aria-hidden="true">
        <span className={styles.toastDot} />
        <span>{copy.received[receivedIndex]}</span>
      </span>
    </div>
  );
}

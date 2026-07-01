"use client";

import { Maximize2Icon } from "lucide-react";
import type { HTMLAttributeReferrerPolicy } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

const FRAME_ALLOW =
  "accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; payment";

export interface HostedRampFrameEvent {
  eventName: string;
  data?: { errorCode?: string; errorMessage?: string };
}

export function HostedRampFrame({
  title,
  src,
  onProviderEvent,
  sandbox,
  referrerPolicy,
}: {
  title: string;
  src: string;
  /** When set, listens for the frame's postMessage events (Coinbase headless `onramp_api.*`). */
  onProviderEvent?: (event: HostedRampFrameEvent) => void;
  /** Coinbase's Apple Pay payment link requires these iframe attributes; omitted for other providers. */
  sandbox?: string;
  referrerPolicy?: HTMLAttributeReferrerPolicy;
}) {
  const [expanded, setExpanded] = useState(false);

  // Keep the latest callback in a ref so a fresh inline arrow each render doesn't re-bind the listener.
  const onProviderEventRef = useRef(onProviderEvent);
  onProviderEventRef.current = onProviderEvent;
  const listens = Boolean(onProviderEvent);

  useEffect(() => {
    // `src` is a provider-supplied URL; skip the listener if it isn't a parseable absolute URL
    // rather than throwing and crashing the frame.
    if (!listens || !URL.canParse(src)) {
      return;
    }
    const expectedOrigin = new URL(src).origin;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) {
        return;
      }
      const message = event.data;
      if (
        !message ||
        typeof message !== "object" ||
        typeof (message as { eventName?: unknown }).eventName !== "string"
      ) {
        return;
      }
      onProviderEventRef.current?.(message as HostedRampFrameEvent);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [src, listens]);

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl">
        <iframe
          title={title}
          src={src}
          className="h-[480px] w-full border-0"
          allow={FRAME_ALLOW}
          sandbox={sandbox}
          referrerPolicy={referrerPolicy}
        />
        <div className="absolute top-3 right-3 z-10">
          <Button
            type="button"
            variant="secondary"
            size="xs"
            iconLeft={<Maximize2Icon />}
            onClick={() => setExpanded(true)}
            className="shadow-sm"
          >
            Open full screen
          </Button>
        </div>
      </div>
      <Modal
        isOpen={expanded}
        ariaLabel={title}
        onClose={() => setExpanded(false)}
        size="xl"
        contentClassName="max-w-5xl"
      >
        <div className="overflow-hidden rounded-2xl px-1 pt-12 pb-1">
          <iframe
            title={title}
            src={src}
            className="h-[80vh] w-full border-0"
            allow={FRAME_ALLOW}
            sandbox={sandbox}
            referrerPolicy={referrerPolicy}
          />
        </div>
      </Modal>
    </div>
  );
}

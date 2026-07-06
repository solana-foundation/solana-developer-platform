"use client";

import { useEffect } from "react";
import { handleCoinbaseFrameEvent } from "./frame-events";

/**
 * Embeds a Coinbase headless-onramp payment link and forwards its postMessage
 * events (`onramp_api.*`) to the SDP ramp-events endpoint.
 *
 * Coinbase-specific by design: the payment link requires the exact
 * `sandbox`/`referrerPolicy` attributes below to render in an iframe, and the
 * Apple Pay sheet takes over the screen on its own when pressed, so the frame
 * deliberately has no fullscreen affordance.
 *
 * The `allow-scripts allow-same-origin` pair is mandated verbatim by Coinbase's
 * embedding docs. The known sandbox escape for that pair (the framed script
 * removing its own sandbox attribute via `window.frameElement`) requires the
 * frame to be same-origin with the embedder; pay.coinbase.com is cross-origin
 * here, so the sandbox still constrains it.
 *
 * @see https://docs.cdp.coinbase.com/onramp/headless-onramp/overview#web-app-testing
 */
export function CoinbaseRampFrame({ orderId, src }: { orderId: string; src: string }) {
  useEffect(() => {
    const expectedOrigin = new URL(src).origin;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) {
        return;
      }
      handleCoinbaseFrameEvent(orderId, event.data);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [src, orderId]);

  return (
    <div className="overflow-hidden rounded-2xl">
      <iframe
        title="Coinbase onramp"
        src={src}
        className="h-[480px] w-full border-0"
        allow="payment"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

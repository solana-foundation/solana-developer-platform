"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { handleCoinbaseFrameEvent } from "./frame-events";

/**
 * Embeds a Coinbase headless-onramp payment link and forwards its postMessage
 * events (`onramp_api.*`) to the SDP ramp-events endpoint.
 *
 * Coinbase-specific by design: the payment link requires the exact
 * `sandbox`/`referrerPolicy` attributes below to render in an iframe. The
 * framed page renders only the Apple Pay button until it is pressed, then
 * expands a payment sheet inside the same frame — so the frame is sized like
 * a button and grows to a panel on `apple_pay_button_pressed`, shrinking back
 * on `cancel`.
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
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const expectedOrigin = new URL(src).origin;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) {
        return;
      }
      const frameEvent = handleCoinbaseFrameEvent(orderId, event.data, t);
      if (frameEvent?.eventName === "onramp_api.apple_pay_button_pressed") {
        setExpanded(true);
      }
      if (frameEvent?.eventName === "onramp_api.cancel") {
        setExpanded(false);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [src, orderId, t]);

  return (
    <div
      className={`overflow-hidden rounded-lg transition-all duration-300 ${expanded ? "max-w-lg" : "max-w-xs"}`}
    >
      <iframe
        title={t("DashboardPayments.ramps.coinbaseOnramp")}
        src={src}
        className={`w-full border-0 transition-all duration-300 ${expanded ? "h-96" : "h-12"}`}
        allow="payment"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

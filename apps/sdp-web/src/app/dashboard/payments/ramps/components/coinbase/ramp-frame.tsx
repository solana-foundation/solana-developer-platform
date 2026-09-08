"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import {
  COINBASE_HOSTED_APPROVED_HOSTS,
  isTrustedRampDestination,
} from "@/lib/trusted-ramp-destinations";
import { type CoinbaseFrameEventOptions, handleCoinbaseFrameEvent } from "./frame-events";

/**
 * Embeds a Coinbase on-ramp payment link and forwards its postMessage events
 * (`onramp_api.*`) to the SDP ramp-events endpoint.
 *
 * Coinbase-specific by design: the payment link requires the exact
 * `sandbox`/`referrerPolicy` attributes below to render in an iframe. Orders are
 * created in embedded mode, so the framed page opens on Coinbase's own
 * verification and limits screens before it reaches the Apple Pay button — the
 * frame is therefore a full panel from the first render, and only collapses when
 * the hosted flow ends: `commit_success` hands over to the transfer status, and
 * `session_error` (a terminal verification, limits or order-preparation failure)
 * replaces the frame with Coinbase's localized message.
 *
 * The `allow-scripts allow-same-origin` pair is mandated verbatim by Coinbase's
 * embedding docs. The known sandbox escape for that pair (the framed script
 * removing its own sandbox attribute via `window.frameElement`) requires the
 * frame to be same-origin with the embedder; pay.coinbase.com is cross-origin
 * here, so the sandbox still constrains it.
 *
 * @see https://docs.cdp.coinbase.com/onramp/headless-onramp/overview#web-app-testing
 */
type CoinbaseFramePhase =
  | { kind: "panel" }
  | { kind: "processing" }
  | { kind: "failed"; message: string };

export function CoinbaseRampFrame({
  orderId,
  src,
  postEvent,
}: { orderId: string; src: string } & CoinbaseFrameEventOptions) {
  const t = useTranslations();
  const [phase, setPhase] = useState<CoinbaseFramePhase>({ kind: "panel" });
  // The frame's origin is also what the postMessage listener trusts, so only
  // HTTPS Coinbase payment-link hosts may ever be embedded — fail closed.
  const trustedSrc = isTrustedRampDestination(src, COINBASE_HOSTED_APPROVED_HOSTS);
  useEffect(() => {
    if (!trustedSrc) {
      return;
    }
    const expectedOrigin = new URL(src).origin;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) {
        return;
      }
      const frameEvent = handleCoinbaseFrameEvent(orderId, event.data, t, { postEvent });
      if (frameEvent?.eventName === "onramp_api.commit_success") {
        setPhase({ kind: "processing" });
      }
      if (frameEvent?.eventName === "onramp_api.session_error") {
        setPhase({ kind: "failed", message: frameEvent.data.errorMessage });
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [src, orderId, t, trustedSrc, postEvent]);

  if (!trustedSrc) {
    return (
      <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
        {t("DashboardPayments.ramps.untrustedProviderUrl")}
      </div>
    );
  }

  if (phase.kind === "processing") {
    return null;
  }

  if (phase.kind === "failed") {
    return (
      <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
        {t("DashboardPayments.ramps.coinbaseSessionError", { message: phase.message })}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg overflow-hidden rounded-lg">
      <iframe
        title={t("DashboardPayments.ramps.coinbaseOnramp")}
        src={src}
        className="h-96 w-full border-0"
        allow="payment"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

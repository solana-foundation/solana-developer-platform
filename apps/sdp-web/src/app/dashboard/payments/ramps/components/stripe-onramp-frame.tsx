"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

const STRIPE_JS_URL = "https://js.stripe.com/dahlia/stripe.js";
const STRIPE_CRYPTO_ONRAMP_URL = "https://crypto-js.stripe.com/crypto-onramp-outer.js";

type StripeOnrampSession = {
  mount: (target: string | HTMLElement) => void;
};

type StripeOnrampFactory = (publishableKey: string) => {
  createSession: (options: {
    clientSecret: string;
    appearance?: { theme?: "light" | "dark" };
  }) => StripeOnrampSession;
};

declare global {
  interface Window {
    StripeOnramp?: StripeOnrampFactory;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error(`Failed to load ${src}`));
      },
      { once: true }
    );
    document.head.appendChild(script);
  });
}

let onrampPromise: Promise<StripeOnrampFactory> | null = null;

function loadStripeOnramp(): Promise<StripeOnrampFactory> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Stripe onramp requires a browser environment"));
  }
  if (window.StripeOnramp) {
    return Promise.resolve(window.StripeOnramp);
  }
  if (!onrampPromise) {
    onrampPromise = loadScript(STRIPE_JS_URL)
      .then(() => loadScript(STRIPE_CRYPTO_ONRAMP_URL))
      .then(() => {
        if (!window.StripeOnramp) {
          throw new Error("Stripe onramp script loaded without a StripeOnramp global");
        }
        return window.StripeOnramp;
      })
      .catch((error) => {
        onrampPromise = null;
        throw error;
      });
  }
  return onrampPromise;
}

export function StripeOnrampFrame({
  clientSecret,
  publishableKey,
}: {
  clientSecret: string;
  publishableKey: string;
}) {
  const t = useTranslations();
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const [failed, setFailed] = useState(false);

  const mountStripeWidget = useCallback(async () => {
    setFailed(false);
    try {
      const factory = await loadStripeOnramp();
      if (!mountedRef.current || !containerRef.current) {
        return;
      }
      containerRef.current.replaceChildren();
      factory(publishableKey).createSession({ clientSecret }).mount(containerRef.current);
    } catch (error) {
      console.error("[stripe onramp] failed to mount widget", error);
      if (mountedRef.current) {
        setFailed(true);
      }
    }
  }, [clientSecret, publishableKey]);

  useEffect(() => {
    mountedRef.current = true;
    void mountStripeWidget();
    return () => {
      mountedRef.current = false;
    };
  }, [mountStripeWidget]);

  return (
    <div className="flex min-h-[640px] flex-col items-center justify-center">
      {failed ? (
        <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
          <p className="text-lg font-medium text-primary">
            {t("DashboardPayments.ramps.stripeLoadError")}
          </p>
          <p className="max-w-md text-sm leading-relaxed text-tertiary">
            {t("DashboardPayments.ramps.stripeLoadHelp")}
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void mountStripeWidget();
            }}
          >
            {t("DashboardPayments.ramps.tryAgain")}
          </Button>
        </div>
      ) : null}
      <div ref={containerRef} className={failed ? "hidden" : "flex w-full justify-center"} />
    </div>
  );
}

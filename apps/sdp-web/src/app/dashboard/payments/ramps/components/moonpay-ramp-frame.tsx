"use client";

const FRAME_ALLOW =
  "accelerometer; autoplay; camera; encrypted-media; fullscreen; geolocation; gyroscope; payment";

/**
 * Embeds the MoonPay widget for on-ramp deposits and off-ramp payouts. The
 * widget renders its whole KYC + payment flow inline.
 */
export function MoonpayRampFrame({ title, src }: { title: string; src: string }) {
  return (
    <div className="overflow-hidden rounded-2xl">
      <iframe title={title} src={src} className="h-[640px] w-full border-0" allow={FRAME_ALLOW} />
    </div>
  );
}

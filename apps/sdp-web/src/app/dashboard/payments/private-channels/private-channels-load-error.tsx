import { getTranslations } from "@/i18n/server";

/**
 * Inline "this section failed to load" notice.
 *
 * Mirrors the error-surface classes used across the ramps flows
 * (`border-error-border bg-error-bg text-error`); it exists as a component only
 * because every Private Channels page needs the same one.
 *
 * `message` is the API's own error text when there is one, so it stays
 * untranslated; the generic fallback is localised. Server-only — every caller is
 * a page, so resolving the locale here keeps the callers from threading it in.
 */
export async function PrivateChannelsLoadError({ message }: { message?: string }) {
  const t = await getTranslations();
  return (
    <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
      {message ?? t("DashboardPrivateChannels.common.loadError")}
    </div>
  );
}

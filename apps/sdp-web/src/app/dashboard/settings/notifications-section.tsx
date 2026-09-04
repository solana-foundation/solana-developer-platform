"use client";

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferenceDto,
} from "@sdp/types";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { updateNotificationPreferencesAction } from "./actions";

// Per-user notification preferences: category rows × (in-app, email) toggle columns.
// Opt-out model — everything defaults to on; the server stores only overrides and
// always returns the effective matrix. Not permission-gated: a member's own inbox is
// theirs to tune, same rationale as the appearance section.
export function NotificationsSection({
  preferences,
  loadError,
}: {
  preferences: NotificationPreferenceDto[];
  loadError: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [matrix, setMatrix] = useState<Map<string, boolean>>(
    () => new Map(preferences.map((cell) => [`${cell.category}:${cell.channel}`, cell.enabled]))
  );
  // Every in-flight cell stays disabled until ITS request settles. A single
  // last-writer slot re-enabled a still-pending cell as soon as any other cell
  // resolved, letting a second toggle race the first one's rollback.
  const [pendingCells, setPendingCells] = useState<ReadonlySet<string>>(new Set());

  // A missing key must degrade to readable text, not throw — translate() throwing
  // inside this client component would take down the whole settings page, not just
  // this card. (The keys are generated from the shared category/channel consts, so a
  // taxonomy addition can outrun the catalogs.)
  const safeT = useCallback(
    (key: string, fallback: string) => {
      try {
        return t(key as MessageKey);
      } catch {
        return fallback;
      }
    },
    [t]
  );
  const categoryLabel = (category: NotificationCategory) =>
    safeT(`Shared.notifications.preferences.categories.${category}`, category.replace(/_/g, " "));
  const categoryHint = (category: NotificationCategory) =>
    safeT(`Shared.notifications.preferences.categoryHints.${category}`, "");
  const channelLabel = (channel: NotificationChannel) =>
    t(
      channel === "in_app"
        ? "Shared.notifications.preferences.channelInApp"
        : "Shared.notifications.preferences.channelEmail"
    );

  const cellEnabled = (category: NotificationCategory, channel: NotificationChannel) =>
    matrix.get(`${category}:${channel}`) ?? true;

  const onToggle = async (
    category: NotificationCategory,
    channel: NotificationChannel,
    enabled: boolean
  ) => {
    const key = `${category}:${channel}`;
    setPendingCells((prev) => new Set(prev).add(key));
    setMatrix((prev) => new Map(prev).set(key, enabled));
    const result = await updateNotificationPreferencesAction({ category, channel, enabled });
    setPendingCells((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (result.status === "error") {
      setMatrix((prev) => new Map(prev).set(key, !enabled));
      toast.error(result.message);
    }
    // No success toast: the switch landing in its new position IS the confirmation,
    // and a user configuring six cells doesn't need six stacked "saved" toasts.
  };

  if (loadError) {
    return (
      <Card id="notifications" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>{t("Shared.notifications.preferences.title")}</CardTitle>
          <CardDescription>{t("Shared.notifications.preferences.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border-default bg-fill-subtle px-3 py-2 text-sm text-secondary">
            {t("Shared.notifications.preferences.loadError")}{" "}
            <button
              type="button"
              disabled={refreshing}
              onClick={() => startRefresh(() => router.refresh())}
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
            >
              {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {t("Shared.notifications.preferences.retry")}
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    // The id anchors the "Manage notification preferences" link in every email
    // footer — this card is the last of four sections on the page.
    <Card id="notifications" className="scroll-mt-6">
      <CardHeader>
        <CardTitle>{t("Shared.notifications.preferences.title")}</CardTitle>
        <CardDescription>{t("Shared.notifications.preferences.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-separate border-spacing-0">
            <thead>
              <tr className="text-left text-xs font-medium text-tertiary">
                <th scope="col" className="pb-2 font-medium">
                  {t("Shared.notifications.preferences.categoryColumn")}
                </th>
                <th scope="col" className="w-24 pb-2 text-center font-medium">
                  {t("Shared.notifications.preferences.channelInApp")}
                </th>
                <th scope="col" className="w-24 pb-2 text-center font-medium">
                  {t("Shared.notifications.preferences.channelEmail")}
                </th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_CATEGORIES.map((category) => (
                <tr key={category} className="border-t border-border-subtle">
                  <th scope="row" className="border-t border-border-subtle py-3 pr-4 text-left">
                    <p className="text-sm font-medium text-primary">{categoryLabel(category)}</p>
                    <p className="mt-0.5 text-xs font-normal text-tertiary">
                      {categoryHint(category)}
                    </p>
                  </th>
                  {NOTIFICATION_CHANNELS.map((channel) => (
                    <td
                      key={channel}
                      className="border-t border-border-subtle py-3 text-center align-middle"
                    >
                      {/* Email toggles stay INTERACTIVE when email delivery is
                          unconfigured: the stored preference is real (it applies the
                          moment email is set up), a disabled-in-ON switch reads as
                          "email is on", and disabled controls are unreachable by
                          keyboard — the hint below explains the pause instead. */}
                      <ToggleSwitch
                        checked={cellEnabled(category, channel)}
                        disabled={pendingCells.has(`${category}:${channel}`)}
                        onChange={(checked) => void onToggle(category, channel, checked)}
                        aria-label={t("Shared.notifications.preferences.toggleAria", {
                          category: categoryLabel(category),
                          channel: channelLabel(channel),
                        })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

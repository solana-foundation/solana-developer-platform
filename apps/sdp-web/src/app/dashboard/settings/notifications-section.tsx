"use client";

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferenceDto,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
  emailEnabled,
  loadError,
}: {
  preferences: NotificationPreferenceDto[];
  emailEnabled: boolean;
  loadError: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [matrix, setMatrix] = useState<Map<string, boolean>>(
    () => new Map(preferences.map((cell) => [`${cell.category}:${cell.channel}`, cell.enabled]))
  );
  // One in-flight cell at a time keeps rollback unambiguous; the toggles are disabled
  // per-cell rather than globally so the rest of the matrix stays interactive.
  const [pendingCell, setPendingCell] = useState<string | null>(null);

  const cellEnabled = (category: NotificationCategory, channel: NotificationChannel) =>
    matrix.get(`${category}:${channel}`) ?? true;

  const onToggle = async (
    category: NotificationCategory,
    channel: NotificationChannel,
    enabled: boolean
  ) => {
    const key = `${category}:${channel}`;
    setPendingCell(key);
    setMatrix((prev) => new Map(prev).set(key, enabled));
    const result = await updateNotificationPreferencesAction({ category, channel, enabled });
    setPendingCell(null);
    if (result.status === "error") {
      setMatrix((prev) => new Map(prev).set(key, !enabled));
      toast.error(result.message);
      return;
    }
    toast.success(result.message);
  };

  if (loadError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("Shared.notifications.preferences.title")}</CardTitle>
          <CardDescription>{t("Shared.notifications.preferences.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border-default bg-fill-subtle px-3 py-2 text-sm text-secondary">
            {t("Shared.notifications.preferences.loadError")}{" "}
            <button
              type="button"
              onClick={() => startRefresh(() => router.refresh())}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t("Shared.notifications.preferences.retry")}
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
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
                  <td className="border-t border-border-subtle py-3 pr-4">
                    <p className="text-sm font-medium text-primary">
                      {t(`Shared.notifications.preferences.categories.${category}` as MessageKey)}
                    </p>
                    <p className="mt-0.5 text-xs text-tertiary">
                      {t(
                        `Shared.notifications.preferences.categoryHints.${category}` as MessageKey
                      )}
                    </p>
                  </td>
                  {NOTIFICATION_CHANNELS.map((channel) => (
                    <td
                      key={channel}
                      className="border-t border-border-subtle py-3 text-center align-middle"
                    >
                      <ToggleSwitch
                        checked={cellEnabled(category, channel)}
                        disabled={
                          pendingCell === `${category}:${channel}` ||
                          (channel === "email" && !emailEnabled)
                        }
                        onChange={(checked) => void onToggle(category, channel, checked)}
                        aria-label={t("Shared.notifications.preferences.toggleAria", {
                          category: t(
                            `Shared.notifications.preferences.categories.${category}` as MessageKey
                          ),
                          channel: t(
                            channel === "in_app"
                              ? "Shared.notifications.preferences.channelInApp"
                              : "Shared.notifications.preferences.channelEmail"
                          ),
                        })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!emailEnabled ? (
          <p className="mt-3 text-xs text-tertiary">
            {t("Shared.notifications.preferences.emailUnavailableHint")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

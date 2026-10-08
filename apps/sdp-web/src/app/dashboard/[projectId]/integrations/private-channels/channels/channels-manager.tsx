"use client";

import type { PrivateChannelDto } from "@sdp/types";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { createChannelAction, deleteChannelAction } from "./actions";

interface Props {
  initialChannels: PrivateChannelDto[];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function ChannelsManager({ initialChannels }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isCreating, startCreate] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const t = useTranslations();

  const channels = initialChannels;

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t("DashboardPrivateChannels.channels.nameRequired"));
      return;
    }
    startCreate(async () => {
      const result = await createChannelAction({ name: trimmed, description });
      if (result.ok) {
        toast.success(
          t("DashboardPrivateChannels.channels.createSuccess", { name: result.channel.name })
        );
        setName("");
        setDescription("");
      } else {
        toast.error(result.message);
      }
    });
  }

  function handleDelete(channel: PrivateChannelDto) {
    setDeletingId(channel.id);
    startCreate(async () => {
      const result = await deleteChannelAction(channel.id);
      if (result.ok) {
        toast.success(t("DashboardPrivateChannels.channels.deleteSuccess", { name: channel.name }));
      } else {
        toast.error(result.message);
      }
      setDeletingId(null);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg border border-border-default p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="channel-name">{t("DashboardPrivateChannels.channels.newChannel")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="channel-name"
              placeholder={t("DashboardPrivateChannels.channels.namePlaceholder")}
              value={name}
              maxLength={64}
              disabled={isCreating}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
            <Input
              placeholder={t("DashboardPrivateChannels.channels.descriptionPlaceholder")}
              value={description}
              disabled={isCreating}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
            <Button onClick={handleCreate} disabled={isCreating || !name.trim()}>
              {isCreating && !deletingId ? <Loader2Icon className="animate-spin" /> : null}
              {t("DashboardPrivateChannels.channels.add")}
            </Button>
          </div>
        </div>
      </div>

      {channels.length === 0 ? (
        <p className="text-sm text-secondary">{t("DashboardPrivateChannels.channels.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
          {channels.map((channel) => (
            <li key={channel.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{channel.name}</span>
                  {channel.isDefault ? (
                    <Badge variant="info">
                      {t("DashboardPrivateChannels.channels.defaultBadge")}
                    </Badge>
                  ) : null}
                </div>
                {channel.description ? (
                  <span className="truncate text-sm text-secondary">{channel.description}</span>
                ) : null}
                <span className="text-xs text-secondary">
                  {t("DashboardPrivateChannels.channels.created", {
                    date: formatDate(channel.createdAt),
                  })}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("DashboardPrivateChannels.channels.deleteAria", {
                  name: channel.name,
                })}
                disabled={channel.isDefault || isCreating}
                title={
                  channel.isDefault
                    ? t("DashboardPrivateChannels.channels.deleteDefaultTitle")
                    : t("DashboardPrivateChannels.channels.deleteTitle")
                }
                onClick={() => handleDelete(channel)}
              >
                {deletingId === channel.id ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <Trash2Icon />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

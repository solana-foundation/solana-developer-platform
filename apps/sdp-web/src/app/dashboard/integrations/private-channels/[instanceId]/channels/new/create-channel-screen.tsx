"use client";

import type { PrivateChannelInstance } from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { createChannelAction } from "../../../channels/actions";
import { privateChannelPath, privateChannelsInstancePath } from "../../../private-channels-routes";

type InstanceSummary = Pick<PrivateChannelInstance, "gatewayUrl" | "escrowInstanceAddr">;

function shorten(value: string): string {
  return value.length > 19 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

export function CreateChannelScreen({
  instanceId,
  instance,
}: {
  instanceId: string;
  instance: InstanceSummary;
}) {
  const router = useRouter();
  const t = useTranslations();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isCreating, startCreating] = useTransition();

  function submit() {
    const trimmedName = name.trim();
    if (!trimmedName || isCreating) return;

    startCreating(async () => {
      const result = await createChannelAction({ name: trimmedName, description });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(
        t("DashboardPrivateChannels.channels.createSuccess", { name: result.channel.name })
      );
      router.push(privateChannelPath(instanceId, result.channel.id));
    });
  }

  return (
    <div className="-mx-3 -mt-6 -mb-20 flex min-h-0 flex-1 md:-mx-6 xl:-mb-6">
      <WizardFrame
        steps={[
          {
            label: t("DashboardPrivateChannels.directory.createStepLabel"),
            title: t("DashboardPrivateChannels.directory.createDetailsTitle"),
          },
        ]}
        currentStep={0}
        progressLabel={t("DashboardPrivateChannels.directory.createStepProgress")}
        description={t("DashboardPrivateChannels.directory.createDescription")}
        maxWidthClassName="max-w-3xl"
        footer={
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push(privateChannelsInstancePath(instanceId))}
              disabled={isCreating}
            >
              {t("DashboardPrivateChannels.common.cancel")}
            </Button>
            <Button
              className="min-w-40"
              disabled={isCreating || !name.trim()}
              iconLeft={isCreating ? <Loader2Icon className="size-4 animate-spin" /> : undefined}
              onClick={submit}
              type="button"
            >
              {t("DashboardPrivateChannels.directory.createChannel")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-8 px-1 py-1">
          <section className="space-y-3" aria-labelledby="channel-connection-title">
            <h2 id="channel-connection-title" className="text-sm font-medium text-primary">
              {t("DashboardPrivateChannels.directory.createConnectionTitle")}
            </h2>
            <dl className="grid gap-px overflow-hidden rounded-xl border border-border-default bg-border-default sm:grid-cols-2">
              <div className="min-w-0 bg-surface-raised p-4">
                <dt className="text-xs text-tertiary">
                  {t("DashboardPrivateChannels.instance.gatewayUrl")}
                </dt>
                <dd className="mt-1 truncate text-sm text-primary" title={instance.gatewayUrl}>
                  {instance.gatewayUrl}
                </dd>
              </div>
              <div className="min-w-0 bg-surface-raised p-4">
                <dt className="text-xs text-tertiary">
                  {t("DashboardPrivateChannels.instance.escrowInstanceAddr")}
                </dt>
                <dd
                  className="mt-1 truncate text-sm text-primary"
                  title={instance.escrowInstanceAddr}
                >
                  {shorten(instance.escrowInstanceAddr)}
                </dd>
              </div>
            </dl>
          </section>
          <form
            className="grid gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="private-channel-name">
                {t("DashboardPrivateChannels.directory.channelName")}
              </Label>
              <Input
                autoFocus
                disabled={isCreating}
                id="private-channel-name"
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("DashboardPrivateChannels.channels.namePlaceholder")}
                size="xl"
                value={name}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="private-channel-description">
                {t("DashboardPrivateChannels.directory.channelDescription")}
              </Label>
              <Input
                disabled={isCreating}
                id="private-channel-description"
                maxLength={280}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("DashboardPrivateChannels.channels.descriptionPlaceholder")}
                size="xl"
                value={description}
              />
            </div>
          </form>
        </div>
      </WizardFrame>
    </div>
  );
}

"use client";

import type { PrivateChannelInstance } from "@sdp/types/private-channels";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { PrivateChannelsInstanceGate } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-instance-gate";
import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  usePrivateChannelPrincipals,
  usePrivateChannels,
  usePrivateChannelsCustodyWallets,
  usePrivateChannelTokens,
  usePrivateChannelVerifiedWallets,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import {
  PrivateChannelsFormFieldsSkeleton,
  PrivateChannelsFormSkeleton,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { useTranslations } from "@/i18n/provider";
import { TransferForm } from "./transfer-form";
import {
  createTransferScopeKey,
  intersectEligibleTransferChannels,
  intersectVerifiedSourceWallets,
} from "./transfer-page-data";

function TransferSources({ instance }: { instance: PrivateChannelInstance }) {
  const principals = usePrivateChannelPrincipals(true);
  const channels = usePrivateChannels(true);
  const custody = usePrivateChannelsCustodyWallets();
  const verified = usePrivateChannelVerifiedWallets();
  const tokens = usePrivateChannelTokens(true);

  if (
    principals.data !== undefined &&
    channels.data !== undefined &&
    custody.data !== undefined &&
    verified.data !== undefined &&
    tokens.data !== undefined
  ) {
    const defaultPrincipal = principals.data.find((principal) => principal.isDefault);
    return (
      <TransferForm
        channels={intersectEligibleTransferChannels(
          defaultPrincipal?.channels ?? [],
          channels.data
        )}
        scopeKey={createTransferScopeKey(instance.organizationId, instance.projectId, instance.id)}
        sourceWallets={intersectVerifiedSourceWallets(custody.data, verified.data)}
        tokens={tokens.data.filter((token) => token.enabled)}
      />
    );
  }
  const reads = [principals, channels, custody, verified, tokens];
  const failed = reads.find((read) => read.data === undefined && read.error !== undefined);
  if (failed === undefined) {
    return <PrivateChannelsFormFieldsSkeleton />;
  }
  return (
    <PrivateChannelsLoadError
      message={failed.error?.message}
      onRetry={() => {
        for (const read of reads) if (read.error !== undefined) void read.mutate();
      }}
    />
  );
}

export function TransferSection() {
  const t = useTranslations();
  return (
    <PrivateChannelsInstanceGate match="active" skeleton={<PrivateChannelsFormSkeleton />}>
      {(instance) => (
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <CardHeader>
              <CardTitle>{t("DashboardPrivateChannels.transfer.title")}</CardTitle>
              <CardDescription>
                {t("DashboardPrivateChannels.transfer.description")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TransferSources instance={instance} />
            </CardContent>
          </Card>
        </div>
      )}
    </PrivateChannelsInstanceGate>
  );
}

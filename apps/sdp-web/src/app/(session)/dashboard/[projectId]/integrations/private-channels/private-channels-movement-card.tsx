"use client";

import type { PrivateChannelTokenEligibility } from "@sdp/types/private-channels";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import type { ReactNode } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { PrivateChannelsInstanceGate } from "./private-channels-instance-gate";
import { PrivateChannelsLoadError } from "./private-channels-load-error";
import {
  type PrivateChannelsCustodyWallet,
  usePrivateChannelsCustodyWallets,
  usePrivateChannelTokens,
  usePrivateChannelVerifiedWallets,
} from "./private-channels-reads";
import {
  PrivateChannelsFormFieldsSkeleton,
  PrivateChannelsFormSkeleton,
} from "./private-channels-route-skeletons";

/**
 * Custody wallets SDP can sign from AND that are SPC-verified, with the instance's enabled
 * tokens. Verification is required either way: an unverified wallet can't burn or receive
 * channel credit, so offering it would only produce a rejected intent.
 */
function MovementSources({
  children,
}: {
  children: (
    wallets: PrivateChannelsCustodyWallet[],
    tokens: PrivateChannelTokenEligibility[]
  ) => ReactNode;
}) {
  const verified = usePrivateChannelVerifiedWallets();
  const custody = usePrivateChannelsCustodyWallets();
  const tokens = usePrivateChannelTokens(true);
  const reads = [verified, custody, tokens];
  if (verified.data !== undefined && custody.data !== undefined && tokens.data !== undefined) {
    const verifiedIds = new Set(verified.data.map((wallet) => wallet.walletId));
    return children(
      custody.data.filter((wallet) => verifiedIds.has(wallet.walletId)),
      tokens.data.filter((token) => token.enabled)
    );
  }
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

/** A deposit or withdrawal page: needs an active instance, then its wallets and tokens. */
export function PrivateChannelsMovementCard({
  titleKey,
  descriptionKey,
  children,
}: {
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  children: (
    wallets: PrivateChannelsCustodyWallet[],
    tokens: PrivateChannelTokenEligibility[]
  ) => ReactNode;
}) {
  const t = useTranslations();
  return (
    <PrivateChannelsInstanceGate match="active" skeleton={<PrivateChannelsFormSkeleton />}>
      {() => (
        <div className="mx-auto w-full max-w-2xl">
          <Card>
            <CardHeader>
              <CardTitle>{t(titleKey)}</CardTitle>
              <CardDescription>{t(descriptionKey)}</CardDescription>
            </CardHeader>
            <CardContent>
              <MovementSources>{children}</MovementSources>
            </CardContent>
          </Card>
        </div>
      )}
    </PrivateChannelsInstanceGate>
  );
}

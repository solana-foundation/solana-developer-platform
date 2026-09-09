"use client";

import type { PrivateChannelInstance } from "@sdp/types";
import {
  ChevronDownIcon,
  Settings2Icon,
  Trash2Icon,
  UnplugIcon,
  WalletCardsIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslations } from "@/i18n/provider";
import {
  PRIVATE_CHANNELS_INTEGRATION_PATH,
  privateChannelsInstancePath,
} from "../../../private-channels-routes";
import { deletePrivateChannelAction, disconnectPrivateChannelAction } from "../../../setup/actions";
import {
  DeleteConfirmationDialog,
  PrivateChannelsConnectForm,
} from "../../../setup/private-channels-connect-form";

export function ChannelActionsMenu({
  instance,
  enrollTriggerId,
  canEnrollWallet,
  enrollDisabledReason,
}: {
  instance: PrivateChannelInstance;
  enrollTriggerId: string;
  canEnrollWallet: boolean;
  enrollDisabledReason: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [manageOpen, setManageOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDisconnecting, startDisconnecting] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const busy = isDisconnecting || isDeleting;

  function disconnect() {
    startDisconnecting(async () => {
      const result = await disconnectPrivateChannelAction();
      if (result.ok) {
        toast.success(t("DashboardPrivateChannels.instance.disconnectSuccess"));
        router.replace(privateChannelsInstancePath(result.instance.id));
      } else {
        toast.error(result.message);
      }
    });
  }

  function deleteConnection() {
    startDeleting(async () => {
      const result = await deletePrivateChannelAction();
      if (result.ok) {
        setDeleteOpen(false);
        toast.success(t("DashboardPrivateChannels.instance.deleteSuccess"));
        router.push(PRIVATE_CHANNELS_INTEGRATION_PATH);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="whitespace-nowrap"
            iconRight={<ChevronDownIcon className="size-4" />}
            disabled={busy}
          >
            {t("DashboardPrivateChannels.channelDetail.actions")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setManageOpen(true)}>
            <Settings2Icon className="size-4" />
            {t("DashboardPrivateChannels.channelDetail.manageConnection")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {canEnrollWallet ? (
            <DropdownMenuItem onSelect={() => document.getElementById(enrollTriggerId)?.click()}>
              <WalletCardsIcon className="size-4" />
              {t("DashboardPrivateChannels.channelDetail.enrollWallet")}
            </DropdownMenuItem>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="block cursor-not-allowed">
                    <DropdownMenuItem disabled className="pointer-events-none">
                      <WalletCardsIcon className="size-4" />
                      {t("DashboardPrivateChannels.channelDetail.enrollWallet")}
                    </DropdownMenuItem>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">{enrollDisabledReason}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!instance.isActive || busy} onSelect={disconnect}>
            <UnplugIcon className="size-4" />
            {t("DashboardPrivateChannels.channelDetail.disconnectInstance")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-error focus:text-error [&_svg]:text-error"
            disabled={busy}
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2Icon className="size-4" />
            {t("DashboardPrivateChannels.channelDetail.deleteConnection")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Modal
        isOpen={manageOpen}
        ariaLabel={t("DashboardPrivateChannels.instance.setupDetailsTitle")}
        onClose={() => setManageOpen(false)}
        size="xl"
      >
        <div className="space-y-6 p-6">
          <div className="space-y-2 pr-8">
            <h2 className="text-xl font-medium text-primary">
              {t("DashboardPrivateChannels.instance.setupDetailsTitle")}
            </h2>
            <p className="text-sm leading-6 text-secondary">
              {t("DashboardPrivateChannels.instance.setupDetailsDescription")}
            </p>
          </div>
          <PrivateChannelsConnectForm
            initialInstance={instance}
            stayOnPageAfterConnect
            showTestAction={false}
            onSuccess={() => setManageOpen(false)}
          />
        </div>
      </Modal>

      <DeleteConfirmationDialog
        isOpen={deleteOpen}
        working={isDeleting}
        gatewayUrl={instance.gatewayUrl}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={deleteConnection}
      />
    </>
  );
}

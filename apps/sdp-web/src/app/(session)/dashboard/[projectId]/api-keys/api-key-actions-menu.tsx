"use client";

import { Button } from "@sdp/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { Modal } from "@sdp/ui/modal";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { memberReads } from "@/app/(session)/dashboard/[projectId]/settings/members-query-key";
import { useTranslations } from "@/i18n/provider";
import { useInvalidateDashboardReads } from "@/lib/dashboard-swr";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { rotateApiKeyAction } from "./actions";
import { apiKeyReads } from "./api-keys-query-key";
import { DeleteApiKeyModal } from "./delete-api-key-modal";

const DEFAULT_ROTATION_GRACE_HOURS = 24;

interface ApiKeyActionsMenuProps {
  keyId: string;
  keyName: string;
  canRotate: boolean;
  onDeleted?: () => void;
}

export function ApiKeyActionsMenu({
  keyId,
  keyName,
  canRotate,
  onDeleted,
}: ApiKeyActionsMenuProps) {
  const t = useTranslations();
  const router = useRouter();
  const href = useProjectHref();
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isRotateModalOpen, setIsRotateModalOpen] = useState(false);
  const rotateFormRef = useRef<HTMLFormElement | null>(null);

  return (
    <>
      <form ref={rotateFormRef} action={rotateApiKeyAction} className="hidden">
        <input type="hidden" name="keyId" value={keyId} />
        <input type="hidden" name="grace" value={String(DEFAULT_ROTATION_GRACE_HOURS)} />
        <RotationSettledWatcher />
      </form>

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full px-5 whitespace-nowrap"
            iconRight={<ChevronDown className="size-4" />}
          >
            {t("DashboardCustody.actions")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px]">
          <DropdownMenuItem
            onSelect={() =>
              router.push(href(`/dashboard/api-keys/${encodeURIComponent(keyId)}/edit`))
            }
          >
            {t("DashboardCustody.editApiKey")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              if (canRotate) {
                setIsRotateModalOpen(true);
              }
            }}
            disabled={!canRotate}
          >
            {t("DashboardCustody.rotateKey", { hours: DEFAULT_ROTATION_GRACE_HOURS })}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={() => setIsDeleteModalOpen(true)}
          >
            {t("DashboardCustody.deleteKey")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Modal
        isOpen={isRotateModalOpen}
        onClose={() => setIsRotateModalOpen(false)}
        ariaLabel={t("DashboardCustody.rotateApiKeyTitle", { name: keyName })}
        closeLabel={t("DashboardCustody.closeConfirmationModal")}
        contentClassName="rounded-xl p-5 text-left"
        size="sm"
      >
        <p className="pr-10 text-sm font-medium text-primary">
          {t("DashboardCustody.rotateApiKeyTitle", { name: keyName })}
        </p>
        <p className="mt-2 text-sm text-secondary">
          {t("DashboardCustody.rotateApiKeyDescription", {
            hours: DEFAULT_ROTATION_GRACE_HOURS,
          })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setIsRotateModalOpen(false)}>
            {t("DashboardCustody.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setIsRotateModalOpen(false);
              rotateFormRef.current?.requestSubmit();
            }}
          >
            {t("DashboardCustody.rotateApiKeyConfirm")}
          </Button>
        </div>
      </Modal>

      <DeleteApiKeyModal
        keyId={keyId}
        keyName={keyName}
        open={isDeleteModalOpen}
        onOpenChange={setIsDeleteModalOpen}
        onDeleted={onDeleted}
        renderTrigger={() => null}
      />
    </>
  );
}

// The rotation is a form action that answers with a redirect, so there is no success callback:
// once its submission settles, the keys it replaced are re-read.
function RotationSettledWatcher() {
  const { pending } = useFormStatus();
  const invalidateReads = useInvalidateDashboardReads();
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) {
      void invalidateReads(apiKeyReads);
      void invalidateReads(memberReads);
    }
    wasPending.current = pending;
  }, [pending, invalidateReads]);
  return null;
}

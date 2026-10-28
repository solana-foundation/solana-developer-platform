"use client";

import { Button } from "@sdp/ui/button";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { z } from "zod";
import {
  LinkedPaymentsNotice,
  type LinkedPaymentsState,
} from "@/components/linked-payments-notice";
import { useTranslations } from "@/i18n/provider";
import { useProjectId } from "@/lib/use-dashboard-project";
import { useZodForm } from "@/lib/use-zod-form";
import { deactivateApiKeyInlineAction, loadApiKeyLinkedPaymentsAction } from "./actions";
import { apiKeysQueryKeys } from "./api-keys-query-key";

interface DeleteApiKeyModalProps {
  keyId: string;
  keyName: string;
  renderTrigger?: (open: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDeleted?: () => void;
}

const deleteApiKeyFormSchema = z.object({
  confirmation: z.string(),
});

/**
 * What the key set up in this project that keeps running after it is deleted, read once each
 * time the dialog opens.
 *
 * @param keyId - The key about to be deleted.
 * @returns The read, as the notice renders it.
 */
function useApiKeyLinkedPayments(keyId: string): LinkedPaymentsState {
  const projectId = useProjectId();
  const { data } = useSWR(
    apiKeysQueryKeys.linkedPayments(keyId),
    ([, id]: readonly [string, string]) => loadApiKeyLinkedPaymentsAction(id),
    { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false }
  );
  if (data === undefined) {
    return { status: "loading" };
  }
  if (!data.ok) {
    return { status: "error", message: data.message };
  }
  return {
    status: "loaded",
    filter: { kind: "api_key", apiKeyId: keyId },
    projects: [
      {
        projectId,
        projectName: null,
        activeRecurringPayments: data.activeRecurringPayments,
        openPaymentRequests: data.openPaymentRequests,
      },
    ],
  };
}

export function DeleteApiKeyModal({
  keyId,
  keyName,
  renderTrigger,
  open: isOpenProp,
  onOpenChange,
  onDeleted,
}: DeleteApiKeyModalProps) {
  const t = useTranslations();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isControlled = isOpenProp !== undefined;
  const isOpen = isControlled ? isOpenProp : uncontrolledOpen;

  const openModal = () => {
    if (isControlled) {
      onOpenChange?.(true);
      return;
    }

    setUncontrolledOpen(true);
  };

  const close = () => {
    if (isControlled) {
      onOpenChange?.(false);
      return;
    }

    setUncontrolledOpen(false);
  };

  return (
    <>
      {renderTrigger ? (
        renderTrigger(openModal)
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="border-destructive text-destructive hover:bg-destructive/10"
          onClick={openModal}
        >
          {t("DashboardCustody.delete")}
        </Button>
      )}

      <Modal
        isOpen={isOpen}
        onClose={close}
        ariaLabel={t("DashboardCustody.deleteApiKey")}
        closeLabel={t("DashboardCustody.closeConfirmationModal")}
        closeDisabled={isSubmitting}
        contentClassName="rounded-xl p-5 text-left"
        size="sm"
      >
        <p className="pr-10 text-sm font-medium text-primary">
          {t("DashboardCustody.deleteApiKey")}
        </p>
        <p className="mt-2 text-sm text-secondary">
          {t("DashboardCustody.deleteApiKeyDescription")}
        </p>
        <p className="mt-2 text-sm">
          {t("DashboardCustody.typeKeyNameToConfirm", { name: keyName })}
        </p>

        {/* The modal unmounts its content while closed, so each open starts a fresh form. */}
        <DeleteApiKeyForm
          keyId={keyId}
          keyName={keyName}
          isSubmitting={isSubmitting}
          onSubmittingChange={setIsSubmitting}
          onCancel={close}
          onDeleted={() => {
            close();
            onDeleted?.();
          }}
        />
      </Modal>
    </>
  );
}

function DeleteApiKeyForm({
  keyId,
  keyName,
  isSubmitting,
  onSubmittingChange,
  onCancel,
  onDeleted,
}: {
  keyId: string;
  keyName: string;
  isSubmitting: boolean;
  onSubmittingChange: (submitting: boolean) => void;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations();
  const form = useZodForm(deleteApiKeyFormSchema, {
    confirmation: "",
  });
  const linkedPayments = useApiKeyLinkedPayments(keyId);
  const canSubmit = form.values.confirmation.trim() === keyName.trim();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = form.validate();
    if (!parsed.ok || !canSubmit || isSubmitting) {
      return;
    }

    onSubmittingChange(true);
    const toastId = toast.loading(t("DashboardCustody.deleting"), {
      position: "bottom-right",
    });

    const result = await deactivateApiKeyInlineAction({
      keyId,
      keyName,
      confirmation: parsed.data.confirmation,
    }).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : t("DashboardCustody.deleteApiKey"),
    }));

    onSubmittingChange(false);
    if (result.ok) {
      toast.success(result.message, { id: toastId, position: "bottom-right" });
      onDeleted();
      return;
    }

    toast.error(result.message, { id: toastId, position: "bottom-right" });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <input type="hidden" name="keyId" value={keyId} />
      <input type="hidden" name="keyName" value={keyName} />
      <Label htmlFor={`confirm-${keyId}`} className="text-sm">
        {t("DashboardCustody.confirmKeyName")}
      </Label>
      <Input
        id={`confirm-${keyId}`}
        name="confirmation"
        value={form.values.confirmation}
        onChange={(event) => form.setField("confirmation", event.currentTarget.value)}
        placeholder={t("DashboardCustody.deleteApiKeyPlaceholder")}
        autoFocus
        autoComplete="off"
        disabled={isSubmitting}
      />

      <LinkedPaymentsNotice subject="api_key" state={linkedPayments} />

      <DeleteApiKeyFormActions
        canSubmit={canSubmit}
        onCancel={onCancel}
        isSubmitting={isSubmitting}
        t={t}
      />
    </form>
  );
}

function DeleteApiKeyFormActions({
  canSubmit,
  onCancel,
  isSubmitting,
  t,
}: {
  canSubmit: boolean;
  onCancel: () => void;
  isSubmitting: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
        {t("DashboardCustody.cancel")}
      </Button>
      <Button
        type="submit"
        variant="destructive"
        disabled={!canSubmit || isSubmitting}
        aria-busy={isSubmitting}
        className="min-w-[104px]"
      >
        {isSubmitting ? t("DashboardCustody.deleting") : t("DashboardCustody.deleteKey")}
      </Button>
    </div>
  );
}

"use client";

import { SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import { ORGANIZATION_ROLES, type OrganizationRole } from "@sdp/types/roles";
import { Button } from "@sdp/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { Modal } from "@sdp/ui/modal";
import { MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { z } from "zod";
import { API_KEYS_PAGE_PATH } from "@/app/(session)/dashboard/[projectId]/api-keys/api-key-flash";
import { RecordFacts } from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import { EntityLink } from "@/components/entity-link";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { projectHref } from "@/lib/dashboard-project-path";
import { refreshKeepingDashboardUrl } from "@/lib/dashboard-url-state";
import { fetchResultAnswer, IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { useActionIdempotencyKey } from "@/lib/use-action-idempotency-key";
import { membersQueryKeys } from "./members-query-key";

const memberApiKeysSchema = z.object({
  apiKeys: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      keyPrefix: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      environment: z.enum(SDP_ENVIRONMENTS),
      createdAt: z.string(),
    })
  ),
});

type MemberApiKey = z.infer<typeof memberApiKeysSchema>["apiKeys"][number];

function memberPath(memberId: string): string {
  return `/api/dashboard/members/${encodeURIComponent(memberId)}`;
}

async function fetchMemberApiKeys(memberId: string): Promise<MemberApiKey[]> {
  const result = await dashboardFetch(`${memberPath(memberId)}/api-keys`);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return z.object({ data: memberApiKeysSchema }).parse(result.data).data.apiKeys;
}

export function MemberActions({
  memberId,
  label,
  role,
  isSelf,
  isLastAdmin,
}: {
  memberId: string;
  label: string;
  role: OrganizationRole;
  isSelf: boolean;
  isLastAdmin: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [isConfirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // One key per change, kept across its retries (a retry after a failed Clerk
  // call finishes the same request) and retired by the answer that settles it.
  const actionKey = useActionIdempotencyKey(null);
  const nextRoles = ORGANIZATION_ROLES.filter((candidate) => candidate !== role);
  const makeRoleLabel = {
    admin: t("Shared.members.makeAdmin"),
    member: t("Shared.members.makeMember"),
    viewer: t("Shared.members.makeViewer"),
  } as const satisfies Record<OrganizationRole, string>;

  const blockedRoleReasonFor = (nextRole: OrganizationRole): string | null => {
    if (isSelf) {
      return t("Shared.members.cannotChangeOwnRole");
    }
    if (nextRole !== "admin" && isLastAdmin) {
      return t("Shared.members.cannotDemoteLastAdmin");
    }
    return null;
  };

  const confirmRoleChange = (nextRole: OrganizationRole) => {
    const input = JSON.stringify(["role", memberId, nextRole]);
    startTransition(async () => {
      const key = actionKey.keyFor(input);
      const result = await dashboardFetch(memberPath(memberId), {
        method: "PATCH",
        headers: { [IDEMPOTENCY_KEY_HEADER]: key },
        body: { role: nextRole },
      });
      actionKey.settled(input, key, {
        status: result.ok ? "success" : "error",
        answer: fetchResultAnswer(result),
      });
      if (!result.ok) {
        toast.error(t("Shared.members.roleChangeFailed", { error: result.error }));
        return;
      }
      toast.success(t("Shared.members.roleChanged", { member: label }));
      refreshKeepingDashboardUrl(router);
    });
  };

  // The API rejects both of these; disabling the row menu means the rule is
  // visible before someone commits to a destructive action rather than after.
  let blockedReason: string | null = null;
  if (isSelf) {
    blockedReason = t("Shared.members.cannotRemoveSelf");
  } else if (isLastAdmin) {
    blockedReason = t("Shared.members.cannotRemoveLastAdmin");
  }

  // Removal waits for the member's key list, so no admin confirms before
  // seeing which keys survive; a failed read turns the button into an
  // explicit "remove anyway". SWR reads it again on focus, after a revoke.
  const { data: apiKeys, error: apiKeysError } = useSWR(
    isConfirmOpen ? membersQueryKeys.memberApiKeys({ memberId }) : null,
    ([, id]) => fetchMemberApiKeys(id)
  );
  const isApiKeysLoading = isConfirmOpen && !apiKeys && !apiKeysError;
  const isApiKeysFailed = !apiKeys && Boolean(apiKeysError);
  const removeLabel = isApiKeysFailed
    ? t("Shared.members.removeAnyway")
    : t("Shared.members.removeMember");

  const confirmRemove = () => {
    const input = JSON.stringify(["remove", memberId]);
    startTransition(async () => {
      const key = actionKey.keyFor(input);
      const result = await dashboardFetch(memberPath(memberId), {
        method: "DELETE",
        headers: { [IDEMPOTENCY_KEY_HEADER]: key },
      });
      actionKey.settled(input, key, {
        status: result.ok ? "success" : "error",
        answer: fetchResultAnswer(result),
      });

      if (!result.ok) {
        toast.error(t("Shared.members.removeFailed", { error: result.error }));
        return;
      }

      setConfirmOpen(false);
      toast.success(t("Shared.members.removed", { member: label }));
      refreshKeepingDashboardUrl(router);
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={isPending}
            aria-label={t("Shared.members.memberActions", { member: label })}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {nextRoles.map((nextRole) => {
            const blockedRoleReason = blockedRoleReasonFor(nextRole);
            return (
              <DropdownMenuItem
                key={nextRole}
                disabled={isPending || Boolean(blockedRoleReason)}
                onSelect={() => confirmRoleChange(nextRole)}
              >
                {blockedRoleReason ?? makeRoleLabel[nextRole]}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem
            disabled={isPending || Boolean(blockedReason)}
            onSelect={() => setConfirmOpen(true)}
          >
            {blockedReason ?? t("Shared.members.removeMember")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Modal
        isOpen={isConfirmOpen}
        ariaLabel={t("Shared.members.removeMember")}
        onClose={() => setConfirmOpen(false)}
        closeDisabled={isPending}
        size="sm"
      >
        <div className="space-y-4 p-6">
          <h2 className="font-medium text-lg text-primary">{t("Shared.members.removeMember")}</h2>
          <p className="text-secondary text-sm">
            {t("Shared.members.removeConfirm", { member: label })}
          </p>
          {isApiKeysLoading ? (
            <p className="text-secondary text-sm">{t("Shared.members.apiKeysLoading")}</p>
          ) : null}
          {isApiKeysFailed ? (
            <p className="text-secondary text-sm">{t("Shared.members.apiKeysLoadFailed")}</p>
          ) : null}
          {apiKeys && apiKeys.length > 0 ? <MemberApiKeys apiKeys={apiKeys} label={label} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={isPending}>
              {t("Shared.members.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmRemove}
              disabled={isApiKeysLoading}
              loading={isPending}
            >
              {removeLabel}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/**
 * The member's active keys, which the removal leaves working. Each links to
 * its own project's key page, in a new tab so this dialog stays open.
 */
function MemberApiKeys({ apiKeys, label }: { apiKeys: MemberApiKey[]; label: string }) {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <p className="text-secondary text-sm">
        {t("Shared.members.apiKeysStayActive", { member: label })}
      </p>
      <ul className="divide-y divide-border-subtle rounded-md border border-border-default text-sm">
        {apiKeys.map((apiKey) => (
          <li key={apiKey.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-primary">{apiKey.name}</p>
              <p className="text-tertiary text-xs">
                <RecordFacts facts={[`${apiKey.keyPrefix}…`, apiKey.projectName]} />
              </p>
            </div>
            <EntityLink
              href={projectHref(apiKey.projectId, API_KEYS_PAGE_PATH)}
              target="_blank"
              className="shrink-0"
            >
              {t("Shared.members.revokeApiKey")}
            </EntityLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

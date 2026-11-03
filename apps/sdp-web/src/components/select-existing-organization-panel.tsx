"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { cn } from "@sdp/ui/cn";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CreateOrganizationForm } from "@/components/create-organization-form";
import { useTranslations } from "@/i18n/provider";

function OrganizationMark({ name, imageUrl }: { name: string; imageUrl?: string }) {
  if (imageUrl) {
    return (
      <Image
        src={imageUrl}
        alt=""
        width={36}
        height={36}
        unoptimized
        className="size-8 rounded-control-inner object-cover"
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-control-inner bg-primary text-meta font-medium text-on-primary"
    >
      {name.trim().slice(0, 2).toUpperCase() || "?"}
    </span>
  );
}

const ENTRY_ROW_CLASS =
  "flex min-h-12 w-full items-center gap-3 rounded-control bg-fill px-3 py-2 text-body text-primary transition-colors hover:bg-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50";

type EntryState = "no-access" | "no-access-create" | "create" | "select";

function resolveEntryState(params: {
  refused: boolean;
  isLoaded: boolean;
  hasChoices: boolean;
}): EntryState {
  const create = params.isLoaded && !params.hasChoices;
  if (params.refused) return create ? "no-access-create" : "no-access";
  return create ? "create" : "select";
}

function entryCopy(
  state: EntryState,
  refusedName: string | null,
  t: ReturnType<typeof useTranslations>
): { title: string; description: string } {
  switch (state) {
    case "no-access":
    case "no-access-create":
      return {
        title: refusedName
          ? t("Shared.SharedComponents.noNamedOrganizationAccessTitle", {
              organization: refusedName,
            })
          : t("Shared.SharedComponents.noOrganizationAccessTitle"),
        description:
          state === "no-access"
            ? t("Shared.SharedComponents.noOrganizationAccessDescription")
            : t("Shared.SharedComponents.noOrganizationAccessCreateDescription"),
      };
    case "create":
      return {
        title: t("Shared.SharedComponents.createOrganizationTitle"),
        description: t("Shared.SharedComponents.createOrganizationDescription"),
      };
    case "select":
      return {
        title: t("Shared.SharedComponents.selectOrganization"),
        description: t("Shared.SharedComponents.selectExistingOrganizationDescription"),
      };
    default: {
      const exhaustive: never = state;
      throw new Error(`Unknown entry state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Entry state for a signed-in person whose session has no organization SDP
 * admits: their organizations to pick from, their pending invitations to
 * accept, or, with neither, the step that creates their organization in SDP
 * (ADR 0012). With `refusedOrganizationId`, the session's organization is one
 * SDP refused, so the same choices are offered under that explanation.
 *
 * A choice SDP refuses comes back as a new render of this same panel, so the
 * panel stays mounted: every organization refused while it is open stays out
 * of the list, and a switch holds the list until the server's answer lands.
 *
 * @param props.refusedOrganizationId - The session's Clerk organization when
 *   SDP refused it, or null when the session has none.
 */
export function SelectExistingOrganizationPanel({
  refusedOrganizationId,
}: {
  refusedOrganizationId: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { userMemberships, userInvitations, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
    userInvitations: { infinite: true },
  });
  const { organization: activeOrganization } = useOrganization();
  // Pending from the click until the refreshed server render commits, so the
  // list is never usable mid-switch and never stays disabled after a refusal.
  const [isSwitching, startSwitch] = useTransition();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [refusedIds, setRefusedIds] = useState<readonly string[]>(
    refusedOrganizationId === null ? [] : [refusedOrganizationId]
  );
  if (refusedOrganizationId !== null && !refusedIds.includes(refusedOrganizationId)) {
    setRefusedIds([...refusedIds, refusedOrganizationId]);
  }
  const allMemberships = userMemberships.data ?? [];
  const memberships = allMemberships.filter(
    (membership) => !refusedIds.includes(membership.organization.id)
  );
  const invitations = (userInvitations.data ?? []).filter(
    (invitation) => !refusedIds.includes(invitation.publicOrganizationData.id)
  );
  // Clerk switches the client's active organization before the server's answer
  // lands, so the refused name is looked up by id rather than read from it.
  const refusedName =
    refusedOrganizationId === null
      ? null
      : (allMemberships.find((membership) => membership.organization.id === refusedOrganizationId)
          ?.organization.name ??
        (activeOrganization?.id === refusedOrganizationId ? activeOrganization.name : null));
  const copy = entryCopy(
    resolveEntryState({
      refused: refusedOrganizationId !== null,
      isLoaded,
      hasChoices: memberships.length > 0 || invitations.length > 0,
    }),
    refusedName,
    t
  );

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-heading font-medium text-primary">{copy.title}</h1>
        <p className="text-body text-secondary">{copy.description}</p>
      </div>

      <div
        className="flex flex-col gap-2"
        aria-busy={isSwitching || !isLoaded || userMemberships.isFetching}
      >
        {!isLoaded ? (
          <div className="flex items-center gap-2 text-body text-secondary">
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            {t("Shared.SharedComponents.loading")}
          </div>
        ) : null}

        {isLoaded && memberships.length === 0 && invitations.length === 0 ? (
          <CreateOrganizationForm />
        ) : null}

        {invitations.map((invitation) => {
          const organization = invitation.publicOrganizationData;
          return (
            <button
              key={invitation.id}
              type="button"
              disabled={!setActive || isSwitching}
              onClick={() => {
                if (!setActive) return;
                setSwitchingTo(organization.id);
                startSwitch(async () => {
                  try {
                    await invitation.accept();
                  } catch {
                    toast.error(t("Shared.SharedComponents.acceptInvitationFailed"));
                    return;
                  }
                  // Accepted: the invitation becomes a membership, so a failed
                  // switch leaves it to pick from the list rather than accept again.
                  try {
                    await Promise.all([userInvitations.revalidate(), userMemberships.revalidate()]);
                    await setActive({ organization: organization.id });
                    router.refresh();
                  } catch {
                    toast.error(t("Shared.SharedComponents.switchOrganizationFailed"));
                  }
                });
              }}
              className={cn(ENTRY_ROW_CLASS, "text-left")}
            >
              <OrganizationMark name={organization.name} imageUrl={organization.imageUrl} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {t("Shared.SharedComponents.acceptInvitation", {
                  organization: organization.name,
                })}
              </span>
              {isSwitching && switchingTo === organization.id ? (
                <LoaderCircleIcon
                  className="size-4 animate-spin text-tertiary"
                  aria-hidden="true"
                />
              ) : (
                <ChevronRightIcon className="size-4 text-tertiary" aria-hidden="true" />
              )}
            </button>
          );
        })}

        {memberships.map((membership) => {
          const organization = membership.organization;

          return (
            <button
              key={organization.id}
              type="button"
              disabled={!setActive || isSwitching}
              onClick={() => {
                if (!setActive) return;
                setSwitchingTo(organization.id);
                startSwitch(async () => {
                  try {
                    await setActive({ organization: organization.id });
                    router.refresh();
                  } catch {
                    // The session keeps its organization, and the list is usable again.
                  }
                });
              }}
              className={cn(ENTRY_ROW_CLASS, "text-left")}
            >
              <OrganizationMark name={organization.name} imageUrl={organization.imageUrl} />
              <span className="min-w-0 flex-1 truncate font-medium">{organization.name}</span>
              {isSwitching && switchingTo === organization.id ? (
                <LoaderCircleIcon
                  className="size-4 animate-spin text-tertiary"
                  aria-hidden="true"
                />
              ) : (
                <ChevronRightIcon className="size-4 text-tertiary" aria-hidden="true" />
              )}
            </button>
          );
        })}

        {isLoaded && (userMemberships.hasNextPage || userInvitations.hasNextPage) ? (
          <button
            type="button"
            disabled={isSwitching || userMemberships.isFetching || userInvitations.isFetching}
            onClick={() => {
              if (userMemberships.hasNextPage) userMemberships.fetchNext();
              if (userInvitations.hasNextPage) userInvitations.fetchNext();
            }}
            className={cn(ENTRY_ROW_CLASS, "justify-center font-medium")}
          >
            {userMemberships.isFetching || userInvitations.isFetching ? (
              <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {t("Shared.SharedComponents.loadMore")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

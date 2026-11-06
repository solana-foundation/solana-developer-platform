"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { cn } from "@sdp/ui/cn";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { CreateOrganizationForm } from "@/components/create-organization-form";
import { useTranslations } from "@/i18n/provider";
import { useUnlinkedOrganizations } from "@/lib/use-unlinked-organizations";

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

/**
 * Why SDP refused the session's organization, as the dashboard layout read it.
 * `unlinked` is an organization this deployment does not know (SDP answers
 * `linked: false`, as for one another deployment created).
 */
export type OrganizationRefusal =
  | "no-access"
  | "invitation-expired"
  | "organization-suspended"
  | "unlinked";

type EntryState =
  | Exclude<OrganizationRefusal, "unlinked">
  | "create"
  | "select"
  | "select-unlinked";

function resolveEntryState(params: {
  refusal: OrganizationRefusal | null;
  isLoaded: boolean;
  hasChoices: boolean;
}): EntryState {
  if (params.refusal !== null && params.refusal !== "unlinked") return params.refusal;
  if (params.isLoaded && !params.hasChoices) return "create";
  if (params.refusal === "unlinked") return "select-unlinked";
  return "select";
}

function entryCopy(
  state: EntryState,
  t: ReturnType<typeof useTranslations>
): { title: string; description: string } {
  switch (state) {
    case "invitation-expired":
      return {
        title: t("Shared.SharedComponents.invitationExpiredTitle"),
        description: t("Shared.SharedComponents.invitationExpiredDescription"),
      };
    case "organization-suspended":
      return {
        title: t("Shared.SharedComponents.organizationSuspendedTitle"),
        description: t("Shared.SharedComponents.organizationSuspendedDescription"),
      };
    case "no-access":
      return {
        title: t("Shared.SharedComponents.noOrganizationAccessTitle"),
        description: t("Shared.SharedComponents.noOrganizationAccessDescription"),
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
    case "select-unlinked":
      return {
        title: t("Shared.SharedComponents.selectOrganization"),
        description: t("Shared.SharedComponents.unlinkedOrganizationDescription"),
      };
    default: {
      const exhaustive: never = state;
      throw new Error(`Unknown entry state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Entry state for a signed-in person with no organization selected for the
 * session: their organizations to pick from, their pending invitations to
 * accept, or, with neither, the step that creates their organization in SDP
 * (ADR 0012). With a `refusal`, the session's organization is one SDP refused
 * or this deployment does not know, so the same choices are offered under that
 * explanation. Organizations this deployment does not link are never offered.
 *
 * @param props.refusal - Why SDP refused the session's organization, or null.
 */
export function SelectExistingOrganizationPanel({
  refusal,
}: {
  refusal: OrganizationRefusal | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { userMemberships, userInvitations, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
    userInvitations: { infinite: true },
  });
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const { organization: activeOrganization } = useOrganization();
  const loadedMemberships = userMemberships.data ?? [];
  const { unlinkedIds, isResolved } = useUnlinkedOrganizations(
    loadedMemberships.map((membership) => membership.organization.id)
  );
  // The organization SDP refused or does not know is no way forward, so it is not offered again.
  const excludedActiveId = refusal === null ? undefined : activeOrganization?.id;
  const memberships = loadedMemberships.filter(
    (membership) =>
      membership.organization.id !== excludedActiveId &&
      !unlinkedIds.has(membership.organization.id)
  );
  const invitations = userInvitations.data ?? [];
  // Rows wait for SDP's answers, so an organization is never offered and then withdrawn.
  const isReady = isLoaded && isResolved;
  const copy = entryCopy(
    resolveEntryState({
      refusal,
      isLoaded: isReady,
      hasChoices: memberships.length > 0 || invitations.length > 0,
    }),
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
        aria-busy={switchingTo !== null || !isReady || userMemberships.isFetching}
      >
        {!isReady ? (
          <div className="flex items-center gap-2 text-body text-secondary">
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            {t("Shared.SharedComponents.loading")}
          </div>
        ) : null}

        {isReady && memberships.length === 0 && invitations.length === 0 ? (
          <CreateOrganizationForm />
        ) : null}

        {(isReady ? invitations : []).map((invitation) => {
          const organization = invitation.publicOrganizationData;
          return (
            <button
              key={invitation.id}
              type="button"
              disabled={!setActive || switchingTo !== null}
              onClick={async () => {
                if (!setActive) return;
                setSwitchingTo(organization.id);
                try {
                  await invitation.accept();
                } catch {
                  setSwitchingTo(null);
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
                  setSwitchingTo(null);
                  toast.error(t("Shared.SharedComponents.switchOrganizationFailed"));
                }
              }}
              className={cn(ENTRY_ROW_CLASS, "text-left")}
            >
              <OrganizationMark name={organization.name} imageUrl={organization.imageUrl} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {t("Shared.SharedComponents.acceptInvitation", {
                  organization: organization.name,
                })}
              </span>
              {switchingTo === organization.id ? (
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

        {(isReady ? memberships : []).map((membership) => {
          const organization = membership.organization;
          const isSwitching = switchingTo === organization.id;

          return (
            <button
              key={organization.id}
              type="button"
              disabled={!setActive || switchingTo !== null}
              onClick={async () => {
                if (!setActive) return;
                setSwitchingTo(organization.id);
                try {
                  await setActive({ organization: organization.id });
                  router.refresh();
                } catch {
                  setSwitchingTo(null);
                }
              }}
              className={cn(ENTRY_ROW_CLASS, "text-left")}
            >
              <OrganizationMark name={organization.name} imageUrl={organization.imageUrl} />
              <span className="min-w-0 flex-1 truncate font-medium">{organization.name}</span>
              {isSwitching ? (
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

        {isReady && (userMemberships.hasNextPage || userInvitations.hasNextPage) ? (
          <button
            type="button"
            disabled={
              switchingTo !== null || userMemberships.isFetching || userInvitations.isFetching
            }
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

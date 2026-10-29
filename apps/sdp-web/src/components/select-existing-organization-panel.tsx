"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
        className="size-9 rounded-lg object-cover"
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="flex size-9 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-on-primary"
    >
      {name.trim().slice(0, 2).toUpperCase() || "?"}
    </span>
  );
}

type EntryState = "no-access" | "create" | "select";

function resolveEntryState(params: {
  noAccess: boolean;
  isLoaded: boolean;
  hasChoices: boolean;
}): EntryState {
  if (params.noAccess) return "no-access";
  if (params.isLoaded && !params.hasChoices) return "create";
  return "select";
}

function entryCopy(
  state: EntryState,
  t: ReturnType<typeof useTranslations>
): { title: string; description: string } {
  switch (state) {
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
 * (ADR 0012). With `noAccess`, the session's organization is one SDP refused,
 * so the same choices are offered under that explanation.
 *
 * @param props.noAccess - Whether SDP refused the session's organization.
 */
export function SelectExistingOrganizationPanel({ noAccess }: { noAccess: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const { userMemberships, userInvitations, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
    userInvitations: { infinite: true },
  });
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const { organization: activeOrganization } = useOrganization();
  // The organization SDP refused is no way forward, so it is not offered again.
  const memberships = (userMemberships.data ?? []).filter(
    (membership) => !noAccess || membership.organization.id !== activeOrganization?.id
  );
  const invitations = userInvitations.data ?? [];
  const copy = entryCopy(
    resolveEntryState({
      noAccess,
      isLoaded,
      hasChoices: memberships.length > 0 || invitations.length > 0,
    }),
    t
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--sdp-shell-bg)] px-4 py-10 text-primary">
      <section className="w-full max-w-md rounded-3xl border border-border-subtle bg-surface-raised p-6 shadow-sm">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium tracking-tight">{copy.title}</h1>
          <p className="text-sm leading-6 text-tertiary">{copy.description}</p>
        </div>

        <div
          className="mt-6 space-y-2"
          aria-busy={switchingTo !== null || !isLoaded || userMemberships.isFetching}
        >
          {!isLoaded ? (
            <div className="flex items-center gap-2 rounded-2xl bg-fill-subtle px-4 py-3 text-sm text-tertiary">
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
                className="flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-raised px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
              >
                <OrganizationMark name={organization.name} imageUrl={organization.imageUrl} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
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

          {memberships.map((membership) => {
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
                className="flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-raised px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
              >
                <OrganizationMark name={organization.name} imageUrl={organization.imageUrl} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {organization.name}
                </span>
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

          {isLoaded && (userMemberships.hasNextPage || userInvitations.hasNextPage) ? (
            <button
              type="button"
              disabled={
                switchingTo !== null || userMemberships.isFetching || userInvitations.isFetching
              }
              onClick={() => {
                if (userMemberships.hasNextPage) userMemberships.fetchNext();
                if (userInvitations.hasNextPage) userInvitations.fetchNext();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border-default px-4 py-3 text-sm font-medium transition-colors hover:border-border-strong hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
            >
              {userMemberships.isFetching || userInvitations.isFetching ? (
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t("Shared.SharedComponents.loadMore")}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

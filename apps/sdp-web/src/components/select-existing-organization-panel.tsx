"use client";

import { useOrganizationList } from "@clerk/nextjs";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { selectProjectAction } from "@/lib/project-cookie-action";

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

/**
 * Entry state for a signed-in user who belongs to an organization but has not
 * selected one for the current Clerk session. It deliberately exposes only
 * existing memberships: organization creation belongs outside SDP.
 */
export function SelectExistingOrganizationPanel() {
  const t = useTranslations();
  const router = useRouter();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const memberships = userMemberships.data ?? [];

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--sdp-shell-bg)] px-4 py-10 text-primary">
      <section className="w-full max-w-md rounded-3xl border border-border-subtle bg-surface-raised p-6 shadow-sm">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium tracking-tight">
            {t("Shared.SharedComponents.selectOrganization")}
          </h1>
          <p className="text-sm leading-6 text-tertiary">
            {t("Shared.SharedComponents.selectExistingOrganizationDescription")}
          </p>
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

          {isLoaded && memberships.length === 0 ? (
            <p className="rounded-2xl bg-fill-subtle px-4 py-3 text-sm text-tertiary">
              {t("Shared.SharedComponents.noOrganizations")}
            </p>
          ) : null}

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
                    await selectProjectAction(null);
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

          {isLoaded && userMemberships.hasNextPage ? (
            <button
              type="button"
              disabled={switchingTo !== null || userMemberships.isFetching}
              onClick={() => userMemberships.fetchNext()}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border-default px-4 py-3 text-sm font-medium transition-colors hover:border-border-strong hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
            >
              {userMemberships.isFetching ? (
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

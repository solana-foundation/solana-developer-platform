"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import type { Project, ProjectEnvironment } from "@sdp/types/projects";
import { cn } from "@sdp/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import {
  Building2Icon,
  CheckIcon,
  ChevronsUpDownIcon,
  FlaskConicalIcon,
  GlobeIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { useProjectHref } from "@/lib/use-dashboard-project";

function OrgAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  if (imageUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: Clerk provides external URLs not in next/image config.
      <img
        src={imageUrl}
        alt=""
        className="size-6 shrink-0 rounded-md object-cover refresh:size-8"
        aria-hidden="true"
      />
    );
  }
  const initials = name.trim().slice(0, 2).toUpperCase() || "?";
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-on-primary refresh:size-8 refresh:text-body refresh:font-medium">
      {initials}
    </span>
  );
}

const ENVIRONMENT_PRESENTATIONS = {
  sandbox: {
    icon: FlaskConicalIcon,
    labelKey: "Shared.SharedComponents.environmentSandbox",
    detailKey: "Shared.SharedComponents.environmentSandboxDetail",
  },
  production: {
    icon: GlobeIcon,
    labelKey: "Shared.SharedComponents.environmentProduction",
    detailKey: "Shared.SharedComponents.environmentProductionDetail",
  },
} as const satisfies Record<
  ProjectEnvironment,
  { icon: LucideIcon; labelKey: MessageKey; detailKey: MessageKey }
>;

function SelectedCheck() {
  return <CheckIcon className="ml-auto size-4 shrink-0 text-primary" aria-hidden="true" />;
}

function OrganizationItems({
  memberships,
  activeOrganizationId,
  isLoaded,
  disabled,
  onSwitch,
}: {
  memberships: readonly { organization: { id: string; name: string; imageUrl: string | null } }[];
  activeOrganizationId: string | undefined;
  isLoaded: boolean;
  disabled: boolean;
  onSwitch: (organizationId: string) => void;
}) {
  const t = useTranslations();
  return (
    <>
      {memberships.map(({ organization }) => {
        const isActive = organization.id === activeOrganizationId;
        return (
          <DropdownMenuItem
            key={organization.id}
            disabled={disabled}
            aria-current={isActive ? "true" : undefined}
            onSelect={() => onSwitch(organization.id)}
            className="gap-2.5"
          >
            <OrgAvatar name={organization.name} imageUrl={organization.imageUrl} />
            <span className="min-w-0 flex-1 truncate">{organization.name}</span>
            {isActive ? <SelectedCheck /> : null}
          </DropdownMenuItem>
        );
      })}
      {isLoaded && memberships.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-tertiary">
          {t("Shared.SharedComponents.noOrganizations")}
        </p>
      ) : null}
    </>
  );
}

function EnvironmentItem({
  project,
  isSelected,
  disabled,
  onSelect,
}: {
  project: Pick<Project, "id" | "environment">;
  isSelected: boolean;
  disabled: boolean;
  onSelect: (projectId: string) => void;
}) {
  const t = useTranslations();
  const { icon: Icon, labelKey, detailKey } = ENVIRONMENT_PRESENTATIONS[project.environment];
  return (
    <DropdownMenuItem
      disabled={disabled}
      aria-current={isSelected ? "true" : undefined}
      onSelect={() => onSelect(project.id)}
      className="gap-2.5"
    >
      <Icon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{t(labelKey)}</span>
        <span className="truncate text-xs font-normal text-tertiary">{t(detailKey)}</span>
      </span>
      {isSelected ? <SelectedCheck /> : null}
    </DropdownMenuItem>
  );
}

export function WorkspaceSwitcher({
  collapsed = false,
  onOrganizationSwitchingChange,
}: {
  collapsed?: boolean;
  onOrganizationSwitchingChange?: (isSwitching: boolean) => void;
}) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const { organization: activeOrg } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const {
    sandboxProject,
    productionProject,
    sdpEnvironment,
    selectedProjectId,
    selectProject,
    isProjectSwitching,
  } = useDashboardWorkspace();
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);

  const memberships = userMemberships.data ?? [];
  const environmentProjects = [sandboxProject, productionProject].filter(
    (project): project is Project => project !== null
  );
  const isSwitching = isOrganizationSwitching || isProjectSwitching;
  const organizationName = activeOrg?.name ?? t("Shared.SharedComponents.selectOrganization");

  /** Makes another organization active; picking the current one does nothing. */
  const switchOrganization = (organizationId: string) => {
    const isActive = organizationId === activeOrg?.id;
    if (!isActive && setActive) {
      setOrganizationSwitching(true);
      onOrganizationSwitchingChange?.(true);
      const finishSwitch = () => {
        setOrganizationSwitching(false);
        onOrganizationSwitchingChange?.(false);
      };
      void setActive({ organization: organizationId }).then(finishSwitch, finishSwitch);
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-busy={isSwitching}
          aria-label={organizationName}
          className={cn(
            "flex h-10 items-center rounded-[var(--button-radius-lg)] text-left transition-colors hover:bg-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary refresh:h-10 refresh:hover:bg-fill",
            collapsed ? "w-10 justify-center" : "w-full min-w-0 gap-2 px-2 refresh:gap-3"
          )}
        >
          <OrgAvatar name={activeOrg?.name ?? ""} imageUrl={activeOrg?.imageUrl ?? null} />
          {collapsed ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold leading-tight text-primary refresh:text-field refresh:leading-tight refresh:font-medium">
                  {organizationName}
                </span>
                <span className="truncate text-xs leading-tight text-tertiary refresh:text-meta refresh:leading-tight refresh:text-secondary">
                  {t(ENVIRONMENT_PRESENTATIONS[sdpEnvironment].labelKey)}
                </span>
              </span>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-tertiary" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-72">
        <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-secondary">
          {t("Shared.SharedComponents.organizations")}
        </DropdownMenuLabel>
        <OrganizationItems
          memberships={memberships}
          activeOrganizationId={activeOrg?.id}
          isLoaded={isLoaded}
          disabled={isSwitching}
          onSwitch={switchOrganization}
        />
        {activeOrg && environmentProjects.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-secondary">
              {t("Shared.SharedComponents.environmentsOf", { organization: activeOrg.name })}
            </DropdownMenuLabel>
            {environmentProjects.map((project) => (
              <EnvironmentItem
                key={project.id}
                project={project}
                isSelected={project.id === selectedProjectId}
                disabled={isSwitching}
                onSelect={selectProject}
              />
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2.5">
          <Link href={projectHref(DASHBOARD_SIDE_NAV_HREFS.settings)}>
            <Building2Icon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
            {t("Shared.SharedComponents.organizationSettings")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

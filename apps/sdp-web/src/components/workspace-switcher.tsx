"use client";

import { useOrganization, useOrganizationList } from "@clerk/nextjs";
import type { Project, ProjectEnvironment } from "@sdp/types/projects";
import { DEFAULT_SDP_SANDBOX_WEB_URL } from "@sdp/types/site";
import { cn } from "@sdp/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sdp/ui/dropdown-menu";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sdp/ui/tooltip";
import {
  ArrowUpRightIcon,
  Building2Icon,
  CheckIcon,
  ChevronsUpDownIcon,
  FlaskConicalIcon,
  GlobeIcon,
  LockIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
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
        className="shrink-0 rounded-md object-cover size-8"
        aria-hidden="true"
      />
    );
  }
  const initials = name.trim().slice(0, 2).toUpperCase() || "?";
  return (
    <span className="flex shrink-0 items-center justify-center rounded-md bg-primary text-on-primary size-8 text-body font-medium">
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

function LockedProductionItem({
  canRequestAccess,
  disabled,
}: {
  canRequestAccess: boolean;
  disabled: boolean;
}) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const { icon: Icon, labelKey } = ENVIRONMENT_PRESENTATIONS.production;
  const label = (
    <>
      <Icon className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-secondary">{t(labelKey)}</span>
        <span className="truncate text-xs font-normal text-tertiary">
          {t("Shared.SharedComponents.environmentProductionLockedDetail")}
        </span>
      </span>
    </>
  );

  if (!canRequestAccess) {
    const adminOnly = t("Shared.SharedComponents.mainnetAccessAdminOnly");
    // A disabled item takes no pointer events, so the wrapper carries the hover.
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <DropdownMenuItem disabled className="gap-2.5">
                {label}
                <span className="sr-only">{adminOnly}</span>
                <LockIcon className="ml-auto size-4 shrink-0 text-tertiary" aria-hidden="true" />
              </DropdownMenuItem>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-60">
            {adminOnly}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return (
    <DropdownMenuItem asChild disabled={disabled} className="gap-2.5">
      <Link href={projectHref(`${DASHBOARD_SIDE_NAV_HREFS.settings}#mainnet-access`)}>
        {label}
        <span className="ml-auto shrink-0 text-xs font-medium text-primary">
          {t("Shared.SharedComponents.requestMainnetAccess")}
        </span>
      </Link>
    </DropdownMenuItem>
  );
}

/** On a deployment that serves mainnet only, the sandbox lives on its own host. */
function HostedSandboxItem({ disabled }: { disabled: boolean }) {
  const t = useTranslations();
  const { icon: Icon, labelKey } = ENVIRONMENT_PRESENTATIONS.sandbox;
  return (
    <DropdownMenuItem asChild disabled={disabled} className="gap-2.5">
      <a href={DEFAULT_SDP_SANDBOX_WEB_URL} target="_blank" rel="noreferrer">
        <Icon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{t(labelKey)}</span>
          <span className="truncate text-xs font-normal text-tertiary">
            {t("Shared.SharedComponents.environmentSandboxHostedDetail", {
              host: new URL(DEFAULT_SDP_SANDBOX_WEB_URL).host,
            })}
          </span>
        </span>
        <ArrowUpRightIcon className="ml-auto size-4 shrink-0 text-tertiary" aria-hidden="true" />
      </a>
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
  const { organization: activeOrg, isLoaded: isOrganizationLoaded } = useOrganization();
  const { userMemberships, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const {
    sandboxProject,
    productionProject,
    sdpEnvironment,
    selectedProjectId,
    selectProject,
    switchOrganization,
    isProjectSwitching,
    dashboardAccess,
    flags,
  } = useDashboardWorkspace();
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);

  const memberships = userMemberships.data ?? [];
  const environmentProjects = [sandboxProject, productionProject].filter(
    (project): project is Project => project !== null
  );
  const isSwitching = isOrganizationSwitching || isProjectSwitching;
  const organizationName = activeOrg?.name ?? t("Shared.SharedComponents.selectOrganization");

  /** Makes another organization active; picking the current one does nothing. */
  const pickOrganization = (organizationId: string) => {
    const isActive = organizationId === activeOrg?.id;
    if (!isSwitching && !isActive) {
      setOrganizationSwitching(true);
      onOrganizationSwitchingChange?.(true);
      const finishSwitch = () => {
        setOrganizationSwitching(false);
        onOrganizationSwitchingChange?.(false);
      };
      void switchOrganization(organizationId).then(finishSwitch, () => {
        toast.error(t("Shared.SharedComponents.changeOrganizationFailed"));
        finishSwitch();
      });
    }
  };

  if (!isOrganizationLoaded) {
    return (
      <div
        role="status"
        aria-label={t("Shared.SharedComponents.loading")}
        aria-busy="true"
        className={cn("flex h-10 items-center", collapsed ? "w-10 justify-center" : "gap-3 px-2")}
      >
        <SkeletonBlock className="size-8 shrink-0 rounded-md" />
        {collapsed ? null : (
          <div className="flex flex-1 flex-col gap-1.5">
            <SkeletonBlock className="h-3.5 w-24 rounded" />
            <SkeletonBlock className="h-3 w-32 rounded" />
          </div>
        )}
      </div>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-busy={isSwitching}
          aria-label={organizationName}
          className={cn(
            "flex h-10 items-center rounded-[var(--button-radius-lg)] text-left transition-colors hover:bg-fill focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            collapsed ? "w-10 justify-center" : "w-full min-w-0 px-2 gap-3"
          )}
        >
          <OrgAvatar name={activeOrg?.name ?? ""} imageUrl={activeOrg?.imageUrl ?? null} />
          {collapsed ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate leading-tight text-primary text-field font-medium">
                  {organizationName}
                </span>
                <span className="truncate leading-tight text-meta text-secondary">
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
          onSwitch={pickOrganization}
        />
        {activeOrg && environmentProjects.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-secondary">
              {t("Shared.SharedComponents.environmentsOf", { organization: activeOrg.name })}
            </DropdownMenuLabel>
            {sandboxProject === null && flags.sandboxOnBeta ? (
              <HostedSandboxItem disabled={isSwitching} />
            ) : null}
            {environmentProjects.map((project) => (
              <EnvironmentItem
                key={project.id}
                project={project}
                isSelected={project.id === selectedProjectId}
                disabled={isSwitching}
                onSelect={selectProject}
              />
            ))}
            {/* The API lists no production project until the organization is entitled to one. */}
            {productionProject === null ? (
              <LockedProductionItem
                canRequestAccess={dashboardAccess.capabilities.canManageOrgSettings}
                disabled={isSwitching}
              />
            ) : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="gap-2.5" disabled={isSwitching}>
          <Link href={projectHref(DASHBOARD_SIDE_NAV_HREFS.settings)}>
            <Building2Icon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
            {t("Shared.SharedComponents.organizationSettings")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

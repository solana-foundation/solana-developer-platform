"use client";

import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import type { Project } from "@sdp/types";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  type LucideIcon,
  Settings2Icon,
} from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { clearStoredApiKeySecrets } from "@/lib/playground-api-keys";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";

function OrganizationHeaderAction({
  label,
  icon: Icon,
  onSelect,
}: {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem
          aria-label={label}
          onSelect={onSelect}
          className="size-6 justify-center p-0 text-tertiary focus:text-primary"
        >
          <Icon className="size-3.5" />
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

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
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-on-primary refresh:size-8 refresh:text-body refresh:font-medium">
      {initials}
    </span>
  );
}

/** An organization as the switcher lists it. */
interface WorkspaceOrganization {
  id: string;
  name: string;
  imageUrl: string | null;
}

/** The pill that marks the organization or project already in use. */
function CurrentBadge() {
  const t = useTranslations();
  return (
    <span className="shrink-0 rounded-full bg-fill-subtle px-1.5 py-0.5 text-[10px] font-medium text-secondary">
      {t("Shared.SharedComponents.current")}
    </span>
  );
}

/** The expanded trigger's text: the organization's name over the active project's. */
function WorkspaceTriggerText({
  organizationName,
  activeProject,
}: {
  organizationName: string;
  activeProject: Pick<Project, "name"> | null;
}) {
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold leading-tight text-primary refresh:text-field refresh:leading-tight refresh:font-medium">
          {organizationName}
        </span>
        {activeProject ? (
          <span className="truncate text-xs leading-tight text-tertiary refresh:text-meta refresh:leading-tight refresh:text-secondary">
            {activeProject.name}
          </span>
        ) : null}
      </span>
      <ChevronsUpDownIcon className="size-4 shrink-0 text-tertiary" />
    </>
  );
}

/** The user's organizations, one row each, or a note when they belong to none. */
function OrganizationItems({
  memberships,
  activeOrganizationId,
  isLoaded,
  disabled,
  onSwitch,
}: {
  memberships: readonly { organization: WorkspaceOrganization }[];
  activeOrganizationId: string | undefined;
  isLoaded: boolean;
  disabled: boolean;
  onSwitch: (organizationId: string) => void;
}) {
  const t = useTranslations();
  return (
    <>
      {memberships.map((membership) => {
        const org = membership.organization;
        const isActive = org.id === activeOrganizationId;

        return (
          <DropdownMenuItem
            key={org.id}
            disabled={disabled}
            onSelect={() => onSwitch(org.id)}
            className="gap-2 text-xs"
          >
            <OrgAvatar name={org.name} imageUrl={org.imageUrl} />
            <span className="min-w-0 flex-1 truncate">{org.name}</span>
            {isActive ? <CurrentBadge /> : null}
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

/** The active organization's part of the menu: its projects, then its ID to copy. */
function ActiveOrganizationSection({
  organizationId,
  projects,
  selectedProjectId,
  disabled,
  onSelectProject,
  copied,
  copiedValue,
  onCopy,
}: {
  organizationId: string;
  projects: readonly Pick<Project, "id" | "name">[];
  selectedProjectId: string | null;
  disabled: boolean;
  onSelectProject: (projectId: string) => void;
  copied: boolean;
  copiedValue: string | undefined;
  onCopy: (value: string) => Promise<void>;
}) {
  const t = useTranslations();
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-medium normal-case tracking-normal text-secondary">
        {t("Shared.SharedComponents.projects")}
      </DropdownMenuLabel>
      {projects.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-tertiary">
          {t("Shared.SharedComponents.noProjects")}
        </p>
      ) : (
        projects.map((project) => {
          const isActive = project.id === selectedProjectId;
          return (
            <DropdownMenuItem
              key={project.id}
              disabled={disabled}
              onSelect={() => onSelectProject(project.id)}
              className="gap-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {isActive ? <CurrentBadge /> : null}
            </DropdownMenuItem>
          );
        })
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          void onCopy(organizationId);
        }}
        aria-label={t("Shared.SharedComponents.copyOrganizationId")}
        title={organizationId}
        className="group flex-col items-start gap-0.5"
      >
        <span className="text-[10px] font-medium text-secondary">
          {t("Shared.SharedComponents.organizationId")}
        </span>
        <span className="flex w-full items-center gap-1.5 text-tertiary transition-colors group-hover:text-secondary group-focus:text-secondary">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{organizationId}</span>
          {copied && copiedValue === organizationId ? (
            <CheckIcon className="size-3 shrink-0" />
          ) : (
            <CopyIcon className="size-3 shrink-0 opacity-0 transition-opacity group-focus:opacity-100 group-hover:opacity-100" />
          )}
        </span>
      </DropdownMenuItem>
    </>
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
  const { organization: activeOrg } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const { openOrganizationProfile } = useClerk();
  const { projects, selectedProjectId, selectProject, isProjectSwitching } =
    useDashboardWorkspace();
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);
  const { copied, copy, value: copiedValue } = useCopy(1200);

  const memberships = userMemberships.data ?? [];
  const activeProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const isSwitching = isOrganizationSwitching || isProjectSwitching;
  const organizationName = activeOrg?.name ?? t("Shared.SharedComponents.selectOrganization");

  /** Makes another organization active; picking the current one does nothing. */
  const switchOrganization = (organizationId: string) => {
    const isActive = organizationId === activeOrg?.id;
    if (!isActive && setActive) {
      clearStoredApiKeySecrets();
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
            <WorkspaceTriggerText
              organizationName={organizationName}
              activeProject={activeProject}
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <TooltipProvider>
        <DropdownMenuContent align="start" sideOffset={6} className="w-64">
          <DropdownMenuLabel className="flex items-center justify-between text-xs font-medium normal-case tracking-normal text-secondary">
            <span>{t("Shared.SharedComponents.organizations")}</span>
            <span className="flex items-center gap-0.5">
              {activeOrg ? (
                <OrganizationHeaderAction
                  label={t("Shared.SharedComponents.manageOrganization")}
                  icon={Settings2Icon}
                  onSelect={() => openOrganizationProfile()}
                />
              ) : null}
            </span>
          </DropdownMenuLabel>
          <OrganizationItems
            memberships={memberships}
            activeOrganizationId={activeOrg?.id}
            isLoaded={isLoaded}
            disabled={isSwitching}
            onSwitch={switchOrganization}
          />
          {activeOrg ? (
            <ActiveOrganizationSection
              organizationId={activeOrg.id}
              projects={projects}
              selectedProjectId={selectedProjectId}
              disabled={isSwitching}
              onSelectProject={selectProject}
              copied={copied}
              copiedValue={copiedValue}
              onCopy={copy}
            />
          ) : null}
        </DropdownMenuContent>
      </TooltipProvider>
    </DropdownMenu>
  );
}

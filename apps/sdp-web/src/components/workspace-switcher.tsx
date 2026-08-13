"use client";

import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  LockIcon,
  type LucideIcon,
  PlusIcon,
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
        className="size-6 shrink-0 rounded-md object-cover"
        aria-hidden="true"
      />
    );
  }
  const initials = name.trim().slice(0, 2).toUpperCase() || "?";
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-on-primary">
      {initials}
    </span>
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
  const { openOrganizationProfile, openCreateOrganization } = useClerk();
  const { projects, selectedProjectId, selectProject, isProjectSwitching } =
    useDashboardWorkspace();
  const [isOrganizationSwitching, setOrganizationSwitching] = useState(false);
  const { copied, copy, value: copiedValue } = useCopy(1200);

  const memberships = userMemberships.data ?? [];
  const activeProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-busy={isOrganizationSwitching || isProjectSwitching}
          aria-label={activeOrg?.name ?? t("Shared.SharedComponents.selectOrganization")}
          className={cn(
            "flex h-10 items-center rounded-[var(--button-radius-lg)] text-left transition-colors hover:bg-fill-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            collapsed ? "w-10 justify-center" : "w-full min-w-0 gap-2 px-2"
          )}
        >
          <OrgAvatar name={activeOrg?.name ?? ""} imageUrl={activeOrg?.imageUrl ?? null} />
          {collapsed ? null : (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold leading-tight text-primary">
                  {activeOrg?.name ?? t("Shared.SharedComponents.selectOrganization")}
                </span>
                {activeProject ? (
                  <span className="truncate text-xs leading-tight text-tertiary">
                    {activeProject.name}
                  </span>
                ) : null}
              </span>
              <ChevronsUpDownIcon className="size-4 shrink-0 text-tertiary" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <TooltipProvider>
        <DropdownMenuContent align="start" sideOffset={6} className="w-64">
          <DropdownMenuLabel className="flex items-center justify-between text-xs font-medium normal-case tracking-normal text-secondary">
            <span>{t("Shared.SharedComponents.organizations")}</span>
            <span className="flex items-center gap-0.5">
              <OrganizationHeaderAction
                label={t("Shared.SharedComponents.createOrganization")}
                icon={PlusIcon}
                onSelect={() => openCreateOrganization()}
              />
              {activeOrg ? (
                <OrganizationHeaderAction
                  label={t("Shared.SharedComponents.manageOrganization")}
                  icon={Settings2Icon}
                  onSelect={() => openOrganizationProfile()}
                />
              ) : null}
            </span>
          </DropdownMenuLabel>
          {memberships.map((membership) => {
            const org = membership.organization;
            const isActive = org.id === activeOrg?.id;

            return (
              <DropdownMenuItem
                key={org.id}
                disabled={isOrganizationSwitching || isProjectSwitching}
                onSelect={() => {
                  if (!isActive && setActive) {
                    setOrganizationSwitching(true);
                    onOrganizationSwitchingChange?.(true);
                    const finishSwitch = () => {
                      setOrganizationSwitching(false);
                      onOrganizationSwitchingChange?.(false);
                    };
                    void setActive({ organization: org.id }).then(finishSwitch, finishSwitch);
                  }
                }}
                className="gap-2 text-xs"
              >
                <OrgAvatar name={org.name} imageUrl={org.imageUrl} />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                {isActive ? (
                  <span className="shrink-0 rounded-full bg-fill-subtle px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                    {t("Shared.SharedComponents.current")}
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })}
          {isLoaded && memberships.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-tertiary">
              {t("Shared.SharedComponents.noOrganizations")}
            </p>
          ) : null}
          {activeOrg ? (
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
                  const isProduction = project.environment === "production";
                  return (
                    <DropdownMenuItem
                      key={project.id}
                      disabled={isProduction || isOrganizationSwitching || isProjectSwitching}
                      onSelect={() => selectProject(project.id)}
                      className="gap-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      {isProduction ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="pointer-events-auto shrink-0 text-tertiary">
                              <LockIcon
                                className="size-3.5"
                                aria-label={t("Shared.SharedComponents.locked")}
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="center">
                            <span className="block">
                              {t("Shared.SharedComponents.sandboxOnly")}
                            </span>
                            <span className="block">
                              {t("Shared.SharedComponents.mainnetSoon")}
                            </span>
                          </TooltipContent>
                        </Tooltip>
                      ) : isActive ? (
                        <span className="shrink-0 rounded-full bg-fill-subtle px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                          {t("Shared.SharedComponents.current")}
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  );
                })
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  void copy(activeOrg.id);
                }}
                aria-label={t("Shared.SharedComponents.copyOrganizationId")}
                title={activeOrg.id}
                className="group flex-col items-start gap-0.5"
              >
                <span className="text-[10px] font-medium text-secondary">
                  {t("Shared.SharedComponents.organizationId")}
                </span>
                <span className="flex w-full items-center gap-1.5 text-tertiary transition-colors group-hover:text-secondary group-focus:text-secondary">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                    {activeOrg.id}
                  </span>
                  {copied && copiedValue === activeOrg.id ? (
                    <CheckIcon className="size-3 shrink-0" />
                  ) : (
                    <CopyIcon className="size-3 shrink-0 opacity-0 transition-opacity group-focus:opacity-100 group-hover:opacity-100" />
                  )}
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </TooltipProvider>
    </DropdownMenu>
  );
}

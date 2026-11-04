"use client";

import { useClerk, useSession, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { DashboardLoadingScreen } from "@/components/dashboard-loading-screen";
import type { DashboardFlags } from "@/flags/dashboard";
import { useDashboardPathname } from "@/lib/use-dashboard-project";
import { findProjectOrganization } from "./project-organization-actions";

/**
 * Shown for a Project URL the session's organization does not list. The URL
 * decides the organization: when another organization of the user lists the
 * Project, it becomes active and Clerk re-renders the same URL inside it (a
 * reload or a deep link after switching, or a tab whose cookie another tab
 * rewrote). Otherwise the page moves to `fallbackHref`, the session
 * organization's Sandbox. Nothing of the Project renders until then.
 *
 * @param props.projectId - The Project the URL names.
 * @param props.sessionOrganizationId - The organization the server rendered for.
 * @param props.fallbackHref - Where to go when no organization of the user lists the Project.
 * @param props.flags - Dashboard flags, for the loading frame.
 */
export function ProjectOrganizationSwitch({
  projectId,
  sessionOrganizationId,
  fallbackHref,
  flags,
}: {
  projectId: string;
  sessionOrganizationId: string;
  fallbackHref: string;
  flags: DashboardFlags;
}) {
  const router = useRouter();
  const pathname = useDashboardPathname();
  const { setActive } = useClerk();
  const { isLoaded: isSessionLoaded, session } = useSession();
  const { isLoaded: isUserLoaded, user } = useUser();

  // One lookup per Project and session organization: switching hands Clerk's
  // session and user new identities, and a lookup started again on those would
  // switch again and supersede the refresh that renders the Project.
  const startedAttemptRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isSessionLoaded || !isUserLoaded) {
      return;
    }
    const attempt = `${projectId}:${sessionOrganizationId}`;
    if (startedAttemptRef.current === attempt) {
      return;
    }
    startedAttemptRef.current = attempt;
    // A lookup the server superseded (it rendered for another organization) or
    // that outlived the switch acts on nothing.
    const isCurrent = () => mountedRef.current && startedAttemptRef.current === attempt;
    const organizationIds = (user?.organizationMemberships ?? [])
      .map((membership) => membership.organization.id)
      .filter((organizationId) => organizationId !== sessionOrganizationId);

    async function switchToProjectOrganization() {
      if (session && organizationIds.length > 0) {
        const tokens = await Promise.all(
          organizationIds.map((organizationId) => session.getToken({ organizationId }))
        );
        const candidates = organizationIds.flatMap((organizationId, index) => {
          const token = tokens[index];
          return token ? [{ organizationId, token }] : [];
        });
        const index = await findProjectOrganization(
          projectId,
          candidates.map((candidate) => candidate.token)
        );
        const match = index === null ? undefined : candidates[index];
        if (match !== undefined && isCurrent()) {
          // Clerk refreshes the route once the organization is active.
          await setActive({ organization: match.organizationId });
          return;
        }
      }
      if (isCurrent()) {
        // react-doctor-disable-next-line nextjs-no-client-side-redirect -- only the browser can mint other organizations' tokens, and the tab shows a loading frame until it goes
        router.replace(fallbackHref);
      }
    }

    // A failed lookup keeps the old behavior, the session organization's Sandbox,
    // rather than leaving the tab on a loading frame.
    switchToProjectOrganization().catch((error: unknown) => {
      console.error("Could not find the organization of the requested project", error);
      if (isCurrent()) {
        // react-doctor-disable-next-line nextjs-no-client-side-redirect -- only the browser can mint other organizations' tokens, and the tab shows a loading frame until it goes
        router.replace(fallbackHref);
      }
    });
  }, [
    isSessionLoaded,
    isUserLoaded,
    session,
    user,
    projectId,
    sessionOrganizationId,
    fallbackHref,
    router,
    setActive,
  ]);

  return <DashboardLoadingScreen pathname={pathname} flags={flags} />;
}

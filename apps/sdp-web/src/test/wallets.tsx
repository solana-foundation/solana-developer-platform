import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import type { OrganizationRole } from "@sdp/types/roles";
import { type Address, address, getBase58Decoder, type Signature, signature } from "@solana/kit";
import type { ReactNode } from "react";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { EnglishI18n } from "./i18n";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "./projects";
import { dashboardFlagsAt } from "./release-channel-flags";

function syntheticBytes(length: number, index: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(7);
  new DataView(bytes.buffer).setUint32(0, index);
  return bytes;
}

/**
 * A well-formed wallet or account address, distinct for every index, for a suite that needs one
 * without naming a real account.
 *
 * @param index - Any non-negative integer up to 2^32 - 1.
 * @returns The address.
 */
export function syntheticWalletAddress(index: number): Address {
  return address(getBase58Decoder().decode(syntheticBytes(32, index)));
}

/**
 * A well-formed transaction signature, distinct for every index.
 *
 * @param index - Any non-negative integer up to 2^32 - 1.
 * @returns The signature.
 */
export function syntheticWalletSignature(index: number): Signature {
  return signature(getBase58Decoder().decode(syntheticBytes(64, index)));
}

/**
 * The dashboard shell's workspace around a wallets surface on `releaseChannel`, for a suite whose
 * copy depends on the modules a channel runs; {@link walletsWorkspace} runs every module.
 */
export function WalletsTestWorkspace({
  organizationRole,
  releaseChannel,
  children,
}: {
  organizationRole: OrganizationRole;
  releaseChannel: SdpReleaseChannel;
  children: ReactNode;
}) {
  return (
    <EnglishI18n>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess(organizationRole)}
        flags={dashboardFlagsAt(releaseChannel)}
        serverDashboardCacheScope={{ orgId: SANDBOX_PROJECT.organizationId, userId: "user_test" }}
        projects={[SANDBOX_PROJECT, PRODUCTION_PROJECT]}
      >
        {children}
      </DashboardWorkspaceProvider>
    </EnglishI18n>
  );
}

function AdminWalletsWorkspace({ children }: { children: ReactNode }) {
  return (
    <WalletsTestWorkspace organizationRole="admin" releaseChannel="experimental">
      {children}
    </WalletsTestWorkspace>
  );
}

function MemberWalletsWorkspace({ children }: { children: ReactNode }) {
  return (
    <WalletsTestWorkspace organizationRole="member" releaseChannel="experimental">
      {children}
    </WalletsTestWorkspace>
  );
}

function ViewerWalletsWorkspace({ children }: { children: ReactNode }) {
  return (
    <WalletsTestWorkspace organizationRole="viewer" releaseChannel="experimental">
      {children}
    </WalletsTestWorkspace>
  );
}

const WALLETS_WORKSPACE_BY_ROLE = {
  admin: AdminWalletsWorkspace,
  member: MemberWalletsWorkspace,
  viewer: ViewerWalletsWorkspace,
} as const satisfies Record<OrganizationRole, (props: { children: ReactNode }) => ReactNode>;

/**
 * The dashboard shell's workspace around a wallets surface: the English catalog and the real
 * `DashboardWorkspaceProvider` for the test Organization's Sandbox Project, with every module on
 * and the access `role` grants. The provider brings an SWR cache of its own. The suite calls
 * `stubClerkSession()` in `beforeEach` and mocks `next/navigation` with `@/test/next-navigation`.
 *
 * @param role - The viewer's Organization role.
 * @returns A `render` wrapper, the same component for every call with one role.
 */
export function walletsWorkspace(
  role: OrganizationRole
): (props: { children: ReactNode }) => ReactNode {
  return WALLETS_WORKSPACE_BY_ROLE[role];
}

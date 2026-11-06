import type { CustodyCredentialLifecycle } from "./connection-detail.data";
import { isCredentialManagedHere } from "./connection-detail.data";

/**
 * Derives what the viewer can do to these credentials from the lifecycle and
 * the custody permission.
 *
 * A restricted or failed read has no lifecycle, so it permits nothing.
 */
export function resolveCredentialActions(
  lifecycle: CustodyCredentialLifecycle | "restricted" | null,
  canManageCustody: boolean
) {
  const availableLifecycle = typeof lifecycle === "object" ? lifecycle : null;
  if (availableLifecycle === null) {
    return {
      availableLifecycle,
      managedHere: false,
      currentInUse: false,
      canAct: false,
      canDeactivate: false,
    };
  }

  const credential = availableLifecycle.providerCredential;
  const managedHere = isCredentialManagedHere(credential);
  const currentInUse =
    credential.status === "active" && availableLifecycle.impact.connections.length > 0;
  const canManageHere = canManageCustody && managedHere;
  return {
    availableLifecycle,
    managedHere,
    currentInUse,
    canAct: canManageHere && currentInUse,
    canDeactivate:
      canManageHere && (credential.status === "active" || credential.status === "pending"),
  };
}

/**
 * A rotation the page has started, held above the block so the header's Rotate secret and the
 * block share it. `lifecycle` stays set across dismissal and refresh so an unresolved rotation
 * resumes with the original payload, key and credential target.
 */
export interface RotationState {
  lifecycle: CustodyCredentialLifecycle | null;
  open: boolean;
}

/**
 * The lifecycle a new rotation would start from, or `null` while one cannot start: the viewer
 * cannot act on these credentials (which also rules out any credential that is not active and
 * in use), a candidate is still waiting, or the page already holds a rotation.
 */
export function rotatableLifecycle(
  lifecycle: CustodyCredentialLifecycle | "restricted" | null,
  canManageCustody: boolean,
  rotation: RotationState
): CustodyCredentialLifecycle | null {
  const { availableLifecycle, canAct } = resolveCredentialActions(lifecycle, canManageCustody);
  if (!availableLifecycle || !canAct || availableLifecycle.rotationCandidate) return null;
  return rotation.lifecycle === null ? availableLifecycle : null;
}

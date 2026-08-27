"use client";

import { useCallback, useState } from "react";
import type { BadgeVariant } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import {
  fetchRingsWalletIdentity,
  type RingsIdentityStatus,
  type RingsWallet,
  type RingsWalletIdentity,
} from "./helius-rings.data";
import { shortenShieldedAddress } from "./helius-rings.utils";

/**
 * What the last check established. `unchecked` is distinct from any outcome:
 * nobody having looked is not an answer, and rendering it as one would state a
 * verdict about the chain that nothing observed.
 */
type Check =
  | { name: "unchecked" }
  | { name: "read"; identity: RingsWalletIdentity }
  | { name: "failed"; message: string };

/**
 * The three outcomes carry different instructions, so they are coloured apart
 * rather than sharing a neutral badge: `foreign` is the one an operator has to
 * act on, and it is the one that looks least like the other two.
 */
const STATUS_BADGE: Record<RingsIdentityStatus, BadgeVariant> = {
  unregistered: "default",
  ours: "success",
  foreign: "danger",
};

/**
 * Reads what the Rings registry publishes for one pending wallet's owner.
 *
 * On demand only. It costs an RPC round trip and derives key material
 * server-side, so nothing here fires on mount or on a timer — an operator who
 * hit a provisioning conflict presses it because the alternative is decoding
 * the PDA by hand.
 *
 * The verdict itself lives in a dialog. Putting the explain-copy and the two
 * commitments in the table cell overflowed the card and clipped against its
 * corner; the cell only offers the check and, after a result, a way back into
 * that dialog.
 *
 * Offered only for `pending` wallets. A `ready` wallet has a recorded identity
 * that every read already re-derives and pins, so the question this answers is
 * one it cannot be in doubt about.
 */
export function WalletIdentityCheck({ wallet }: { wallet: RingsWallet }) {
  const t = useTranslations();

  const [check, setCheck] = useState<Check>({ name: "unchecked" });
  const [reading, setReading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleCheck = useCallback(async () => {
    setReading(true);
    try {
      const result = await fetchRingsWalletIdentity(wallet.id);
      setCheck(
        result.identity
          ? { name: "read", identity: result.identity }
          : {
              name: "failed",
              message: result.error ?? t("DashboardHeliusRings.identity.readFailed"),
            }
      );
      setDialogOpen(true);
    } catch {
      // No reply at all — offline, or the browser aborted the request. The
      // envelope reader only ever sees responses, so without catching here the
      // control would sit disabled on "Checking…" with no answer coming.
      setCheck({ name: "failed", message: t("DashboardHeliusRings.identity.readFailed") });
      setDialogOpen(true);
    } finally {
      setReading(false);
    }
  }, [wallet.id, t]);

  const hasResult = check.name === "read" || check.name === "failed";
  const dialogTitle = t("DashboardHeliusRings.identity.dialogTitle");

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button variant="secondary" size="sm" disabled={reading} onClick={() => void handleCheck()}>
        {t(
          reading ? "DashboardHeliusRings.identity.checking" : "DashboardHeliusRings.identity.check"
        )}
      </Button>

      {hasResult && !dialogOpen ? (
        <Button variant="ghost" size="sm" onClick={() => setDialogOpen(true)}>
          {t("DashboardHeliusRings.identity.viewDetails")}
        </Button>
      ) : null}

      <Modal
        isOpen={dialogOpen}
        ariaLabel={dialogTitle}
        onClose={() => setDialogOpen(false)}
        size="md"
      >
        <div className="p-6 pr-14">
          <h2 className="text-base font-medium text-primary">{dialogTitle}</h2>
          <p className="mt-1 text-sm text-secondary">{wallet.name}</p>

          {check.name === "failed" ? (
            <Callout variant="danger" live className="mt-4">
              {check.message}
            </Callout>
          ) : null}

          {check.name === "read" ? (
            <div className="mt-4">
              <Outcome identity={check.identity} />
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

function Outcome({ identity }: { identity: RingsWalletIdentity }) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-3 text-sm" role="status">
      <Badge variant={STATUS_BADGE[identity.status]}>
        {t(`DashboardHeliusRings.identity.status_${identity.status}`)}
      </Badge>

      {/* What to do about it, which is the part an operator is actually here
          for. A status word alone leaves "registered with different keys"
          looking like something a retry could clear. */}
      <p className="text-pretty leading-6 text-secondary">
        {t(`DashboardHeliusRings.identity.explain_${identity.status}`)}
      </p>

      {identity.mismatch === null ? null : (
        <p className="text-secondary">
          {t("DashboardHeliusRings.identity.mismatch", {
            field: t(`DashboardHeliusRings.identity.mismatch_${identity.mismatch}`),
          })}
        </p>
      )}

      <dl className="flex flex-col gap-2">
        <Address
          label={t("DashboardHeliusRings.identity.derivedAddress")}
          value={identity.derivedShieldedAddress}
        />
        {identity.publishedShieldedAddress === null ? null : (
          <Address
            label={t("DashboardHeliusRings.identity.publishedAddress")}
            value={identity.publishedShieldedAddress}
          />
        )}
        {identity.recordedShieldedAddress === null ? (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-secondary">
              {t("DashboardHeliusRings.identity.recordedAddress")}
            </dt>
            <dd className="text-xs text-tertiary">
              {t("DashboardHeliusRings.identity.recordedAddressNone")}
            </dd>
          </div>
        ) : (
          <Address
            label={t("DashboardHeliusRings.identity.recordedAddress")}
            value={identity.recordedShieldedAddress}
          />
        )}
      </dl>
    </div>
  );
}

function Address({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="font-mono text-xs text-primary" title={value}>
        {shortenShieldedAddress(value)}
      </dd>
    </div>
  );
}

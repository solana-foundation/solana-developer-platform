"use client";

import { useCallback, useState } from "react";
import type { BadgeVariant } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import {
  createProjectRing,
  DEFAULT_RING_NAME,
  type ProjectRing,
  type ProjectRingStatus,
  RING_NAME_PATTERN,
} from "./helius-rings.data";
import { Address } from "./wallet-identity-check";

const STATUS_BADGE: Record<ProjectRingStatus, BadgeVariant> = {
  pending: "warning",
  active: "success",
  failed: "danger",
};

/**
 * The project's named custom rings. Ops pre-deploys each ring program;
 * recording a name and program id here runs bring-up server-side (auditor
 * key, config, pool registration, lookup table). Once active, any operation
 * can target the ring by name; default-pool operations are never blocked by
 * it. A failed bring-up's retry lives on its row, and re-submitting a
 * never-active name with a corrected id re-points it.
 *
 * Prop-driven like the other cards: the workspace owns the fetch, this card
 * owns only its form state.
 */
export function RingCard({
  rings,
  onChanged,
}: {
  rings: ProjectRing[];
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();

  const [name, setName] = useState("");
  const [ringProgramId, setRingProgramId] = useState("");
  const [submittingName, setSubmittingName] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [selectedRingId, setSelectedRingId] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (submitted: { name: string; ringProgramId: string }) => {
      setSubmittingName(submitted.name);
      setSubmitError(null);
      try {
        const result = await createProjectRing(submitted);
        if (!result.ring) {
          // The server's reason verbatim: it is the only text naming what refused.
          setSubmitError(result.error ?? t("DashboardHeliusRings.ring.submitFailed"));
        }
      } catch {
        setSubmitError(t("DashboardHeliusRings.ring.submitFailed"));
      } finally {
        setSubmittingName(null);
      }
      // The row is reserved before bring-up, so a failure still leaves a ring
      // (and its recorded failure) to show.
      await onChanged();
    },
    [onChanged, t]
  );

  const trimmedName = name.trim();
  const formComplete =
    RING_NAME_PATTERN.test(trimmedName) &&
    trimmedName !== DEFAULT_RING_NAME &&
    ringProgramId.trim().length > 0;

  // Keep the page flat as rings grow: the list lives in a dialog, and the
  // selection survives a refresh (retry) as long as the ring is still there.
  const selectedRing = rings.find((ring) => ring.id === selectedRingId) ?? rings[0] ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.ring.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.ring.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rings.length === 0 ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.ring.none")}</p>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setListOpen(true)}>
              <span>{t("DashboardHeliusRings.ring.openList")}</span>
              <Badge variant="default">{rings.length}</Badge>
            </Button>
          </div>
        )}

        {submitError ? (
          <Callout variant="danger" live>
            {submitError}
          </Callout>
        ) : null}

        <div className="flex flex-col gap-2">
          {rings.length > 0 ? (
            <p className="text-sm text-secondary">{t("DashboardHeliusRings.ring.repointHint")}</p>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-48 flex-col gap-1.5">
              <Label htmlFor="rings-ring-name">{t("DashboardHeliusRings.ring.nameLabel")}</Label>
              <Input
                id="rings-ring-name"
                value={name}
                placeholder={t("DashboardHeliusRings.ring.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex min-w-96 flex-col gap-1.5">
              <Label htmlFor="rings-ring-program-id">
                {t("DashboardHeliusRings.ring.programIdLabel")}
              </Label>
              <Input
                id="rings-ring-program-id"
                value={ringProgramId}
                placeholder={t("DashboardHeliusRings.ring.programIdPlaceholder")}
                onChange={(event) => setRingProgramId(event.target.value)}
              />
            </div>
            <Button
              disabled={submittingName !== null || !formComplete}
              onClick={() =>
                void handleSubmit({ name: trimmedName, ringProgramId: ringProgramId.trim() })
              }
            >
              {t(
                submittingName !== null
                  ? "DashboardHeliusRings.ring.submitting"
                  : "DashboardHeliusRings.ring.submit"
              )}
            </Button>
          </div>
        </div>
      </CardContent>

      {selectedRing === null ? null : (
        <Modal
          isOpen={listOpen}
          ariaLabel={t("DashboardHeliusRings.ring.title")}
          onClose={() => setListOpen(false)}
          size="xl"
        >
          <div className="p-6 pr-14">
            <h2 className="text-base font-medium text-primary">
              {t("DashboardHeliusRings.ring.title")}
            </h2>
            <p className="mt-1 text-sm text-secondary">
              {t("DashboardHeliusRings.ring.dialogDescription")}
            </p>

            <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,13rem)_1fr]">
              <ul className="flex flex-col gap-1" aria-label={t("DashboardHeliusRings.ring.title")}>
                {rings.map((ring) => {
                  const active = ring.id === selectedRing.id;
                  return (
                    <li key={ring.id}>
                      <button
                        type="button"
                        aria-current={active}
                        onClick={() => setSelectedRingId(ring.id)}
                        className={
                          active
                            ? "flex w-full items-center justify-between gap-2 rounded-lg border-l-2 border-info bg-info-bg px-3 py-2 text-left text-sm"
                            : "flex w-full items-center justify-between gap-2 rounded-lg border-l-2 border-transparent px-3 py-2 text-left text-sm hover:bg-fill-subtle"
                        }
                      >
                        <span className="truncate font-medium text-primary">{ring.name}</span>
                        <Badge variant={STATUS_BADGE[ring.status]}>
                          {t(`DashboardHeliusRings.ring.status_${ring.status}`)}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="flex flex-col gap-3">
                <RingDetails ring={selectedRing} />
                {/* Retry resumes bring-up with the recorded name and id; the
                    card's form re-points a never-active ring at a corrected id
                    by re-using its name. */}
                {selectedRing.status !== "active" ? (
                  <div>
                    <Button
                      variant="secondary"
                      disabled={submittingName !== null}
                      onClick={() =>
                        void handleSubmit({
                          name: selectedRing.name,
                          ringProgramId: selectedRing.ringProgramId,
                        })
                      }
                    >
                      {t(
                        submittingName === selectedRing.name
                          ? "DashboardHeliusRings.ring.submitting"
                          : "DashboardHeliusRings.ring.retry"
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function RingDetails({ ring }: { ring: ProjectRing }) {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-3 text-sm" role="status">
      <div className="flex items-center gap-2">
        <span className="font-medium text-primary">{ring.name}</span>
        <Badge variant={STATUS_BADGE[ring.status]}>
          {t(`DashboardHeliusRings.ring.status_${ring.status}`)}
        </Badge>
        {/* The badge already says "Active"; only pending/failed need the why. */}
        {ring.status === "active" ? null : (
          <span className="text-secondary">
            {t(`DashboardHeliusRings.ring.explain_${ring.status}`)}
          </span>
        )}
      </div>

      {ring.failure ? (
        <Callout variant="danger" live>
          {ring.failure.message}
        </Callout>
      ) : null}

      <dl className="flex flex-col gap-2">
        <Address label={t("DashboardHeliusRings.ring.programId")} value={ring.ringProgramId} />
        {ring.auditorPublicKeyHex === null ? null : (
          <Address
            label={t("DashboardHeliusRings.ring.auditorKey")}
            value={ring.auditorPublicKeyHex}
          />
        )}
        {ring.lookupTableAddress === null ? null : (
          <Address
            label={t("DashboardHeliusRings.ring.lookupTable")}
            value={ring.lookupTableAddress}
          />
        )}
      </dl>
    </div>
  );
}

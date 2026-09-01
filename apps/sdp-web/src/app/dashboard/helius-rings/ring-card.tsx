"use client";

import { useCallback, useState } from "react";
import type { BadgeVariant } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { createProjectRing, type ProjectRing, type ProjectRingStatus } from "./helius-rings.data";

const STATUS_BADGE: Record<ProjectRingStatus, BadgeVariant> = {
  pending: "warning",
  active: "success",
  failed: "danger",
};

/** Mirrors MAX_PROJECT_RINGS and RING_NAME_PATTERN in @sdp/helius-rings (no server imports here). */
const MAX_PROJECT_RINGS = 8;
const RING_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

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

  const atCap = rings.length >= MAX_PROJECT_RINGS;
  const trimmedName = name.trim();
  const formComplete =
    RING_NAME_PATTERN.test(trimmedName) &&
    trimmedName !== "default" &&
    ringProgramId.trim().length > 0;

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
          <ul className="flex flex-col gap-4">
            {rings.map((ring) => (
              <li
                key={ring.id}
                className="flex flex-col gap-3 border-b border-border-default pb-4 last:border-b-0 last:pb-0"
              >
                <RingDetails ring={ring} />
                {/* Retry resumes bring-up with the recorded name and id; the
                    form below re-points a never-active ring at a corrected id
                    by re-using its name. */}
                {ring.status !== "active" ? (
                  <div>
                    <Button
                      variant="secondary"
                      disabled={submittingName !== null}
                      onClick={() =>
                        void handleSubmit({ name: ring.name, ringProgramId: ring.ringProgramId })
                      }
                    >
                      {t(
                        submittingName === ring.name
                          ? "DashboardHeliusRings.ring.submitting"
                          : "DashboardHeliusRings.ring.retry"
                      )}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {submitError ? (
          <Callout variant="danger" live>
            {submitError}
          </Callout>
        ) : null}

        {atCap ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.ring.capReached")}</p>
        ) : (
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
        )}
      </CardContent>
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
        <span className="text-secondary">
          {t(`DashboardHeliusRings.ring.explain_${ring.status}`)}
        </span>
      </div>

      {ring.failure ? (
        <Callout variant="danger" live>
          {ring.failure.message}
        </Callout>
      ) : null}

      <dl className="flex flex-col gap-2">
        <Field label={t("DashboardHeliusRings.ring.programId")} value={ring.ringProgramId} />
        {ring.auditorPublicKeyHex === null ? null : (
          <Field
            label={t("DashboardHeliusRings.ring.auditorKey")}
            value={ring.auditorPublicKeyHex}
          />
        )}
        {ring.lookupTableAddress === null ? null : (
          <Field
            label={t("DashboardHeliusRings.ring.lookupTable")}
            value={ring.lookupTableAddress}
          />
        )}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="break-all font-mono text-xs text-primary">{value}</dd>
    </div>
  );
}

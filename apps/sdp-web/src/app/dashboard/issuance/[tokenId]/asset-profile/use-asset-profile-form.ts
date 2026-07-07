"use client";

import type { AssetProfile, Token } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { buildIssuanceMetadata, getAssetDetailsErrors } from "../../create/draft-mapping";
import type { DraftState } from "../../create/issuance-draft-wizard.types";
import { updateAssetProfileAction } from "./actions";
import { areDraftsEquivalent, profileToDraftState } from "./asset-profile-mapping";

/**
 * Edit-in-place form state for the asset management workspace: one draft
 * spanning the Details and Compliance tabs, hydrated from the profile + token,
 * saved as a whole through the save bar. No localStorage — the wizard's
 * persisted create-draft must stay untouched.
 */
export function useAssetProfileForm({
  token,
  assetProfile: initialAssetProfile,
}: {
  token: Token;
  assetProfile: AssetProfile;
}) {
  const router = useRouter();
  // The save action returns the updated profile; keep the freshest copy so the
  // baseline re-derives without waiting for a server re-render.
  const [assetProfile, setAssetProfile] = useState(initialAssetProfile);
  useEffect(() => {
    if (initialAssetProfile.updatedAt > assetProfile.updatedAt) {
      setAssetProfile(initialAssetProfile);
    }
  }, [initialAssetProfile, assetProfile.updatedAt]);

  const baseline = useMemo(() => profileToDraftState(assetProfile, token), [assetProfile, token]);
  const [draft, setDraft] = useState<DraftState>(baseline);
  const [baselineKey, setBaselineKey] = useState(assetProfile.updatedAt);
  // Re-hydrate the form when the underlying profile changes (post-save or after
  // a router.refresh picked up someone else's update) — but never mid-edit.
  const dirty = !areDraftsEquivalent(draft, baseline);
  useEffect(() => {
    if (assetProfile.updatedAt !== baselineKey && !dirty) {
      setDraft(baseline);
      setBaselineKey(assetProfile.updatedAt);
    }
  }, [assetProfile.updatedAt, baselineKey, baseline, dirty]);

  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const updateDraft = (patch: Partial<DraftState>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
  };

  const errors = getAssetDetailsErrors(draft);
  if (!draft.name.trim()) {
    errors.name = "Asset name is required.";
  }
  const errorCount = Object.keys(errors).length;

  const discard = () => {
    setDraft(baseline);
    setShowErrors(false);
  };

  const save = async () => {
    if (!dirty || saving) {
      return;
    }
    if (errorCount > 0) {
      setShowErrors(true);
      toast.error("Fix the highlighted fields before saving.");
      return;
    }

    setSaving(true);
    try {
      const isDeployed = Boolean(token.mintAddress);
      const result = await updateAssetProfileAction({
        tokenId: token.id,
        profileId: assetProfile.id,
        rebuiltMetadata: buildIssuanceMetadata(draft),
        tokenPatch: {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          uri: draft.metadataUri.trim() || null,
          imageUrl: draft.imageUrl.trim() || null,
          // Access-control enforcement can only change while undeployed; the
          // API rejects the field after deploy.
          ...(isDeployed ? {} : { requiresAllowlist: draft.accessControl === "allowlist" }),
        },
      });

      if (result.state === "error") {
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
      setShowErrors(false);
      if (result.assetProfile) {
        setAssetProfile(result.assetProfile);
        setBaselineKey(result.assetProfile.updatedAt);
        setDraft(profileToDraftState(result.assetProfile, { ...token, ...draftTokenPatch(draft) }));
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  // Warn before the tab/window closes with unsaved changes. (App Router has no
  // client-side navigation blocker; internal nav away discards silently.)
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  return {
    draft,
    updateDraft,
    dirty,
    saving,
    errors,
    errorCount,
    showErrors,
    save,
    discard,
    assetProfile,
  };
}

// The token fields the save action just wrote — applied optimistically so the
// re-derived baseline matches the saved draft before router.refresh lands.
function draftTokenPatch(draft: DraftState): Partial<Token> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    uri: draft.metadataUri.trim() || null,
    imageUrl: draft.imageUrl.trim() || null,
  };
}

export type AssetProfileForm = ReturnType<typeof useAssetProfileForm>;

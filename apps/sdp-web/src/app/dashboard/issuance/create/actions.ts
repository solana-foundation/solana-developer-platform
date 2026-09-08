"use server";

import { revalidatePath } from "next/cache";
import { parseErrorMessage } from "@/lib/api-error";
import { createSdpApiClient } from "@/lib/sdp-api";
import { fetchPaymentsWallets } from "../../payments/payments-page.data";
import { buildDraftPayload, draftSchema } from "./draft-model";

export async function saveIssuanceDraft(
  input: unknown
): Promise<{ state: "success" | "error"; message: string; tokenId: string | null }> {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success)
    return {
      state: "error",
      message: parsed.error.issues[0]?.message ?? "Check the draft fields.",
      tokenId: null,
    };
  const draft = parsed.data;
  const isStablecoin = draft.assetClass === "stablecoin";
  const payload = buildDraftPayload(draft);
  try {
    const client = await createSdpApiClient();
    const wallets = await fetchPaymentsWallets(client.request, {
      view: "summary",
      includeBalances: false,
    });
    const allowedIds = new Set((wallets.data ?? []).map((wallet) => wallet.walletId));
    const required = isStablecoin
      ? Object.values(draft.authorities)
      : [draft.authorities["mint-authority"], draft.authorities["metadata-authority"]];
    if (!wallets.ok || required.some((id) => !allowedIds.has(id))) {
      return {
        state: "error",
        message: "Select an available SDP wallet for each permission.",
        tokenId: null,
      };
    }
    const response = await client.request("/v1/issuance/asset-profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return {
        state: "error",
        message: parseErrorMessage(await response.text()),
        tokenId: null,
      };
    }

    const body = (await response.json()) as { data?: { token?: { id?: string } } };
    revalidatePath("/dashboard/issuance");
    return {
      state: "success",
      message: "Draft saved to SDP.",
      tokenId: body.data?.token?.id ?? null,
    };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unable to save draft.",
      tokenId: null,
    };
  }
}

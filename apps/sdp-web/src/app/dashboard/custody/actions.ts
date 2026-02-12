"use server";

import { sdpApiFetch } from "@/lib/sdp-api";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function getString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function getOptionalString(formData: FormData, key: string): string | undefined {
  const value = getString(formData, key);
  return value ? value : undefined;
}

export async function initializeCustody(formData: FormData) {
  const provider = (getString(formData, "provider") || "privy") as "privy" | "local";
  const walletLabel = getOptionalString(formData, "walletLabel");

  if (provider === "local") {
    await sdpApiFetch("/v1/custody/initialize", {
      method: "POST",
      body: JSON.stringify({ provider, walletLabel }),
    });
  } else {
    await sdpApiFetch("/v1/custody/initialize", {
      method: "POST",
      body: JSON.stringify({ provider, walletLabel }),
    });
  }

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export async function switchCustodyProvider(formData: FormData) {
  const provider = (getString(formData, "provider") || "privy") as "privy" | "local";
  const confirm = getString(formData, "confirm");
  const walletLabel = getOptionalString(formData, "walletLabel");

  if (confirm.toLowerCase() !== "switch") {
    throw new Error("Type SWITCH to confirm provider change");
  }

  if (provider === "local") {
    await sdpApiFetch("/v1/custody/switch", {
      method: "POST",
      body: JSON.stringify({ provider, walletLabel }),
    });
  } else {
    await sdpApiFetch("/v1/custody/switch", {
      method: "POST",
      body: JSON.stringify({ provider, walletLabel }),
    });
  }

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export async function createCustodyWallet(formData: FormData) {
  const label = getOptionalString(formData, "label");
  const purpose = getOptionalString(formData, "purpose") as
    | "root"
    | "mint_authority"
    | "freeze_authority"
    | "fee_payer"
    | "transfer"
    | undefined;
  const setDefault = getString(formData, "setDefault") === "on";

  await sdpApiFetch("/v1/custody/wallets", {
    method: "POST",
    body: JSON.stringify({ label, purpose, setDefault }),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export async function setDefaultCustodyWallet(formData: FormData) {
  const walletId = getString(formData, "walletId");
  if (!walletId) {
    throw new Error("walletId is required");
  }

  await sdpApiFetch("/v1/custody/default-wallet", {
    method: "POST",
    body: JSON.stringify({ walletId }),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

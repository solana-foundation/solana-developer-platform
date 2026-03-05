"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Dispatch, SetStateAction } from "react";
import { TokenActionCard } from "./token-action-card";
import type {
  AdminAction,
  BurnFormState,
  MetadataFormState,
  MintFormState,
} from "./token-management-workspace.types";

interface TokenActionPrimaryFormsProps {
  activeAction: AdminAction | null;
  isPending: boolean;
  metadataForm: MetadataFormState;
  setMetadataForm: Dispatch<SetStateAction<MetadataFormState>>;
  mintForm: MintFormState;
  setMintForm: Dispatch<SetStateAction<MintFormState>>;
  burnForm: BurnFormState;
  setBurnForm: Dispatch<SetStateAction<BurnFormState>>;
  onUpdateMetadata: () => void;
  onRefreshSupply: () => void;
  onMint: (mode: "prepare" | "execute") => void;
  onBurn: (mode: "prepare" | "execute") => void;
}

export function TokenActionPrimaryForms({
  activeAction,
  isPending,
  metadataForm,
  setMetadataForm,
  mintForm,
  setMintForm,
  burnForm,
  setBurnForm,
  onUpdateMetadata,
  onRefreshSupply,
  onMint,
  onBurn,
}: TokenActionPrimaryFormsProps) {
  return (
    <>
      {activeAction === "update-metadata" ? (
        <TokenActionCard title="Update Metadata" description="Edit token metadata and status.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Name
              <Input
                value={metadataForm.name}
                onChange={(event) =>
                  setMetadataForm((previous) => ({ ...previous, name: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Status
              <select
                className="h-10 w-full rounded-[10px] border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm"
                value={metadataForm.status}
                onChange={(event) =>
                  setMetadataForm((previous) => ({
                    ...previous,
                    status: event.currentTarget.value as "active" | "paused",
                  }))
                }
              >
                <option value="active">active</option>
                <option value="paused">paused</option>
              </select>
            </Label>
            <Label>
              Description
              <Input
                value={metadataForm.description}
                onChange={(event) =>
                  setMetadataForm((previous) => ({
                    ...previous,
                    description: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              URI
              <Input
                value={metadataForm.uri}
                onChange={(event) =>
                  setMetadataForm((previous) => ({ ...previous, uri: event.currentTarget.value }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Image URL
              <Input
                value={metadataForm.imageUrl}
                onChange={(event) =>
                  setMetadataForm((previous) => ({
                    ...previous,
                    imageUrl: event.currentTarget.value,
                  }))
                }
              />
            </Label>
          </div>
          <Button type="button" onClick={onUpdateMetadata} disabled={isPending}>
            Save metadata
          </Button>
        </TokenActionCard>
      ) : null}

      {activeAction === "refresh-supply" ? (
        <TokenActionCard
          title="Refresh Supply"
          description="Fetch supply from RPC and update cache."
        >
          <Button type="button" variant="secondary" onClick={onRefreshSupply} disabled={isPending}>
            Refresh supply
          </Button>
        </TokenActionCard>
      ) : null}

      {activeAction === "mint" ? (
        <TokenActionCard
          title="Mint Tokens"
          description="Mint to destination wallet/token account."
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Destination
              <Input
                value={mintForm.destination}
                onChange={(event) =>
                  setMintForm((previous) => ({
                    ...previous,
                    destination: event.currentTarget.value,
                  }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={mintForm.amount}
                onChange={(event) =>
                  setMintForm((previous) => ({ ...previous, amount: event.currentTarget.value }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Memo
              <Input
                value={mintForm.memo}
                onChange={(event) =>
                  setMintForm((previous) => ({ ...previous, memo: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onMint("prepare")}
              disabled={isPending}
            >
              Mint (prepare)
            </Button>
            <Button type="button" onClick={() => onMint("execute")} disabled={isPending}>
              Mint (execute)
            </Button>
          </div>
        </TokenActionCard>
      ) : null}

      {activeAction === "burn" ? (
        <TokenActionCard title="Burn Tokens" description="Burn from source wallet/token account.">
          <div className="grid gap-3 md:grid-cols-2">
            <Label>
              Source
              <Input
                value={burnForm.source}
                onChange={(event) =>
                  setBurnForm((previous) => ({ ...previous, source: event.currentTarget.value }))
                }
              />
            </Label>
            <Label>
              Amount
              <Input
                value={burnForm.amount}
                onChange={(event) =>
                  setBurnForm((previous) => ({ ...previous, amount: event.currentTarget.value }))
                }
              />
            </Label>
            <Label className="md:col-span-2">
              Memo
              <Input
                value={burnForm.memo}
                onChange={(event) =>
                  setBurnForm((previous) => ({ ...previous, memo: event.currentTarget.value }))
                }
              />
            </Label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onBurn("prepare")}
              disabled={isPending}
            >
              Burn (prepare)
            </Button>
            <Button type="button" onClick={() => onBurn("execute")} disabled={isPending}>
              Burn (execute)
            </Button>
          </div>
        </TokenActionCard>
      ) : null}
    </>
  );
}

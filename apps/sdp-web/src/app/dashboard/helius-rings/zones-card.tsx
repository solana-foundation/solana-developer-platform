"use client";

import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { createRingsZone, type RingsWallet, type RingsZone } from "./helius-rings.data";
import { useRingsZones } from "./use-rings-zones";

/**
 * Zone management for one wallet. Zones are SDP-owned metadata, so this card
 * is fully functional today — no gateway involved.
 */
export function ZonesCard({ wallets }: { wallets: RingsWallet[] }) {
  const t = useTranslations();

  const [walletId, setWalletId] = useState<string | null>(wallets[0]?.id ?? null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<RingsZone["kind"]>("treasury");
  const [creating, setCreating] = useState(false);

  const { zones, reload } = useRingsZones(walletId, t("DashboardHeliusRings.errors.loadFailed"));

  const handleCreate = useCallback(async () => {
    if (!walletId || !name.trim()) return;
    setCreating(true);
    await createRingsZone({ walletId, name: name.trim(), kind });
    setCreating(false);
    setName("");
    await reload();
  }, [walletId, name, kind, reload]);

  if (wallets.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.zones.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.zones.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex min-w-52 flex-col gap-1.5">
          <span className="text-sm font-medium text-primary">
            {t("DashboardHeliusRings.composer.wallet")}
          </span>
          <Select
            ariaLabel={t("DashboardHeliusRings.composer.wallet")}
            value={walletId}
            onValueChange={setWalletId}
          >
            {wallets.map((wallet) => (
              <SelectItem key={wallet.id} value={wallet.id}>
                {wallet.name}
              </SelectItem>
            ))}
          </Select>
        </div>

        {zones.length === 0 ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.zones.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {zones.map((zone) => (
              <li key={zone.id} className="flex items-center gap-2">
                <span className="text-sm text-primary">{zone.name}</span>
                <Badge variant="outline">{t(`DashboardHeliusRings.zones.kind_${zone.kind}`)}</Badge>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-44 flex-col gap-1.5">
            <span className="text-sm font-medium text-primary">
              {t("DashboardHeliusRings.zones.nameLabel")}
            </span>
            <Input
              value={name}
              placeholder={t("DashboardHeliusRings.zones.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex min-w-40 flex-col gap-1.5">
            <span className="text-sm font-medium text-primary">
              {t("DashboardHeliusRings.zones.kindLabel")}
            </span>
            <Select
              ariaLabel={t("DashboardHeliusRings.zones.kindLabel")}
              value={kind}
              onValueChange={(value) => {
                if (value) setKind(value as RingsZone["kind"]);
              }}
            >
              <SelectItem value="treasury">
                {t("DashboardHeliusRings.zones.kind_treasury")}
              </SelectItem>
              <SelectItem value="public">{t("DashboardHeliusRings.zones.kind_public")}</SelectItem>
            </Select>
          </div>
          <Button disabled={creating || !name.trim()} onClick={() => void handleCreate()}>
            {t("DashboardHeliusRings.zones.create")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

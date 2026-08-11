import type {
  CustodyWalletSummary,
  PrivateChannelDto,
  PrivateChannelMembershipChannelDto,
  PrivateChannelVerifiedWalletDto,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  createTransferScopeKey,
  intersectEligibleTransferChannels,
  intersectVerifiedSourceWallets,
} from "./transfer-page-data";

function custodyWallet(walletId: string, publicKey: string, label: string): CustodyWalletSummary {
  return {
    id: `custody_${walletId}`,
    custodyConfigId: "custody-config-1",
    isRuntimeExecutionAllowed: true,
    walletId,
    publicKey,
    label,
    purpose: null,
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

function verifiedWallet(
  id: string,
  walletId: string,
  pubkey: string
): PrivateChannelVerifiedWalletDto {
  return {
    id,
    walletId,
    pubkey,
    verifiedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("intersectVerifiedSourceWallets", () => {
  it("keeps only signable wallets verified for the acting user by walletId and pubkey", () => {
    const eligible = custodyWallet(
      "wallet_eligible",
      "Eligible111111111111111111111111111111111",
      "Eligible"
    );
    const changedAddress = custodyWallet(
      "wallet_changed",
      "Current2222222222222222222222222222222222",
      "Changed"
    );
    const otherWallet = custodyWallet(
      "wallet_other",
      "Other333333333333333333333333333333333333",
      "Other"
    );

    expect(
      intersectVerifiedSourceWallets(
        [eligible, changedAddress, otherWallet],
        [
          verifiedWallet("pcvw_eligible", eligible.walletId, eligible.publicKey),
          verifiedWallet(
            "pcvw_stale",
            changedAddress.walletId,
            "Stale22222222222222222222222222222222222"
          ),
          verifiedWallet("pcvw_wrong_id", "wallet_not_signable", otherWallet.publicKey),
        ]
      )
    ).toEqual([eligible]);
  });

  it("does not duplicate a source when verification data contains duplicate matches", () => {
    const wallet = custodyWallet(
      "wallet_eligible",
      "Eligible111111111111111111111111111111111",
      "Eligible"
    );

    expect(
      intersectVerifiedSourceWallets(
        [wallet],
        [
          verifiedWallet("pcvw_one", wallet.walletId, wallet.publicKey),
          verifiedWallet("pcvw_two", wallet.walletId, wallet.publicKey),
        ]
      )
    ).toEqual([wallet]);
  });
});

describe("createTransferScopeKey", () => {
  it("identifies the organization, project, and private-channel instance", () => {
    expect(createTransferScopeKey("org_one", "project_two", "instance_three")).toBe(
      "org_one:project_two:instance_three"
    );
  });
});

describe("intersectEligibleTransferChannels", () => {
  const memberships: PrivateChannelMembershipChannelDto[] = [
    {
      id: "channel_member_second",
      name: "Member second",
      isDefault: false,
    },
    {
      id: "channel_archived",
      name: "Archived",
      isDefault: false,
    },
    {
      id: "channel_stale_instance",
      name: "Stale instance",
      isDefault: false,
    },
    {
      id: "channel_member_first",
      name: "Member first",
      isDefault: true,
    },
  ];
  const activeChannels: PrivateChannelDto[] = [
    {
      id: "channel_member_first",
      name: "Active first",
      description: null,
      isDefault: true,
      status: "active",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    {
      id: "channel_member_second",
      name: "Active second",
      description: null,
      isDefault: false,
      status: "active",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
  ];

  it("excludes archived and disconnected-instance memberships in membership order", () => {
    expect(intersectEligibleTransferChannels(memberships, activeChannels)).toEqual([
      memberships[0],
      memberships[3],
    ]);
  });

  it("returns an empty choice list when memberships and active channels do not overlap", () => {
    expect(
      intersectEligibleTransferChannels(
        [
          {
            id: "channel_old",
            name: "Old",
            isDefault: true,
          },
        ],
        activeChannels
      )
    ).toEqual([]);
  });
});

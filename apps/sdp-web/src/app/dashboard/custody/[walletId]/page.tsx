import { withLegacyDesign } from "@/flags/new-design";
import LegacyWalletDetailPage from "../_legacy/[walletId]/wallet-detail-page";
import WalletDetailPage from "./wallet-detail-page";

export default withLegacyDesign(WalletDetailPage, LegacyWalletDetailPage);

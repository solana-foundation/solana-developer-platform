import { withLegacyDesign } from "@/flags/new-design";
import { WalletDetailPage as LegacyWalletDetailPage } from "./wallet-detail-page";
import { WalletDetailPage } from "./wallet-detail-page.redesign";

export default withLegacyDesign(WalletDetailPage, LegacyWalletDetailPage, "wallets");

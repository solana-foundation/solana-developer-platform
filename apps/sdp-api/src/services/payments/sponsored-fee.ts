/**
 * The network fee a transfer's source wallet paid, in lamports, when SDP's sponsor was the fee
 * payer: nothing. A transfer row's `fee` is what the source wallet paid, so a sponsored send
 * records 0 ("None charged") rather than leaving it unknown (HOO-2614). The sponsor's own spend
 * is accounted in the sponsorship budget, not on the tenant's transfer.
 */
export const SPONSORED_WALLET_FEE_LAMPORTS = 0;

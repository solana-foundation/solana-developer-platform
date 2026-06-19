# Workspace→project mapping: the `mainnet-sdp` workspace uses this file as-is (project below).
# The legacy `mainnet` workspace targets trading-prod-494016 and MUST be applied with
# `-var project_id=trading-prod-494016` — it is being decommissioned (PRO-1324). Never apply the
# `mainnet` workspace with this file's default project_id or Terraform will try to move its state.
# Same project as devnet — connector_cidr must not overlap devnet's.
project_id           = "solana-developer-platform"
env                  = "mainnet"
min_scale            = 1
connector_cidr       = "10.8.1.0/28"
redis_tier           = "STANDARD_HA"
kms_protection_level = "SOFTWARE" # TODO: evaluate HSM

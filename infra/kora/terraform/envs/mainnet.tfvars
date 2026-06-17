# Same project as devnet — connector_cidr must not overlap devnet's.
project_id           = "solana-developer-platform"
env                  = "mainnet"
min_scale            = 1
connector_cidr       = "10.8.1.0/28"
redis_tier           = "STANDARD_HA"
kms_protection_level = "SOFTWARE" # TODO: evaluate HSM

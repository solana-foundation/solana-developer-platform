terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Shared remote state (versioned GCS bucket). Per-env states are isolated by workspace
  # (default / mainnet / mainnet-sdp), stored under <prefix>/<workspace>.tfstate.
  backend "gcs" {
    bucket = "solana-developer-platform-kora-tfstate"
    prefix = "kora"
  }
}

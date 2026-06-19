terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Shared remote state (versioned GCS bucket); per-env states are isolated by workspace.
  backend "gcs" {
    bucket = "solana-developer-platform-kora-tfstate"
    prefix = "kora"
  }
}

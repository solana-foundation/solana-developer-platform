terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Local state for review. Before real applies, switch to a GCS backend keyed per env
  # (terraform init -backend-config) so devnet/mainnet states don't collide.
}

variable "project_id" {
  type        = string
  description = "Target GCP project for this env."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "env" {
  type        = string
  description = "devnet | mainnet. Drives kora-<env>-* names."
  validation {
    condition     = contains(["devnet", "mainnet"], var.env)
    error_message = "env must be one of: devnet, mainnet."
  }
}

variable "labels" {
  type    = map(string)
  default = { app = "kora" }
}

variable "kms_location" {
  type    = string
  default = "us-central1"
}

variable "kms_protection_level" {
  type        = string
  default     = "SOFTWARE"
  description = "TODO(mainnet): evaluate HSM (confirm EC_SIGN_ED25519 at HSM level first)."
  validation {
    condition     = contains(["SOFTWARE", "HSM"], var.kms_protection_level)
    error_message = "kms_protection_level must be SOFTWARE or HSM."
  }
}

variable "bootstrap_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
  description = "Initial apply only; real image+env are deployed by the pipeline (ignored thereafter)."
}

variable "min_scale" {
  type    = number
  default = 1
}

variable "max_scale" {
  type    = number
  default = 5
}

variable "cpu" {
  type    = string
  default = "1000m"
}

variable "memory" {
  type    = string
  default = "512Mi"
}

variable "allow_unauthenticated" {
  type        = bool
  default     = true
  description = "allUsers run.invoker. Kora's API key/HMAC is the real gate."
}

variable "deletion_protection" {
  type        = bool
  default     = true
  description = "Cloud Run deletion protection. Keep true for real envs; set false for throwaway."
}

variable "vpc_network" {
  type    = string
  default = "default"
}

variable "connector_cidr" {
  type        = string
  description = "Free /28 on vpc_network for the Serverless VPC connector. Must not overlap others in the project."
}

variable "redis_tier" {
  type    = string
  default = "BASIC"
}

variable "redis_memory_gb" {
  type    = number
  default = 1
}

variable "github_repo" {
  type    = string
  default = "solana-foundation/solana-developer-platform"
}

variable "github_ref" {
  type    = string
  default = "refs/heads/main"
}

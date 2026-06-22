# EC_SIGN_ED25519 = Solana-compatible Ed25519. Asymmetric keys have no auto-rotation: a new version
# is a new pubkey = a new fee-payer address (fund it, drain the old). KMS keys/rings can't be deleted.
resource "google_kms_key_ring" "kora" {
  name     = local.name_prefix
  location = var.kms_location
}

resource "google_kms_crypto_key" "fee_payer" {
  name     = "fee-payer"
  key_ring = google_kms_key_ring.kora.id
  purpose  = "ASYMMETRIC_SIGN"
  labels   = local.labels

  version_template {
    algorithm        = "EC_SIGN_ED25519"
    protection_level = var.kms_protection_level
  }

  # Guard the signing key — it is the fee-payer identity (prevent_destroy must be a literal, not a var).
  lifecycle {
    prevent_destroy = true
  }
}

# Runtime SA may sign with only this key — the isolation boundary.
resource "google_kms_crypto_key_iam_member" "runtime_signer" {
  crypto_key_id = google_kms_crypto_key.fee_payer.id
  role          = "roles/cloudkms.signer"
  member        = "serviceAccount:${google_service_account.runtime.email}"
}

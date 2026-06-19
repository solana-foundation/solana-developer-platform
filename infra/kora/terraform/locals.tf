locals {
  name_prefix = "kora-${var.env}"
  labels      = merge(var.labels, { env = var.env })
}

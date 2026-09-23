# Origin-verify secret. CloudFront sends it to the API as the x-origin-verify header; the function
# reads the same value from SSM (short cache) and answers 403 to /api calls without it, so the
# execute-api URL cannot be used to bypass CloudFront and the WAF.
#
# Decision: letters and digits only, 48 characters (about 285 bits). No characters that need
# escaping in an HTTP header.
resource "random_password" "origin_verify" {
  length  = 48
  special = false

  keepers = {
    rotation = var.origin_secret_rotation
  }
}

resource "aws_ssm_parameter" "origin_verify" {
  name        = "/${local.name}/origin-verify-secret"
  description = "CloudFront to API origin secret (x-origin-verify). Managed by infra/terraform/platform."
  type        = "SecureString"
  value       = random_password.origin_verify.result
}

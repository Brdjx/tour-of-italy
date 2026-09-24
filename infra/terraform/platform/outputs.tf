# Read by .github/scripts/apply-platform.sh and by the pinning step in docs/deploy.md.
# check-infra-contract.py fails CI if web_bucket_name or distribution_id (the deploy needs them)
# or one of the pinned-id outputs below disappears.

output "web_bucket_name" {
  description = "Bucket the static site is uploaded to."
  value       = aws_s3_bucket.web.bucket
}

output "distribution_id" {
  description = "CloudFront distribution to invalidate after an upload."
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_domain" {
  description = "CloudFront host name (the alias records point here)."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "site_url" {
  description = "Public URL of the site."
  value       = local.site_url
}

output "api_distribution_domain" {
  description = "CloudFront host name of the API host (its alias records point here)."
  value       = aws_cloudfront_distribution.api.domain_name
}

output "api_url" {
  description = "Public URL of the API host (paths without /api, for example /health)."
  value       = local.api_url
}

# The next four, with distribution_id and the SAM output HttpApiId, are pinned in
# infra/terraform/bootstrap after the first deploy so the CI roles can reach exactly these.
output "api_distribution_id" {
  description = "CloudFront distribution of the API host (bootstrap api_distribution_id)."
  value       = aws_cloudfront_distribution.api.id
}

output "origin_access_control_id" {
  description = "Origin access control of the web bucket (bootstrap origin_access_control_id)."
  value       = aws_cloudfront_origin_access_control.web.id
}

output "response_headers_policy_id" {
  description = "Security headers policy (bootstrap response_headers_policy_id)."
  value       = aws_cloudfront_response_headers_policy.security.id
}

output "certificate_arn" {
  description = "Certificate of both host names; its last part is the bootstrap certificate_id."
  value       = aws_acm_certificate.site.arn
}

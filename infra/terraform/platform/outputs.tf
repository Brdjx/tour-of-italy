# Read by .github/scripts/apply-platform.sh. web_bucket_name and distribution_id are required by
# the deploy (check-infra-contract.py fails CI if either disappears).

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

# The next three, with distribution_id and the SAM output HttpApiId, are pinned in
# infra/terraform/bootstrap after the first deploy so the CI roles can reach exactly these.
output "origin_access_control_id" {
  description = "Origin access control of the web bucket (bootstrap origin_access_control_id)."
  value       = aws_cloudfront_origin_access_control.web.id
}

output "response_headers_policy_id" {
  description = "Security headers policy (bootstrap response_headers_policy_id)."
  value       = aws_cloudfront_response_headers_policy.security.id
}

output "certificate_arn" {
  description = "Site certificate; its last part is the bootstrap certificate_id."
  value       = aws_acm_certificate.site.arn
}

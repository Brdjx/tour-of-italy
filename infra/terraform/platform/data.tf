# Inputs this configuration reads but does not own.

# The SAM stack must exist first (deploy.yml runs sam deploy before this). Its HttpApiDomain
# output is the origin of the site's /api/* behavior and of the API host.
data "aws_cloudformation_stack" "api" {
  name = var.api_stack_name
}

locals {
  api_origin_domain = lookup(data.aws_cloudformation_stack.api.outputs, "HttpApiDomain", "")

  # Decision: AWS managed CloudFront policies by their fixed ids instead of name lookups. AWS
  # documents these ids as constants (checked with aws cloudfront list-cache-policies --type
  # managed and list-origin-request-policies --type managed). Literal ids let the tests prove
  # which policy each behavior uses (mocked lookups return no ids), and the CI roles need no
  # account-wide policy reads. A wrong id fails the apply; it can never pick another policy.
  managed_policy_ids = {
    caching_optimized             = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    caching_disabled              = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    all_viewer_except_host_header = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  }
}

# Plan role: exactly the reads `terraform plan` of infra/terraform/platform needs, and nothing
# that returns data from other stacks.
#
# Known exposure: the plan reads the platform state and the distribution config, and both hold
# the origin-verify secret. Pull request code runs with this role, so whoever can start a plan
# (github_actor_ids) is trusted with that secret. See docs/deploy.md.
#
# Decision: a custom allow list instead of ReadOnlyAccess or ViewOnlyAccess. ReadOnlyAccess can
# read objects, parameters and logs of every stack in this shared account. Even ViewOnlyAccess
# leaks: lambda:ListFunctions returns every function's environment variables and
# cloudfront:ListDistributions returns origin custom headers. A missing read here fails the plan
# loudly, which is the safe direction.

locals {
  plan_read_all_statements = [
    {
      Sid      = "PlatformStateRead"
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = [local.platform_state_arn]
    },
    {
      Sid       = "PlatformStateList"
      Effect    = "Allow"
      Action    = ["s3:ListBucket"]
      Resource  = [local.state_bucket_arn]
      Condition = { StringLikeIfExists = { "s3:prefix" = ["env:/*", "tour-of-italy/*"] } }
    },
    {
      Sid      = "ApiStackOutputs"
      Effect   = "Allow"
      Action   = ["cloudformation:DescribeStacks", "cloudformation:GetTemplate"]
      Resource = [local.stack_arn]
    },
    {
      Sid      = "OriginVerifySecretRead"
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:ListTagsForResource"]
      Resource = [local.origin_secret_param_arn]
    },
    {
      Sid      = "CertificateRead"
      Effect   = "Allow"
      Action   = ["acm:DescribeCertificate", "acm:GetCertificate", "acm:ListTagsForCertificate"]
      Resource = local.certificate_arns
    },
    {
      Sid      = "DnsRead"
      Effect   = "Allow"
      Action   = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListTagsForResource", "route53:GetChange"]
      Resource = [local.zone_arn, "arn:aws:route53:::change/*"]
    },
    {
      # Bucket-level ARN only: bucket settings, never object contents.
      Sid      = "WebBucketSettingsRead"
      Effect   = "Allow"
      Action   = ["s3:Get*", "s3:ListBucket"]
      Resource = ["arn:aws:s3:::${local.web_bucket}"]
    },
    {
      Sid      = "DistributionRead"
      Effect   = "Allow"
      Action   = ["cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:ListTagsForResource"]
      Resource = local.distribution_arns
    },
    {
      Sid      = "OriginAccessControlRead"
      Effect   = "Allow"
      Action   = ["cloudfront:GetOriginAccessControl"]
      Resource = local.oac_arns
    },
    {
      Sid      = "SecurityHeadersRead"
      Effect   = "Allow"
      Action   = ["cloudfront:GetResponseHeadersPolicy"]
      Resource = local.headers_policy_arns
    },
    {
      Sid      = "EdgeFunctionRead"
      Effect   = "Allow"
      Action   = ["cloudfront:DescribeFunction", "cloudfront:GetFunction", "cloudfront:ListTagsForResource"]
      Resource = [local.cf_function_arn]
    },
    {
      Sid      = "WebAclRead"
      Effect   = "Allow"
      Action   = ["wafv2:GetWebACL", "wafv2:ListTagsForResource"]
      Resource = [local.web_acl_arn]
    },
    {
      # Decision: documented wildcard. Reads with no resource scope; they return account-wide
      # metadata (parameter names and descriptions, certificate and web ACL names), no values.
      Sid      = "ConfigReadWithoutResourceScope"
      Effect   = "Allow"
      Action   = ["ssm:DescribeParameters", "acm:ListCertificates", "wafv2:ListWebACLs"]
      Resource = ["*"]
    },
  ]

  # A statement whose pinned id is not set yet has no resources and is left out.
  plan_read_statements = [for s in local.plan_read_all_statements : s if length(s.Resource) > 0]

  plan_guardrail_statements = [
    {
      Sid         = "DenyObjectReadsExceptPlatformState"
      Effect      = "Deny"
      Action      = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAttributes"]
      NotResource = [local.platform_state_arn]
    },
    {
      Sid         = "DenyParameterReadsExceptOriginSecret"
      Effect      = "Deny"
      Action      = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath"]
      NotResource = [local.origin_secret_param_arn]
    },
    {
      Sid      = "DenySecretValues"
      Effect   = "Deny"
      Action   = ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"]
      Resource = ["*"]
    },
    {
      Sid       = "DenyDecryptOutsideSsm"
      Effect    = "Deny"
      Action    = ["kms:Decrypt"]
      Resource  = ["*"]
      Condition = { StringNotEquals = { "kms:ViaService" = local.ssm_service } }
    },
    {
      Sid       = "DenyDecryptOutsideOriginSecret"
      Effect    = "Deny"
      Action    = ["kms:Decrypt"]
      Resource  = ["*"]
      Condition = { StringNotEquals = { "kms:EncryptionContext:PARAMETER_ARN" = local.origin_secret_param_arn } }
    },
  ]
}

resource "aws_iam_policy" "plan_read" {
  name        = "${local.name}-plan-read"
  description = "Plan role: reads needed by terraform plan of infra/terraform/platform."
  policy      = jsonencode({ Version = "2012-10-17", Statement = local.plan_read_statements })
}

resource "aws_iam_policy" "plan_guardrails" {
  name        = "${local.name}-plan-guardrails"
  description = "Plan role: explicit denies on data reads outside this project."
  policy      = jsonencode({ Version = "2012-10-17", Statement = local.plan_guardrail_statements })
}

# Deploy role, part 2: what `terraform apply` of infra/terraform/platform and the web upload need.
#
# Decision: as in part 1, CI updates and an admin creates. The certificate, the two distributions
# (site and API host), the origin access control and the response headers policy have generated
# ids and exist after the first (admin) apply, so CI gets rights on exactly those ids: no create,
# no delete, no tagging of anything else. A change that would replace one of them fails before
# anything is deleted.

locals {
  deploy_platform_all_statements = [
    {
      Sid      = "PlatformStateObjects"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = ["${local.platform_state_arn}*"] # the state and its .tflock file
    },
    {
      # Decision: IfExists, because S3 answers a missing state file with 404 only when the caller
      # holds an unprefixed ListBucket; without it the first run fails with 403. Prefixed lists
      # (workspaces use env:/) stay limited to this project's keys. Key names only, never content.
      Sid       = "PlatformStateList"
      Effect    = "Allow"
      Action    = ["s3:ListBucket"]
      Resource  = [local.state_bucket_arn]
      Condition = { StringLikeIfExists = { "s3:prefix" = ["env:/*", "tour-of-italy/*"] } }
    },
    {
      Sid    = "OriginVerifySecret"
      Effect = "Allow"
      Action = [
        "ssm:PutParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:DeleteParameter",
        "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:ListTagsForResource",
      ]
      Resource = [local.origin_secret_param_arn]
    },
    {
      Sid      = "SsmDescribe"
      Effect   = "Allow"
      Action   = ["ssm:DescribeParameters"]
      Resource = ["*"]
    },
    {
      Sid    = "Certificate"
      Effect = "Allow"
      Action = [
        "acm:DescribeCertificate", "acm:GetCertificate", "acm:ListTagsForCertificate",
        "acm:AddTagsToCertificate", "acm:RemoveTagsFromCertificate",
      ]
      Resource = local.certificate_arns
    },
    {
      # Read-only calls with no resource scope. They return account-wide metadata (certificate
      # and web ACL names, AWS managed rule groups), never secrets.
      Sid      = "ReadWithoutResourceScope"
      Effect   = "Allow"
      Action   = ["acm:ListCertificates", "wafv2:CheckCapacity", "wafv2:ListWebACLs", "wafv2:DescribeManagedRuleGroup", "wafv2:ListAvailableManagedRuleGroups"]
      Resource = ["*"]
    },
    {
      # Only the A and AAAA records of the two host names, and only in the brdjx.com zone.
      Sid      = "DnsSiteRecords"
      Effect   = "Allow"
      Action   = ["route53:ChangeResourceRecordSets"]
      Resource = [local.zone_arn]
      Condition = {
        "ForAllValues:StringEquals" = {
          "route53:ChangeResourceRecordSetsNormalizedRecordNames" = local.host_names
          "route53:ChangeResourceRecordSetsRecordTypes"           = ["A", "AAAA"]
        }
        Null = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = "false" }
      }
    },
    {
      # ACM validation records are CNAMEs named _<token>.<host name>, one per certificate name
      # (the token is exactly 32 characters, arns.tf).
      Sid      = "DnsCertificateValidation"
      Effect   = "Allow"
      Action   = ["route53:ChangeResourceRecordSets"]
      Resource = [local.zone_arn]
      Condition = {
        "ForAllValues:StringLike"   = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = local.validation_names }
        "ForAllValues:StringEquals" = { "route53:ChangeResourceRecordSetsRecordTypes" = ["CNAME"] }
        Null                        = { "route53:ChangeResourceRecordSetsNormalizedRecordNames" = "false" }
      }
    },
    {
      Sid      = "DnsRead"
      Effect   = "Allow"
      Action   = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ListTagsForResource", "route53:GetChange"]
      Resource = [local.zone_arn, "arn:aws:route53:::change/*"]
    },
    {
      # Bucket-level ARN only: s3:Get* here covers bucket settings, never object contents.
      Sid    = "WebBucketSettings"
      Effect = "Allow"
      Action = [
        "s3:CreateBucket", "s3:ListBucket", "s3:Get*", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy",
        "s3:PutBucketPublicAccessBlock", "s3:PutBucketOwnershipControls",
        "s3:PutEncryptionConfiguration", "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration",
        "s3:PutBucketTagging",
      ]
      Resource = ["arn:aws:s3:::${local.web_bucket}"]
    },
    {
      Sid      = "WebBucketObjects"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      Resource = ["arn:aws:s3:::${local.web_bucket}/*"]
    },
    {
      # No create or delete: both distributions are created by the first admin apply and
      # removed only in an admin teardown.
      Sid    = "CloudFrontDistributions"
      Effect = "Allow"
      Action = [
        "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig",
        "cloudfront:UpdateDistribution", "cloudfront:ListTagsForResource",
        "cloudfront:TagResource", "cloudfront:UntagResource",
      ]
      Resource = local.distribution_arns
    },
    {
      # Decision: invalidations on the site only. The API host caches nothing, so CI has no
      # reason to invalidate it.
      Sid      = "CloudFrontSiteInvalidation"
      Effect   = "Allow"
      Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation", "cloudfront:ListInvalidations"]
      Resource = local.site_distribution_arns
    },
    {
      Sid    = "CloudFrontFunctions"
      Effect = "Allow"
      Action = [
        "cloudfront:DescribeFunction", "cloudfront:GetFunction", "cloudfront:UpdateFunction",
        "cloudfront:PublishFunction", "cloudfront:ListTagsForResource",
        "cloudfront:TagResource", "cloudfront:UntagResource",
      ]
      Resource = [local.cf_function_arn]
    },
    {
      # Origin access controls and response headers policies cannot be tagged or named in IAM,
      # so the pinned id is the only scope that keeps other stacks' objects out of reach.
      Sid      = "CloudFrontOriginAccessControl"
      Effect   = "Allow"
      Action   = ["cloudfront:GetOriginAccessControl", "cloudfront:UpdateOriginAccessControl"]
      Resource = local.oac_arns
    },
    {
      Sid      = "CloudFrontSecurityHeaders"
      Effect   = "Allow"
      Action   = ["cloudfront:GetResponseHeadersPolicy", "cloudfront:UpdateResponseHeadersPolicy"]
      Resource = local.headers_policy_arns
    },
    {
      Sid      = "WebAclWithManagedRules"
      Effect   = "Allow"
      Action   = ["wafv2:CreateWebACL", "wafv2:UpdateWebACL"]
      Resource = [local.web_acl_arn, local.managed_rulesets_arn]
    },
    {
      Sid    = "WebAcl"
      Effect = "Allow"
      Action = [
        "wafv2:GetWebACL", "wafv2:ListTagsForResource", "wafv2:TagResource", "wafv2:UntagResource",
      ]
      Resource = [local.web_acl_arn]
    },
  ]

  # A statement whose pinned id is not set yet has no resources and is left out.
  deploy_platform_statements = [for s in local.deploy_platform_all_statements : s if length(s.Resource) > 0]
}

resource "aws_iam_policy" "deploy_platform" {
  name        = "${local.name}-deploy-platform"
  description = "Deploy role: infra/terraform/platform (edge, DNS, certificate, WAF, web bucket)."
  policy      = jsonencode({ Version = "2012-10-17", Statement = local.deploy_platform_statements })
}

# Deploy role, part 3: explicit denies. None of these actions is allowed by parts 1 and 2 today;
# the denies keep it that way if an allow is ever widened by mistake, because an explicit deny
# always wins over any allow.

locals {
  ci_identity_arns = [
    "arn:aws:iam::${local.account}:role/${local.name}-github-*",
    "arn:aws:iam::${local.account}:policy/${local.name}-*",
  ]

  deploy_guardrail_statements = [
    {
      # Global services (IAM, STS, CloudFront, Route 53) are exempt; this project runs in us-east-1.
      Sid       = "DenyOtherRegions"
      Effect    = "Deny"
      NotAction = ["iam:*", "sts:*", "cloudfront:*", "route53:*"]
      Resource  = ["*"]
      Condition = { StringNotEquals = { "aws:RequestedRegion" = local.region } }
    },
    {
      Sid    = "DenyIdentityEscalation"
      Effect = "Deny"
      Action = [
        "iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile",
        "iam:AttachUserPolicy", "iam:PutUserPolicy", "iam:AddUserToGroup", "iam:CreatePolicy",
        "iam:CreatePolicyVersion", "iam:SetDefaultPolicyVersion", "iam:DeletePolicy",
        "iam:AttachRolePolicy", "iam:DeleteRolePermissionsBoundary",
        "iam:CreateOpenIDConnectProvider", "iam:DeleteOpenIDConnectProvider",
        "iam:UpdateOpenIDConnectProviderThumbprint", "iam:AddClientIDToOpenIDConnectProvider",
        "iam:CreateSAMLProvider", "iam:UpdateAccountPasswordPolicy", "sts:AssumeRole",
      ]
      Resource = ["*"]
    },
    {
      # Double guard on the boundary: any role write that would leave a role without it fails.
      Sid       = "DenyRoleWithoutBoundary"
      Effect    = "Deny"
      Action    = ["iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary", "iam:UpdateAssumeRolePolicy"]
      Resource  = ["*"]
      Condition = { StringNotEquals = { "iam:PermissionsBoundary" = local.boundary_policy_arn } }
    },
    {
      # CI can read, but never change, its own roles, their policies or the boundary.
      Sid       = "DenyChangingCiIdentities"
      Effect    = "Deny"
      NotAction = ["iam:Get*", "iam:List*"]
      Resource  = local.ci_identity_arns
    },
    {
      # The Anthropic key is read only by the function (through its boundary-capped role).
      Sid      = "DenyReadingTheApiKey"
      Effect   = "Deny"
      Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:PutParameter", "ssm:DeleteParameter"]
      Resource = [local.api_key_param_arn]
    },
    {
      # The only decryption CI needs is SSM reading the origin-verify parameter.
      Sid       = "DenyDecryptOutsideOriginSecret"
      Effect    = "Deny"
      Action    = ["kms:Decrypt"]
      Resource  = ["*"]
      Condition = { StringNotEquals = { "kms:EncryptionContext:PARAMETER_ARN" = local.origin_secret_param_arn } }
    },
    {
      # Shared buckets: no settings changes and no permanent deletes (state history stays).
      Sid    = "DenySharedBucketChanges"
      Effect = "Deny"
      Action = [
        "s3:PutBucket*", "s3:DeleteBucket*", "s3:PutLifecycleConfiguration",
        "s3:PutEncryptionConfiguration", "s3:PutReplicationConfiguration",
        "s3:DeleteObjectVersion",
      ]
      Resource = [
        local.state_bucket_arn, "${local.state_bucket_arn}/*",
        "arn:aws:s3:::${local.artifacts_bucket}", "arn:aws:s3:::${local.artifacts_bucket}/*",
      ]
    },
    {
      # Account-wide settings that other stacks depend on.
      Sid    = "DenyAccountWideChanges"
      Effect = "Deny"
      Action = [
        "s3:PutAccountPublicAccessBlock", "logs:PutResourcePolicy", "logs:DeleteResourcePolicy",
        "organizations:*", "account:*", "budgets:ModifyBudget", "ce:*",
        "cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors", "guardduty:DeleteDetector", "guardduty:UpdateDetector",
        "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder",
      ]
      Resource = ["*"]
    },
    {
      # API Gateway's account settings (the CloudWatch role) are shared by every API here.
      Sid      = "DenyApiGatewayAccountSettings"
      Effect   = "Deny"
      Action   = ["apigateway:PATCH", "apigateway:PUT", "apigateway:POST", "apigateway:DELETE"]
      Resource = ["arn:aws:apigateway:${local.region}::/account"]
    },
  ]
}

resource "aws_iam_policy" "deploy_guardrails" {
  name        = "${local.name}-deploy-guardrails"
  description = "Deploy role: explicit denies that no allow can override."
  policy      = jsonencode({ Version = "2012-10-17", Statement = local.deploy_guardrail_statements })
}

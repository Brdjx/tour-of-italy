# Deploy role, part 1: what `sam deploy` of infra/sam/template.yaml needs to update the stack.
# Everything is scoped to italy-planner names or pinned ids. Remaining wildcards are listed in
# docs/deploy.md with their reason.
#
# Decision: CI updates, an admin creates. The first deploy is run by hand with admin rights, so
# the deploy role gets no create right on resources with generated ids (the HTTP API) and can
# never touch another stack's API. A change that would replace the API fails without changing
# anything, and an admin applies it and re-pins http_api_id.

locals {
  deploy_api_all_statements = [
    {
      Sid    = "SamStack"
      Effect = "Allow"
      Action = [
        "cloudformation:CreateChangeSet", "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet",
        "cloudformation:ListChangeSets", "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources", "cloudformation:ListStackResources",
        "cloudformation:GetTemplate",
      ]
      Resource = [local.stack_arn]
    },
    {
      # samconfig.toml passes stack tags, which CloudFormation authorizes as TagResource on the
      # stack and on each change set sam deploy creates (named samcli-deploy<timestamp>).
      Sid      = "SamStackTags"
      Effect   = "Allow"
      Action   = ["cloudformation:TagResource", "cloudformation:UntagResource"]
      Resource = [local.stack_arn, local.sam_changesets_arn]
    },
    {
      # The AWS::Serverless transform runs with the caller's permissions.
      Sid      = "SamTransform"
      Effect   = "Allow"
      Action   = ["cloudformation:CreateChangeSet"]
      Resource = [local.serverless_xform]
    },
    {
      # Decision: these two take a template, not a stack, so they have no resource scope. Both are
      # read-only checks of the template being deployed.
      Sid      = "TemplateChecks"
      Effect   = "Allow"
      Action   = ["cloudformation:ValidateTemplate", "cloudformation:GetTemplateSummary"]
      Resource = ["*"]
    },
    {
      Sid      = "SamArtifactsObjects"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"]
      Resource = ["arn:aws:s3:::${local.artifacts_bucket}/${var.api_stack_name}/*"]
    },
    {
      Sid      = "SamArtifactsBucket"
      Effect   = "Allow"
      Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
      Resource = ["arn:aws:s3:::${local.artifacts_bucket}"]
    },
    {
      Sid    = "ApiFunction"
      Effect = "Allow"
      Action = [
        "lambda:CreateFunction", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction", "lambda:PublishVersion", "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency", "lambda:PutRuntimeManagementConfig",
        "lambda:PutFunctionRecursionConfig", "lambda:TagResource", "lambda:UntagResource",
        "lambda:RemovePermission", "lambda:Get*", "lambda:ListTags",
        "lambda:ListVersionsByFunction", "lambda:ListAliases",
      ]
      Resource = [local.lambda_function_arn, "${local.lambda_function_arn}:*"]
    },
    {
      # The only resource policy the stack adds: API Gateway may invoke the function.
      Sid       = "ApiFunctionInvokePermission"
      Effect    = "Allow"
      Action    = ["lambda:AddPermission"]
      Resource  = [local.lambda_function_arn]
      Condition = { StringEquals = { "lambda:Principal" = "apigateway.amazonaws.com" } }
    },
    {
      # Roles the stack creates must carry the italy-planner boundary, so a role made by CI can
      # never hold more than the boundary allows, whatever policy the template gives it.
      Sid    = "FunctionRoleWithBoundary"
      Effect = "Allow"
      Action = [
        "iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:UpdateAssumeRolePolicy", "iam:UpdateRole", "iam:UpdateRoleDescription",
        "iam:PutRolePermissionsBoundary",
      ]
      Resource  = [local.function_role_arn]
      Condition = { StringEquals = { "iam:PermissionsBoundary" = local.boundary_policy_arn } }
    },
    {
      Sid    = "FunctionRoleRead"
      Effect = "Allow"
      Action = [
        "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags", "iam:TagRole", "iam:UntagRole",
      ]
      Resource = [local.function_role_arn]
    },
    {
      Sid       = "PassFunctionRoleToLambdaOnly"
      Effect    = "Allow"
      Action    = ["iam:PassRole"]
      Resource  = [local.function_role_arn]
      Condition = { StringEquals = { "iam:PassedToService" = "lambda.amazonaws.com" } }
    },
    {
      # The API itself: read and update (the SAM transform re-imports routes and integrations as
      # the API body), never delete. Scoped to the pinned id, so no other stack's API matches.
      Sid      = "HttpApi"
      Effect   = "Allow"
      Action   = ["apigateway:GET", "apigateway:PATCH", "apigateway:PUT"]
      Resource = local.http_api_arns
    },
    {
      # Its stage, routes, integrations and tags, which have no name or tag scope of their own.
      Sid      = "HttpApiChildren"
      Effect   = "Allow"
      Action   = ["apigateway:GET", "apigateway:POST", "apigateway:PATCH", "apigateway:PUT", "apigateway:DELETE"]
      Resource = local.http_api_child_arns
    },
    {
      Sid    = "FunctionLogGroup"
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource", "logs:TagLogGroup",
        "logs:UntagLogGroup", "logs:ListTagsForResource", "logs:ListTagsLogGroup",
        "logs:GetDataProtectionPolicy",
      ]
      Resource = local.lambda_log_groups
    },
    {
      # Read-only describe calls without resource-level support (the CloudFormation read
      # handler of AWS::Logs::LogGroup calls DescribeResourcePolicies). They return account-wide
      # metadata such as log group names and log resource policies, never log events or secrets.
      Sid      = "DescribeWithoutResourceScope"
      Effect   = "Allow"
      Action   = ["logs:DescribeLogGroups", "logs:DescribeIndexPolicies", "logs:DescribeResourcePolicies", "cloudwatch:DescribeAlarms"]
      Resource = ["*"]
    },
    {
      Sid    = "Alarms"
      Effect = "Allow"
      Action = [
        "cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource",
        "cloudwatch:UntagResource", "cloudwatch:ListTagsForResource",
      ]
      Resource = [local.alarm_arn]
    },
    {
      Sid    = "AlarmTopic"
      Effect = "Allow"
      Action = [
        "sns:CreateTopic", "sns:DeleteTopic", "sns:GetTopicAttributes", "sns:SetTopicAttributes",
        "sns:TagResource", "sns:UntagResource", "sns:ListTagsForResource",
        "sns:ListSubscriptionsByTopic", "sns:Unsubscribe", "sns:GetSubscriptionAttributes",
        "sns:SetSubscriptionAttributes", "sns:GetDataProtectionPolicy",
      ]
      Resource = [local.topic_arn]
    },
    {
      # The trips table (TripsTable in the SAM template): create, change, describe and tag it,
      # never read or write its items. Only tables named italy-planner-* in this account and region.
      # Decision: plus three reads the CloudFormation handler for AWS::DynamoDB::Table makes after
      # every create and update (DescribeContributorInsights, DescribeKinesisStreamingDestination,
      # GetResourcePolicy, from its published handler permissions); without them a deploy fails
      # after the table already exists.
      # Decision: no dynamodb:DeleteTable. The table is Retain on delete and on replacement, so
      # CloudFormation never deletes it, not even when the deploy that created it rolls back; the
      # right would only let CI delete every saved trip. An admin deletes the table by hand.
      # Deletion protection (DeletionProtectionEnabled in the template) is a CreateTable and
      # UpdateTable setting, so it needs no right beyond those two.
      Sid    = "ProjectTables"
      Effect = "Allow"
      Action = [
        "dynamodb:CreateTable", "dynamodb:UpdateTable",
        "dynamodb:DescribeTable", "dynamodb:UpdateTimeToLive", "dynamodb:DescribeTimeToLive",
        "dynamodb:UpdateContinuousBackups", "dynamodb:DescribeContinuousBackups",
        "dynamodb:TagResource", "dynamodb:UntagResource", "dynamodb:ListTagsOfResource",
        "dynamodb:DescribeContributorInsights", "dynamodb:DescribeKinesisStreamingDestination",
        "dynamodb:GetResourcePolicy",
      ]
      Resource = [local.tables_arn]
    },
    {
      Sid       = "AlarmEmailSubscription"
      Effect    = "Allow"
      Action    = ["sns:Subscribe"]
      Resource  = [local.topic_arn]
      Condition = { StringEquals = { "sns:Protocol" = "email" } }
    },
  ]

  # A statement whose pinned id is not set yet has no resources and is left out.
  deploy_api_statements = [for s in local.deploy_api_all_statements : s if length(s.Resource) > 0]
}

resource "aws_iam_policy" "deploy_api" {
  name = "${local.name}-deploy-api"
  # Decision: the description stays as first applied. IAM cannot change a managed policy's
  # description in place, so editing it would replace the policy and its attachment.
  description = "Deploy role: SAM stack ${var.api_stack_name} (Lambda, HTTP API, logs, alarms)."
  policy      = jsonencode({ Version = "2012-10-17", Statement = local.deploy_api_statements })
}

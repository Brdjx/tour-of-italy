# Permissions boundary for every role the deploy role creates (today: the Lambda function role).
# A boundary caps a role: its effective permissions are the intersection of its own policies and
# this document. So even a template change that grants the function role "*" gets only this.
#
# Decision: the boundary only works for the italy-planner-api function's own code. The deploy
# role can write the function role's trust policy (CloudFormation needs that), so a bad template
# could make the role assumable from another account. lambda:SourceFunctionArn is set by Lambda
# on calls from the function's execution environment and on the log writes Lambda makes for it
# (Lambda docs, "Using source function ARN to control function access behavior"); a session
# assumed any other way lacks it, so it gets no parameter reads, no log writes and no trips, and
# the Anthropic key cannot leak to a role trusted from outside.

locals {
  from_the_api_function = { ArnEquals = { "lambda:SourceFunctionArn" = local.lambda_function_arn } }

  boundary_statements = [
    {
      Sid       = "WriteOwnLogs"
      Effect    = "Allow"
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = [local.lambda_log_groups[1]]
      Condition = local.from_the_api_function
    },
    {
      # The trips table: read one record and write new ones, from the function's own code only
      # (services/api/src/trips/dynamoStore.ts). No query, scan, update or delete.
      Sid       = "ReadAndWriteProjectTables"
      Effect    = "Allow"
      Action    = ["dynamodb:GetItem", "dynamodb:PutItem"]
      Resource  = [local.tables_arn]
      Condition = local.from_the_api_function
    },
    {
      Sid       = "ReadProjectParameters"
      Effect    = "Allow"
      Action    = ["ssm:GetParameter", "ssm:GetParameters"]
      Resource  = [local.project_params_arn]
      Condition = local.from_the_api_function
    },
    {
      # SecureString parameters use the AWS managed aws/ssm key; decrypt only through SSM, and
      # only for this project's parameters. Decision: no source function condition here. SSM
      # calls KMS on the function's behalf, and Lambda documents the source function ARN only for
      # direct calls, so the condition could break every parameter read. Reading a parameter
      # still needs ssm:GetParameter above, which does carry the condition.
      Sid      = "DecryptProjectParametersViaSsm"
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = [local.kms_keys_arn]
      Condition = {
        StringEquals = { "kms:ViaService" = local.ssm_service }
        StringLike   = { "kms:EncryptionContext:PARAMETER_ARN" = local.project_params_arn }
      }
    },
  ]
}

resource "aws_iam_policy" "boundary" {
  name        = "${local.name}-boundary"
  description = "Permissions boundary for roles created by the italy-planner deploy role."
  policy      = jsonencode({ Version = "2012-10-17", Statement = local.boundary_statements })
}

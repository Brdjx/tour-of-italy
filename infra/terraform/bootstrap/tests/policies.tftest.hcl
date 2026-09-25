# terraform test, bootstrap root: what the CI roles may do.
# Mocked AWS provider, plan only: no credentials, no AWS calls.
# Each run names the misconfiguration it prevents. Run: terraform -chdir=infra/terraform/bootstrap test

mock_provider "aws" {
  override_during = plan
}

# Pinned ids as they look after the first deploy (pins.tftest.hcl covers the empty case).
variables {
  github_subject_prefix      = "repo:Brdjx@8014925/tour-of-italy@1383701312"
  http_api_id                = "abc123def4"
  distribution_id            = "E2TESTDIST0001"
  api_distribution_id        = "E2TESTAPI00001"
  origin_access_control_id   = "E3TESTOAC00001"
  response_headers_policy_id = "11111111-2222-3333-4444-555555555555"
  certificate_id             = "66666666-7777-8888-9999-000000000000"
}

run "ci_cannot_create_a_role_without_the_permissions_boundary" {
  command = plan

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : s.Condition.StringEquals["iam:PermissionsBoundary"]
      if s.Sid == "FunctionRoleWithBoundary" && contains(s.Action, "iam:CreateRole")
    ]) == "arn:aws:iam::388773186626:policy/italy-planner-boundary"
    error_message = "iam:CreateRole must require the italy-planner boundary."
  }

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.deploy_guardrails.policy).Statement : s.Condition.StringNotEquals["iam:PermissionsBoundary"]
      if s.Sid == "DenyRoleWithoutBoundary" && s.Effect == "Deny" && contains(s.Action, "iam:CreateRole")
    ]) == "arn:aws:iam::388773186626:policy/italy-planner-boundary"
    error_message = "An explicit deny must block roles created without the boundary."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : s.Condition.StringEquals["iam:PassedToService"] == "lambda.amazonaws.com"
      if contains(s.Action, "iam:PassRole")
    ])
    error_message = "iam:PassRole must be limited to the Lambda service."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : s.Resource == ["arn:aws:iam::388773186626:role/italy-planner-api-function"]
      if length([for a in s.Action : a if startswith(a, "iam:")]) > 0
    ])
    error_message = "CI may create, change or pass exactly the function role, never another italy-planner-api-* role."
  }
}

run "a_role_trusted_from_outside_cannot_read_the_anthropic_key" {
  command = plan

  # The deploy role can write the function role's trust policy. The boundary must then make any
  # session that is not the function's own code worthless: no parameter reads, no log writes.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement :
      try(s.Condition.ArnEquals["lambda:SourceFunctionArn"], "") == "arn:aws:lambda:us-east-1:388773186626:function:italy-planner-api"
      if length([for a in s.Action : a if startswith(a, "ssm:") || startswith(a, "logs:")]) > 0
    ])
    error_message = "Boundary parameter reads and log writes must require lambda:SourceFunctionArn of italy-planner-api."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement :
      try(s.Condition.StringEquals["kms:ViaService"], "") == "ssm.us-east-1.amazonaws.com"
      if contains(s.Action, "kms:Decrypt")
    ])
    error_message = "The boundary may only allow decryption through SSM."
  }
}

run "ci_manages_only_this_projects_tables_and_never_their_items" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : s.Resource == ["arn:aws:dynamodb:us-east-1:388773186626:table/italy-planner-*"]
      if length([for a in s.Action : a if startswith(a, "dynamodb:")]) > 0
    ])
    error_message = "CI may manage only DynamoDB tables named italy-planner-* in this account and region."
  }

  # Saved trips are travelers' data: CI creates and changes the table, never reads, writes,
  # shares or deletes it (a resource policy could open it to another account, a stream or a
  # backup could copy it out, and the table is retained, so CloudFormation never deletes it).
  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : [
        for a in s.Action : !contains([
          "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan",
          "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem",
          "dynamodb:PartiQLSelect", "dynamodb:ExportTableToPointInTime", "dynamodb:RestoreTableToPointInTime",
          "dynamodb:DeleteTable", "dynamodb:PutResourcePolicy", "dynamodb:GetRecords",
          "dynamodb:GetShardIterator", "dynamodb:CreateBackup", "dynamodb:EnableKinesisStreamingDestination",
        ], a)
      ]
    ]))
    error_message = "The deploy role must not read, write, export, restore, share or delete table items or tables."
  }

  assert {
    condition = length([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : s
      if contains(s.Action, "dynamodb:CreateTable") && contains(s.Action, "dynamodb:UpdateTable") && contains(s.Action, "dynamodb:UpdateTimeToLive") && contains(s.Action, "dynamodb:UpdateContinuousBackups")
    ]) == 1
    error_message = "CI must be able to create and update the trips table with its time to live, point-in-time recovery and deletion protection (a CreateTable and UpdateTable setting)."
  }
}

run "the_function_may_only_read_and_add_trips" {
  command = plan

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement : s.Action
      if length([for a in s.Action : a if startswith(a, "dynamodb:")]) > 0
    ]) == ["dynamodb:GetItem", "dynamodb:PutItem"]
    error_message = "The boundary may allow only GetItem and PutItem on tables, in one statement."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.boundary.policy).Statement :
      s.Resource == ["arn:aws:dynamodb:us-east-1:388773186626:table/italy-planner-*"] && try(s.Condition.ArnEquals["lambda:SourceFunctionArn"], "") == "arn:aws:lambda:us-east-1:388773186626:function:italy-planner-api"
      if length([for a in s.Action : a if startswith(a, "dynamodb:")]) > 0
    ])
    error_message = "Table access in the boundary must be limited to italy-planner-* tables and the italy-planner-api function's own code."
  }
}

run "ci_cannot_change_its_own_roles_or_the_boundary" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_guardrails.policy).Statement :
      s.Effect == "Deny" && contains(s.Resource, "arn:aws:iam::388773186626:role/italy-planner-github-*") && contains(s.Resource, "arn:aws:iam::388773186626:policy/italy-planner-*")
    ])
    error_message = "The deploy role must be denied changes to the CI roles and italy-planner policies."
  }
}

run "no_allow_statement_grants_a_whole_service_or_everything" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for doc in [aws_iam_policy.deploy_api.policy, aws_iam_policy.deploy_platform.policy, aws_iam_policy.plan_read.policy, aws_iam_policy.boundary.policy] : [
        for s in jsondecode(doc).Statement : [
          for a in s.Action : a != "*" && !endswith(a, ":*")
        ] if s.Effect == "Allow"
      ]
    ]))
    error_message = "Allow statements must list actions, never '*' or '<service>:*'."
  }

  # Resource "*" is only acceptable where AWS offers no resource scope. The list is the documented
  # set; a new unscoped statement fails here until it is reviewed and added.
  assert {
    condition = toset(flatten([
      for doc in [aws_iam_policy.deploy_api.policy, aws_iam_policy.deploy_platform.policy, aws_iam_policy.plan_read.policy] : [
        for s in jsondecode(doc).Statement : s.Sid if s.Effect == "Allow" && contains(s.Resource, "*")
      ]
      ])) == toset([
      "TemplateChecks", "DescribeWithoutResourceScope", "SsmDescribe", "ReadWithoutResourceScope",
      "ConfigReadWithoutResourceScope",
    ])
    error_message = "An allow statement with Resource '*' was added without being reviewed."
  }

  # Account-wide id wildcards match other stacks' resources just like "*" does: every HTTP API
  # and its routes, every tag, distribution, certificate, origin access control, headers policy
  # or table in the shared account.
  assert {
    condition = alltrue(flatten([
      for doc in [aws_iam_policy.deploy_api.policy, aws_iam_policy.deploy_platform.policy, aws_iam_policy.plan_read.policy, aws_iam_policy.boundary.policy] : [
        for s in jsondecode(doc).Statement : [
          for r in s.Resource : length(regexall("(::/apis/\\*|::/tags/\\*|:distribution/\\*|:certificate/\\*|:origin-access-control/\\*|:response-headers-policy/\\*|:role/[^:]*\\*|:table/\\*)", r)) == 0
        ] if s.Effect == "Allow"
      ]
    ]))
    error_message = "An allow statement uses an account-wide id wildcard that also matches other stacks' resources."
  }

  assert {
    condition = alltrue(flatten([
      for doc in [aws_iam_policy.deploy_api.policy, aws_iam_policy.deploy_platform.policy, aws_iam_policy.plan_read.policy] : [
        for s in jsondecode(doc).Statement : length(s.Resource) > 0
      ]
    ]))
    error_message = "A statement has no resources (a pinned id statement must be left out instead)."
  }
}

run "plan_role_cannot_read_data_outside_this_project" {
  command = plan

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.plan_guardrails.policy).Statement : s.NotResource
      if s.Sid == "DenyObjectReadsExceptPlatformState" && s.Effect == "Deny"
    ]) == ["arn:aws:s3:::fortissimo-terraform-state/tour-of-italy/platform.tfstate"]
    error_message = "The plan role must be denied every S3 object read except the platform state."
  }

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.plan_guardrails.policy).Statement : s.NotResource
      if s.Sid == "DenyParameterReadsExceptOriginSecret" && s.Effect == "Deny"
    ]) == ["arn:aws:ssm:us-east-1:388773186626:parameter/italy-planner/origin-verify-secret"]
    error_message = "The plan role must never read the Anthropic key or any other parameter."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.plan_guardrails.policy).Statement :
      s.Effect == "Deny" && contains(s.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "The plan role must be denied Secrets Manager values."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.plan_read.policy).Statement : alltrue([
        for a in s.Action : length(regexall(":(Put|Create|Delete|Update|Tag|Untag|Change|Attach|Pass)", a)) == 0
      ])
    ])
    error_message = "The plan role policy must not contain write actions."
  }
}

run "deploy_role_cannot_read_the_anthropic_key" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_guardrails.policy).Statement :
      s.Effect == "Deny" && contains(s.Action, "ssm:GetParameter") && contains(s.Resource, "arn:aws:ssm:us-east-1:388773186626:parameter/italy-planner/anthropic-api-key")
    ])
    error_message = "The deploy role must be explicitly denied the Anthropic key parameter."
  }
}

run "dns_changes_are_limited_to_the_two_host_names" {
  command = plan

  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : s.Condition["ForAllValues:StringEquals"]["route53:ChangeResourceRecordSetsNormalizedRecordNames"]
      if s.Sid == "DnsSiteRecords"
    ])) == toset(["italy-planner.brdjx.com", "api.italy-planner.brdjx.com"])
    error_message = "Alias record changes must be limited to italy-planner.brdjx.com and api.italy-planner.brdjx.com."
  }

  assert {
    condition = toset(one([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : s.Condition["ForAllValues:StringLike"]["route53:ChangeResourceRecordSetsNormalizedRecordNames"]
      if s.Sid == "DnsCertificateValidation"
    ])) == toset(["_????????????????????????????????.italy-planner.brdjx.com", "_????????????????????????????????.api.italy-planner.brdjx.com"])
    error_message = "Validation record changes must be limited to the ACM names of the two host names."
  }

  # IAM's "*" matches dots too: "_*.<name>" would allow _acme-challenge.<name>, which lets any
  # public CA issue a certificate for the name. ACM tokens are exactly 32 characters.
  assert {
    condition = alltrue([
      for pattern in one([
        for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : s.Condition["ForAllValues:StringLike"]["route53:ChangeResourceRecordSetsNormalizedRecordNames"]
        if s.Sid == "DnsCertificateValidation"
      ]) : !strcontains(pattern, "*") && startswith(pattern, "_${join("", [for i in range(32) : "?"])}.")
    ])
    error_message = "Validation record names must be _ plus exactly 32 characters of ACM token, never a * wildcard."
  }

  # Every record change must be limited by name and type, or the zone's other records are open.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement :
      s.Condition.Null["route53:ChangeResourceRecordSetsNormalizedRecordNames"] == "false" && length(s.Condition["ForAllValues:StringEquals"]["route53:ChangeResourceRecordSetsRecordTypes"]) > 0
      if contains(s.Action, "route53:ChangeResourceRecordSets")
    ])
    error_message = "Every Route 53 change statement must require record names and limit record types."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : s.Resource == ["arn:aws:route53:::hostedzone/Z0808500BKXP102OKNM9"]
      if contains(s.Action, "route53:ChangeResourceRecordSets")
    ])
    error_message = "Route 53 changes must be limited to the brdjx.com hosted zone."
  }
}

run "policies_fit_the_iam_size_limit" {
  command = plan

  assert {
    condition = alltrue([
      for doc in [aws_iam_policy.deploy_api.policy, aws_iam_policy.deploy_platform.policy, aws_iam_policy.deploy_guardrails.policy, aws_iam_policy.plan_read.policy, aws_iam_policy.plan_guardrails.policy, aws_iam_policy.boundary.policy] :
      length(replace(doc, "/\\s/", "")) <= 6144
    ])
    error_message = "A managed policy exceeds the 6,144 character IAM limit and would fail to apply."
  }
}

# Regression: the first CI deploy kept the previous commit's GIT_SHA because the deny below also
# blocked the Decrypt Lambda makes for the function's own environment, and Lambda then kept the
# old environment while reporting success. The deny must still cover every other encryption
# context, so CI cannot read other functions' environments or other SSM parameters.
run "ci_can_update_its_own_function_environment_but_decrypt_nothing_else" {
  command = plan

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.deploy_guardrails.policy).Statement : s.Condition.StringNotEquals
      if s.Sid == "DenyDecryptOutsideOriginSecret"
      ]) == {
      "kms:EncryptionContext:PARAMETER_ARN"          = "arn:aws:ssm:us-east-1:388773186626:parameter/italy-planner/origin-verify-secret"
      "kms:EncryptionContext:aws:lambda:FunctionArn" = "arn:aws:lambda:us-east-1:388773186626:function:italy-planner-api"
    }
    error_message = "The Decrypt deny must exempt exactly the origin-verify parameter and this project's function."
  }

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.deploy_guardrails.policy).Statement : s.Resource
      if s.Sid == "DenyDecryptOutsideOriginSecret"
    ]) == ["*"]
    error_message = "The Decrypt deny must apply to every key."
  }
}

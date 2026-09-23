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
  # and its routes, every tag, distribution, certificate, origin access control or headers
  # policy in the shared account.
  assert {
    condition = alltrue(flatten([
      for doc in [aws_iam_policy.deploy_api.policy, aws_iam_policy.deploy_platform.policy, aws_iam_policy.plan_read.policy, aws_iam_policy.boundary.policy] : [
        for s in jsondecode(doc).Statement : [
          for r in s.Resource : length(regexall("(::/apis/\\*|::/tags/\\*|:distribution/\\*|:certificate/\\*|:origin-access-control/\\*|:response-headers-policy/\\*|:role/[^:]*\\*)", r)) == 0
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

run "dns_changes_are_limited_to_the_site_name" {
  command = plan

  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : s.Condition["ForAllValues:StringEquals"]["route53:ChangeResourceRecordSetsNormalizedRecordNames"]
      if s.Sid == "DnsSiteRecords"
    ]) == ["stripe.brdjx.com"]
    error_message = "Route 53 changes must be limited to stripe.brdjx.com."
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

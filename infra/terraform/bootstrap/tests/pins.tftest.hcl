# terraform test, bootstrap root: CI rights on resources with generated ids (the HTTP API, the
# distribution, its origin access control and headers policy, the certificate) are pinned to the
# ids of this project's resources. Mocked AWS provider, plan only: no credentials, no AWS calls.
# Run: terraform -chdir=infra/terraform/bootstrap test

mock_provider "aws" {
  override_during = plan
}

variables {
  github_subject_prefix      = "repo:Brdjx@8014925/tour-of-italy@1383701312"
  http_api_id                = "abc123def4"
  distribution_id            = "E2TESTDIST0001"
  origin_access_control_id   = "E3TESTOAC00001"
  response_headers_policy_id = "11111111-2222-3333-4444-555555555555"
  certificate_id             = "66666666-7777-8888-9999-000000000000"
}

run "deploy_role_cannot_change_or_delete_another_stacks_http_api" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : [
        for r in s.Resource : strcontains(r, "abc123def4")
      ] if length([for a in s.Action : a if startswith(a, "apigateway:")]) > 0
    ]))
    error_message = "Every API Gateway right must be scoped to this stack's API id (children and tags included)."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : !contains(s.Action, "apigateway:DELETE") && !contains(s.Action, "apigateway:POST")
      if contains(s.Resource, "arn:aws:apigateway:us-east-1::/apis/abc123def4")
    ])
    error_message = "CI must never delete the HTTP API itself or create a new one."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_api.policy).Statement : !contains(s.Resource, "arn:aws:apigateway:us-east-1::/apis")
    ])
    error_message = "CI must not create HTTP APIs; the first deploy is made by an admin."
  }
}

run "deploy_role_cannot_take_over_another_stacks_distribution_or_edge_objects" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : [
        for r in s.Resource : contains([
          "arn:aws:cloudfront::388773186626:distribution/E2TESTDIST0001",
          "arn:aws:cloudfront::388773186626:origin-access-control/E3TESTOAC00001",
          "arn:aws:cloudfront::388773186626:response-headers-policy/11111111-2222-3333-4444-555555555555",
          "arn:aws:cloudfront::388773186626:function/italy-planner-*",
        ], r)
      ] if length([for a in s.Action : a if startswith(a, "cloudfront:")]) > 0
    ]))
    error_message = "Every CloudFront right must be scoped to this project's pinned ids or function names."
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : [
        for a in s.Action : length(regexall("^cloudfront:(Create(Distribution|OriginAccessControl|ResponseHeadersPolicy|Function)|Delete)", a)) == 0
      ]
    ]))
    error_message = "CI must never create or delete distributions, origin access controls, headers policies or functions."
  }
}

run "deploy_role_cannot_tag_then_delete_another_stacks_certificate" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : [
        for r in s.Resource : r == "arn:aws:acm:us-east-1:388773186626:certificate/66666666-7777-8888-9999-000000000000" || r == "*"
      ] if length([for a in s.Action : a if startswith(a, "acm:")]) > 0
    ]))
    error_message = "Certificate rights must be scoped to the site certificate (only ListCertificates may be unscoped)."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement :
      !contains(s.Action, "acm:DeleteCertificate") && !contains(s.Action, "acm:RequestCertificate")
    ])
    error_message = "CI must never request or delete certificates."
  }
}

run "plan_role_reads_only_this_projects_edge_objects" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.plan_read.policy).Statement : [
        for r in s.Resource : r != "*"
      ] if length([for a in s.Action : a if length(regexall("^(cloudfront|acm):(Get|Describe)", a)) > 0]) > 0
    ]))
    error_message = "Plan role Get and Describe calls on CloudFront and ACM must be scoped to pinned ids."
  }
}

run "ci_roles_get_no_rights_on_generated_ids_before_they_are_pinned" {
  command = plan

  variables {
    http_api_id                = ""
    distribution_id            = ""
    origin_access_control_id   = ""
    response_headers_policy_id = ""
    certificate_id             = ""
  }

  # The check block warns on every bootstrap plan and apply until the ids are filled in.
  expect_failures = [check.deployed_ids_are_pinned]

  assert {
    condition = alltrue(flatten([
      for doc in [aws_iam_policy.deploy_api.policy, aws_iam_policy.deploy_platform.policy, aws_iam_policy.plan_read.policy] : [
        for s in jsondecode(doc).Statement : [
          for a in s.Action : !startswith(a, "apigateway:") && length(regexall("^cloudfront:.*(Distribution|OriginAccessControl|ResponseHeadersPolicy|Invalidation)", a)) == 0 && !contains(["acm:DescribeCertificate", "acm:AddTagsToCertificate"], a)
        ]
      ]
    ]))
    error_message = "Without pinned ids the CI roles must hold no API Gateway, distribution or certificate rights at all."
  }

  assert {
    condition     = length(output.unpinned_resource_ids) == 5
    error_message = "The bootstrap must report every id that still needs pinning."
  }
}

run "rejects_wildcards_in_pinned_ids" {
  command = plan

  variables {
    http_api_id     = "*"
    distribution_id = "E*"
    certificate_id  = "*"
  }

  expect_failures = [var.http_api_id, var.distribution_id, var.certificate_id]
}

# terraform test, bootstrap root: CI rights on resources with generated ids (the HTTP API, the
# site and API host distributions, the origin access control and headers policy, the certificate)
# are pinned to the ids of this project's resources. Mocked AWS provider, plan only: no credentials, no AWS calls.
# Run: terraform -chdir=infra/terraform/bootstrap test

mock_provider "aws" {
  override_during = plan
}

variables {
  github_subject_prefix      = "repo:Brdjx@8014925/tour-of-italy@1383701312"
  http_api_id                = "abc123def4"
  distribution_id            = "E2TESTDIST0001"
  api_distribution_id        = "E2TESTAPI00001"
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
          "arn:aws:cloudfront::388773186626:distribution/E2TESTAPI00001",
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

run "ci_roles_can_update_and_read_both_distributions_once_pinned" {
  command = plan

  # Without the API host's id every deploy fails refreshing it, and every plan fails reading it.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement :
      contains(s.Action, "cloudfront:UpdateDistribution") && toset(s.Resource) == toset([
        "arn:aws:cloudfront::388773186626:distribution/E2TESTDIST0001",
        "arn:aws:cloudfront::388773186626:distribution/E2TESTAPI00001",
      ])
    ])
    error_message = "The deploy role must be able to update both pinned distributions."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.plan_read.policy).Statement :
      contains(s.Action, "cloudfront:GetDistributionConfig") && toset(s.Resource) == toset([
        "arn:aws:cloudfront::388773186626:distribution/E2TESTDIST0001",
        "arn:aws:cloudfront::388773186626:distribution/E2TESTAPI00001",
      ])
    ])
    error_message = "The plan role must be able to read both pinned distributions."
  }

  # The API host caches nothing; invalidation rights stay on the site distribution.
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement :
      s.Resource == ["arn:aws:cloudfront::388773186626:distribution/E2TESTDIST0001"]
      if length([for a in s.Action : a if strcontains(a, "Invalidation")]) > 0
    ])
    error_message = "Invalidation rights must cover the site distribution only."
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
    api_distribution_id        = ""
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
    condition     = length(output.unpinned_resource_ids) == 6
    error_message = "The bootstrap must report every id that still needs pinning."
  }
}

run "warns_until_the_api_host_distribution_is_pinned" {
  command = plan

  variables {
    api_distribution_id = ""
  }

  # Pinning five ids and forgetting the sixth would leave every deploy failing on the API host.
  expect_failures = [check.deployed_ids_are_pinned]

  assert {
    condition     = output.unpinned_resource_ids == ["api_distribution_id"]
    error_message = "The bootstrap must name the API host distribution as still unpinned."
  }

  assert {
    condition = alltrue(flatten([
      for doc in [aws_iam_policy.deploy_platform.policy, aws_iam_policy.plan_read.policy] : [
        for s in jsondecode(doc).Statement : [for r in s.Resource : !strcontains(r, "distribution/E2TESTAPI00001")]
      ]
    ]))
    error_message = "An empty API host id must leave no rights on it."
  }
}

run "rejects_the_site_distribution_id_pinned_as_the_api_host" {
  command = plan

  # A copy of the site's id passes the format check and the "pinned" check, and leaves the API
  # host with no rights, so every deploy would fail on it.
  variables {
    distribution_id     = "E2TESTDIST0001"
    api_distribution_id = "E2TESTDIST0001"
  }

  expect_failures = [var.api_distribution_id]
}

run "rejects_wildcards_in_pinned_ids" {
  command = plan

  variables {
    http_api_id         = "*"
    api_distribution_id = "E*"
    certificate_id      = "*"
  }

  expect_failures = [var.http_api_id, var.api_distribution_id, var.certificate_id]
}

# A run of its own: Terraform skips every validation of api_distribution_id while the
# distribution_id it compares against is invalid (the plan still fails on distribution_id).
run "rejects_a_wildcard_site_distribution_id" {
  command = plan

  variables {
    distribution_id = "E*"
  }

  expect_failures = [var.distribution_id]
}

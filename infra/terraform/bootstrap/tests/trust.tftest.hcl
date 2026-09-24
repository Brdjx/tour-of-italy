# terraform test, bootstrap root: who can assume the CI roles, inputs, artifacts bucket.
# Mocked AWS provider, plan only: no credentials, no AWS calls.
# Each run names the misconfiguration it prevents. Run: terraform -chdir=infra/terraform/bootstrap test

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

run "deploy_role_is_not_assumable_outside_deploy_yml_on_main" {
  command = plan

  assert {
    condition = toset(jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]) == toset([
      "repo:Brdjx@8014925/tour-of-italy@1383701312:environment:production",
      "repo:Brdjx@8014925/tour-of-italy@1383701312:ref:refs/heads/main",
    ])
    error_message = "The deploy role must trust exactly the production environment and main subjects of this repository."
  }

  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "The deploy role must require the sts.amazonaws.com audience."
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.deploy.assume_role_policy).Statement) == 1 && keys(jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition) == ["StringEquals"]
    error_message = "The deploy trust policy must use one StringEquals statement (no StringLike wildcards)."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:ref"] == "refs/heads/main" &&
      jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:job_workflow_ref"] == "Brdjx/tour-of-italy/.github/workflows/deploy.yml@refs/heads/main"
    )
    error_message = "Only deploy.yml running from main may assume the deploy role."
  }

  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::388773186626:oidc-provider/token.actions.githubusercontent.com"
    error_message = "The deploy role must trust the existing GitHub OIDC provider."
  }

  assert {
    condition     = aws_iam_role.deploy.max_session_duration == 3600 && aws_iam_role.plan.max_session_duration == 3600
    error_message = "CI sessions must last at most one hour."
  }
}

run "ci_roles_are_not_assumable_by_runs_other_github_accounts_start" {
  command = plan

  # GitHub Free has no branch protection, so a collaborator could push to main or open a pull
  # request with their own workflow code. Only runs started by the listed accounts get AWS access.
  assert {
    condition = alltrue([
      for policy in [aws_iam_role.deploy.assume_role_policy, aws_iam_role.plan.assume_role_policy] :
      jsondecode(policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:actor_id"] == ["8014925"]
    ])
    error_message = "Both CI roles must require the owner's immutable GitHub account id (actor_id)."
  }
}

run "rejects_a_mutable_github_user_name_as_an_actor" {
  command = plan

  variables {
    github_actor_ids = ["Brdjx"]
  }

  expect_failures = [var.github_actor_ids]
}

run "rejects_an_empty_actor_list" {
  command = plan

  variables {
    github_actor_ids = []
  }

  expect_failures = [var.github_actor_ids]
}

run "plan_role_is_not_assumable_outside_pull_request_plans_of_this_repository" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == [
      "repo:Brdjx@8014925/tour-of-italy@1383701312:pull_request",
    ]
    error_message = "The plan role must trust only pull requests of this repository (the plan job never runs on main)."
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "The plan role must require the sts.amazonaws.com audience."
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:job_workflow_ref"] == "Brdjx/tour-of-italy/.github/workflows/ci.yml@refs/pull/*/merge"
    error_message = "Only ci.yml running for a pull request may assume the plan role."
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:ref"] == "refs/pull/*/merge"
    error_message = "The plan role must only serve pull request merge refs, never a branch push."
  }
}

run "rejects_a_wildcard_github_subject" {
  command = plan

  variables {
    github_subject_prefix = "repo:Brdjx/*"
  }

  expect_failures = [var.github_subject_prefix]
}

run "rejects_a_region_other_than_us_east_1" {
  command = plan

  variables {
    region = "eu-west-1"
  }

  expect_failures = [var.region]
}

run "rejects_host_names_outside_the_zone" {
  command = plan

  variables {
    site_domain = "italy-planner.example.com"
  }

  expect_failures = [var.site_domain]
}

# The brdjx.com zone is shared: a name outside the project's subtree would give the deploy role
# another stack's record. A name that only ends in "italy-planner.brdjx.com" is not under it.
run "rejects_a_site_host_outside_the_project_subtree" {
  command = plan

  variables {
    site_domain = "evilitaly-planner.brdjx.com"
  }

  expect_failures = [var.site_domain]
}

# A run of its own: Terraform skips api_domain's validation while site_domain is invalid.
run "rejects_an_api_host_outside_the_project_subtree" {
  command = plan

  variables {
    api_domain = "api.evilitaly-planner.brdjx.com"
  }

  expect_failures = [var.api_domain]
}

run "accepts_host_names_under_the_project_subtree" {
  command = plan

  variables {
    site_domain = "beta.italy-planner.brdjx.com"
    api_domain  = "api.beta.italy-planner.brdjx.com"
  }

  assert {
    condition     = contains(one([for s in jsondecode(aws_iam_policy.deploy_platform.policy).Statement : s.Condition["ForAllValues:StringEquals"]["route53:ChangeResourceRecordSetsNormalizedRecordNames"] if s.Sid == "DnsSiteRecords"]), "api.beta.italy-planner.brdjx.com")
    error_message = "A name under italy-planner.brdjx.com must be accepted and granted."
  }
}

run "rejects_an_api_host_equal_to_the_site_host" {
  command = plan

  variables {
    api_domain = "italy-planner.brdjx.com"
  }

  expect_failures = [var.api_domain]
}

run "artifacts_bucket_is_private_and_tls_only" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.artifacts.block_public_acls,
      aws_s3_bucket_public_access_block.artifacts.block_public_policy,
      aws_s3_bucket_public_access_block.artifacts.ignore_public_acls,
      aws_s3_bucket_public_access_block.artifacts.restrict_public_buckets,
    ])
    error_message = "Every public access block setting must be on for the artifacts bucket."
  }

  assert {
    condition     = jsondecode(aws_s3_bucket_policy.artifacts.policy).Statement[0].Effect == "Deny" && jsondecode(aws_s3_bucket_policy.artifacts.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "The artifacts bucket must deny requests that do not use TLS."
  }

  assert {
    condition     = aws_s3_bucket_versioning.artifacts.versioning_configuration[0].status == "Enabled"
    error_message = "Artifacts must be versioned so a rollback can find the previous code."
  }
}

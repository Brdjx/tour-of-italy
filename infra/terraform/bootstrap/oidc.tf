# GitHub Actions identities. Both roles trust the account's existing GitHub OIDC provider (read
# with a data source, never created here, because other stacks in this shared account use it).

data "aws_iam_openid_connect_provider" "github" {
  arn = var.github_oidc_provider_arn
}

locals {
  oidc_host = "token.actions.githubusercontent.com"

  # Decision: exact subjects with StringEquals, never StringLike with wildcards. The deploy job
  # declares the production environment, so its token's subject is ...:environment:production.
  # The ...:ref:refs/heads/main subject is also accepted because the repository is private on
  # GitHub Free, where GitHub documents environments (and their protection rules) as a Pro
  # feature; if GitHub does not honour the environment there, the token carries the ref subject
  # instead. Accepting it loses nothing: the ref, job_workflow_ref and actor_id conditions below
  # are the real guards, and on this plan GitHub enforces no environment rule they do not cover.
  deploy_subjects = [
    "${var.github_subject_prefix}:environment:production",
    "${var.github_subject_prefix}:ref:refs/heads/main",
  ]

  # The plan role serves pull requests only (the ci.yml plan job runs on pull_request). It is
  # read-only, but see plan-role.tf for what a plan can read.
  plan_subjects = ["${var.github_subject_prefix}:pull_request"]

  # Decision: pin the workflow file as well as the subject (IAM supports GitHub's ref and
  # job_workflow_ref claims). Only deploy.yml running from main can deploy, even if another
  # workflow in the repository declares the production environment. Pull request runs carry
  # the merge ref of the pull request.
  deploy_workflow = "${var.github_repository}/.github/workflows/deploy.yml@refs/heads/main"
  plan_workflow   = "${var.github_repository}/.github/workflows/ci.yml@refs/pull/*/merge"
}

locals {
  deploy_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubDeployFromMainByTrustedActors"
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_host}:aud"              = "sts.amazonaws.com"
          "${local.oidc_host}:sub"              = local.deploy_subjects
          "${local.oidc_host}:ref"              = "refs/heads/main"
          "${local.oidc_host}:job_workflow_ref" = local.deploy_workflow
          "${local.oidc_host}:actor_id"         = var.github_actor_ids
        }
      }
    }]
  }

  plan_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubPullRequestPlansByTrustedActors"
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.oidc_host}:aud"      = "sts.amazonaws.com"
          "${local.oidc_host}:sub"      = local.plan_subjects
          "${local.oidc_host}:actor_id" = var.github_actor_ids
        }
        StringLike = {
          "${local.oidc_host}:ref"              = "refs/pull/*/merge"
          "${local.oidc_host}:job_workflow_ref" = local.plan_workflow
        }
      }
    }]
  }
}

resource "aws_iam_role" "deploy" {
  name        = "${local.name}-github-deploy"
  description = "GitHub Actions deploy role for ${var.github_repository} (production environment only)."
  # Decision: one hour covers the deploy job (45 minute timeout) and keeps a leaked session short.
  max_session_duration = 3600
  assume_role_policy   = jsonencode(local.deploy_trust_policy)
}

resource "aws_iam_role" "plan" {
  name                 = "${local.name}-github-plan"
  description          = "GitHub Actions read-only Terraform plan role for ${var.github_repository}."
  max_session_duration = 3600
  assume_role_policy   = jsonencode(local.plan_trust_policy)
}

resource "aws_iam_role_policy_attachment" "deploy" {
  for_each = {
    api        = aws_iam_policy.deploy_api.arn
    platform   = aws_iam_policy.deploy_platform.arn
    guardrails = aws_iam_policy.deploy_guardrails.arn
  }

  role       = aws_iam_role.deploy.name
  policy_arn = each.value
}

resource "aws_iam_role_policy_attachment" "plan" {
  for_each = {
    read       = aws_iam_policy.plan_read.arn
    guardrails = aws_iam_policy.plan_guardrails.arn
  }

  role       = aws_iam_role.plan.name
  policy_arn = each.value
}

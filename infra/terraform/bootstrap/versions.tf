# Bootstrap: the one-time, admin-applied layer. It creates the identities CI uses (a read-only
# plan role and a deploy role), the permissions boundary every CI-created role must carry, the
# SAM artifacts bucket and a cost budget. CI can assume these roles but can never change them.
#
# Apply by hand with admin credentials (see docs/deploy.md):
#   AWS_PROFILE=fortissimo terraform -chdir=infra/terraform/bootstrap init
#   AWS_PROFILE=fortissimo terraform -chdir=infra/terraform/bootstrap apply

terraform {
  # Decision: 1.11 or newer for S3-native state locking (use_lockfile) and for terraform test
  # mocks with override_during. CI pins 1.16.x in .github/actions/setup-iac-tools.
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
  }

  # Decision: the shared state bucket already exists (versioned, encrypted, public access
  # blocked). S3-native locking replaces the DynamoDB lock table.
  backend "s3" {
    bucket       = "fortissimo-terraform-state"
    key          = "tour-of-italy/bootstrap.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  # The account is shared with other production stacks. Refuse to run anywhere else.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}

locals {
  name = "italy-planner"

  # Decision: the account already uses capitalised tag keys (Project, ManagedBy, Environment), so
  # the same keys are used here. Project is also the cost filter of the budget. It is not an
  # access control key: a tag can be added to another stack's resource, so CI policies are scoped
  # by name or by pinned id instead.
  tags = {
    Project     = local.name
    ManagedBy   = "terraform"
    Component   = "bootstrap"
    Environment = "production"
    Repository  = var.github_repository
  }
}

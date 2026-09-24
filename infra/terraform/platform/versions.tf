# Platform: the edge in front of the SAM API. Applied by CI (deploy.yml, apply-platform.sh) after
# sam deploy, with the deploy role from infra/terraform/bootstrap. Planned on pull requests with
# the read-only plan role (terraform-plan.sh, -lock=false).
#
# Resources: origin-verify secret (SSM), ACM certificate for both host names, Route 53 alias
# records, private web bucket, two CloudFront distributions (the site with origin access control,
# and the API host) sharing one security headers policy and one WAF web ACL.

terraform {
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }

  backend "s3" {
    bucket       = "fortissimo-terraform-state"
    key          = "tour-of-italy/platform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}

locals {
  name = "italy-planner"

  # Project feeds the budget's cost filter. CI access is scoped by name or pinned id, not by tag.
  tags = {
    Project     = local.name
    ManagedBy   = "terraform"
    Component   = "platform"
    Environment = "production"
    Repository  = "Brdjx/tour-of-italy"
  }

  web_bucket = "${local.name}-web-${var.aws_account_id}"
  site_url   = "https://${var.site_domain}"
  api_url    = "https://${var.api_domain}"
}

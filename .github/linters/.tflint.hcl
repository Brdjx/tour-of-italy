# TFLint config for infra/terraform/bootstrap and infra/terraform/platform. CI runs:
#   tflint --init --config .github/linters/.tflint.hcl
#   tflint --recursive --chdir infra/terraform --config "$PWD/.github/linters/.tflint.hcl"

config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

# Catches invalid AWS values (instance types, regions, runtimes) that terraform validate accepts.
plugin "aws" {
  enabled = true
  version = "0.49.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# Dedicated bucket for SAM deployment artifacts (samconfig.toml s3_bucket), so this project
# never writes to the shared aws-sam-cli-managed-default bucket.

resource "aws_s3_bucket" "artifacts" {
  bucket = local.artifacts_bucket
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Decision: SSE-S3, not a customer managed KMS key (trivy AVD-AWS-0132). The objects are build
# outputs of this repository; a customer managed key would need a key policy for CloudFormation
# and Lambda plus a monthly key cost, without protecting anything more sensitive.
# trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Decision: current objects never expire. A CloudFormation rollback re-deploys the previous
# function code from this bucket, so expiring it could turn a failed deploy into a stuck stack.
# Replaced versions and abandoned uploads are cleaned up.
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-replaced-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  # The public access block must exist first, or a policy change could briefly race it.
  depends_on = [aws_s3_bucket_public_access_block.artifacts]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = ["arn:aws:s3:::${local.artifacts_bucket}", "arn:aws:s3:::${local.artifacts_bucket}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

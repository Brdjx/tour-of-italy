# Private bucket for the static site (apps/web/out). Only CloudFront can read it, through origin
# access control; nothing is public and every request must use TLS.

resource "aws_s3_bucket" "web" {
  bucket = local.web_bucket
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs off; the bucket policy is the only grant
  }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Decision: SSE-S3, not a customer managed KMS key (trivy AVD-AWS-0132). The content is the
# public website; SSE-KMS would also need a key policy for CloudFront's origin access control.
# trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Old versions let an operator restore a bad upload by hand; 30 days is enough for that.
resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket = aws_s3_bucket.web.id

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

locals {
  web_bucket_arn = "arn:aws:s3:::${local.web_bucket}"

  web_bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.web_bucket_arn, "${local.web_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        # Decision: ListBucket as well as GetObject, so a missing file is a 404 (served as the
        # site's 404 page) instead of a 403 that would look like an access problem.
        Sid       = "AllowThisDistributionOnly"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = ["s3:GetObject", "s3:ListBucket"]
        Resource  = [local.web_bucket_arn, "${local.web_bucket_arn}/*"]
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket     = aws_s3_bucket.web.id
  policy     = jsonencode(local.web_bucket_policy)
  depends_on = [aws_s3_bucket_public_access_block.web]
}

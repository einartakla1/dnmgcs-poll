terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = "dnmgcs"
}

locals {
  common_tags = {
    Project     = var.project
    Environment = var.environment
    Owner       = "DN Content Studio"
    CostCenter  = "DN Content Studio"
    ManagedBy   = "Terraform"
  }
}

# ----------------------------
# DYNAMODB TABLES
# ----------------------------

resource "aws_dynamodb_table" "polls" {
  name         = "${var.project}-${var.environment}-polls"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pollId"

  attribute {
    name = "pollId"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = local.common_tags
}

resource "aws_dynamodb_table" "voters" {
  name         = "${var.project}-${var.environment}-voters"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pollId"
  range_key    = "voterToken"

  attribute {
    name = "pollId"
    type = "S"
  }

  attribute {
    name = "voterToken"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = local.common_tags
}

# ----------------------------
# LAMBDA FUNCTION
# ----------------------------

resource "aws_iam_role" "lambda_exec_role" {
  name = "${var.project}-${var.environment}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action    = "sts:AssumeRole",
        Principal = { Service = "lambda.amazonaws.com" },
        Effect    = "Allow"
      }
    ]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "${var.project}-${var.environment}-lambda-policy"
  role = aws_iam_role.lambda_exec_role.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan"
        ],
        Resource = [
          aws_dynamodb_table.polls.arn,
          aws_dynamodb_table.voters.arn
        ]
      },
      {
        Effect = "Allow",
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ],
        Resource = "*"
      }
    ]
  })
}

resource "aws_lambda_function" "poll_api" {
  function_name    = "${var.project}-${var.environment}-api"
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  filename         = "${path.module}/lambda/package.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda/package.zip")
  role             = aws_iam_role.lambda_exec_role.arn
  timeout          = 10
  publish          = true

  environment {
    variables = {
      TABLE_POLLS     = aws_dynamodb_table.polls.name
      TABLE_VOTERS    = aws_dynamodb_table.voters.name
      ALLOWED_ORIGINS = "https://dn.no,https://www.dn.no,https://editor.vev.design,https://nhst.vev.site,http://localhost:3000"
      NODE_ENV        = var.environment
    }
  }

  tags = local.common_tags
}

# ----------------------------
# Provisioned Concurrency 
# ----------------------------
variable "enable_provisioned_concurrency" {
  type    = bool
  default = true
}

resource "aws_lambda_provisioned_concurrency_config" "proxy_concurrency" {
  count                             = var.enable_provisioned_concurrency ? 1 : 0
  function_name                     = aws_lambda_function.poll_proxy.function_name
  qualifier                         = aws_lambda_function.poll_proxy.version
  provisioned_concurrent_executions = 1
}

resource "aws_lambda_provisioned_concurrency_config" "api_concurrency" {
  count                             = var.enable_provisioned_concurrency ? 1 : 0
  function_name                     = aws_lambda_function.poll_api.function_name
  qualifier                         = aws_lambda_function.poll_api.version
  provisioned_concurrent_executions = 1
}


# ----------------------------
# API GATEWAY (REST API)
# ----------------------------

resource "aws_api_gateway_rest_api" "poll_api" {
  name        = "${var.project}-${var.environment}-rest-api"
  description = "Public poll API for ${var.project} (${var.environment})"
  endpoint_configuration {
    types = ["REGIONAL"]
  }
  tags = local.common_tags
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.poll_api.id
  parent_id   = aws_api_gateway_rest_api.poll_api.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy_method" {
  rest_api_id      = aws_api_gateway_rest_api.poll_api.id
  resource_id      = aws_api_gateway_resource.proxy.id
  http_method      = "ANY"
  authorization    = "NONE"
  api_key_required = true
}

resource "aws_api_gateway_integration" "lambda_integration" {
  rest_api_id             = aws_api_gateway_rest_api.poll_api.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy_method.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.poll_api.invoke_arn
}

resource "aws_lambda_permission" "api_permission" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.poll_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.poll_api.execution_arn}/*/*"
}

resource "aws_api_gateway_deployment" "poll_deployment" {
  rest_api_id = aws_api_gateway_rest_api.poll_api.id
  triggers = {
    redeployment = sha1(jsonencode({
      poll_integration  = aws_api_gateway_integration.lambda_integration.id
      poll_method       = aws_api_gateway_method.proxy_method.id
      proxy_integration = aws_api_gateway_integration.proxy_public_integration.id
      proxy_method      = aws_api_gateway_method.proxy_public_method.id
    }))
  }
  lifecycle {
    create_before_destroy = true
  }
}


resource "aws_api_gateway_stage" "prod" {
  deployment_id = aws_api_gateway_deployment.poll_deployment.id
  rest_api_id   = aws_api_gateway_rest_api.poll_api.id
  stage_name    = var.environment
  tags          = local.common_tags
}






# ----------------------------
# API KEY + USAGE PLAN
# ----------------------------

resource "aws_api_gateway_api_key" "public_key" {
  name        = "${var.project}-${var.environment}-public-api-key"
  enabled     = true
  description = "API key for Vev frontend polling system"
  tags        = local.common_tags
}

resource "aws_api_gateway_usage_plan" "public_usage_plan" {
  name = "${var.project}-${var.environment}-usage-plan"

  api_stages {
    api_id = aws_api_gateway_rest_api.poll_api.id
    stage  = aws_api_gateway_stage.prod.stage_name
  }

  throttle_settings {
    rate_limit  = 50
    burst_limit = 100
  }

  quota_settings {
    limit  = 10000
    period = "DAY"
  }

  tags = local.common_tags
}

resource "aws_api_gateway_usage_plan_key" "public_plan_key" {
  key_id        = aws_api_gateway_api_key.public_key.id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.public_usage_plan.id
}





# ----------------------------------------------
# PROXY Lambda (reuses same role for simplicity)
# ----------------------------------------------
resource "aws_lambda_function" "poll_proxy" {
  function_name    = "${var.project}-${var.environment}-proxy"
  handler          = "proxy.handler" # matches the built entry file you zipped
  runtime          = "nodejs20.x"
  architectures    = ["arm64"]
  filename         = "${path.module}/lambda/package-proxy.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda/package-proxy.zip")
  role             = aws_iam_role.lambda_exec_role.arn
  timeout          = 10
  publish          = true

  environment {
    variables = {
      # The same base URL you output; build it here for the proxy:
      TARGET_API_BASE = "https://${aws_api_gateway_rest_api.poll_api.id}.execute-api.${var.region}.amazonaws.com/${var.environment}"
      PUBLIC_API_KEY  = aws_api_gateway_api_key.public_key.value
      ALLOWED_ORIGINS = "https://dn.no,https://www.dn.no,https://editor.vev.design,https://nhst.vev.site,http://localhost:3000"
    }
  }

  tags = local.common_tags
}

# -------------------------
# /proxy/{proxy+} resource
# -------------------------
resource "aws_api_gateway_resource" "proxy_public" {
  rest_api_id = aws_api_gateway_rest_api.poll_api.id
  parent_id   = aws_api_gateway_rest_api.poll_api.root_resource_id
  path_part   = "proxy"
}

resource "aws_api_gateway_resource" "proxy_public_deep" {
  rest_api_id = aws_api_gateway_rest_api.poll_api.id
  parent_id   = aws_api_gateway_resource.proxy_public.id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy_public_method" {
  rest_api_id      = aws_api_gateway_rest_api.poll_api.id
  resource_id      = aws_api_gateway_resource.proxy_public_deep.id
  http_method      = "ANY"
  authorization    = "NONE"
  api_key_required = false # <-- end-users do NOT need the key
}

resource "aws_api_gateway_integration" "proxy_public_integration" {
  rest_api_id             = aws_api_gateway_rest_api.poll_api.id
  resource_id             = aws_api_gateway_resource.proxy_public_deep.id
  http_method             = aws_api_gateway_method.proxy_public_method.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.poll_proxy.invoke_arn
}

resource "aws_api_gateway_method" "proxy_public_options" {
  rest_api_id   = aws_api_gateway_rest_api.poll_api.id
  resource_id   = aws_api_gateway_resource.proxy_public_deep.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "proxy_public_options" {
  rest_api_id             = aws_api_gateway_rest_api.poll_api.id
  resource_id             = aws_api_gateway_resource.proxy_public_deep.id
  http_method             = aws_api_gateway_method.proxy_public_options.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.poll_proxy.invoke_arn
}

resource "aws_lambda_permission" "proxy_public_permission" {
  statement_id  = "AllowAPIGatewayInvokeProxy"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.poll_proxy.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.poll_api.execution_arn}/*/*"
}

resource "aws_wafv2_web_acl" "api_waf" {
  name        = "${var.project}-${var.environment}-waf"
  description = "Rate-limit abusive clients for ${var.project} ${var.environment}"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "RateLimit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000 # requests in a 5-minute window per IP
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-waf-ratelimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-${var.environment}-waf"
    sampled_requests_enabled   = true
  }

  tags = local.common_tags
}

resource "aws_wafv2_web_acl_association" "api_waf_assoc" {
  resource_arn = "arn:aws:apigateway:${var.region}::/restapis/${aws_api_gateway_rest_api.poll_api.id}/stages/${aws_api_gateway_stage.prod.stage_name}"
  web_acl_arn  = aws_wafv2_web_acl.api_waf.arn
}


# ----------------------------
# CloudFront distribution for caching poll results
# ----------------------------
resource "aws_cloudfront_distribution" "poll_results_cache" {
  enabled             = true
  comment             = "CloudFront cache for GET /proxy/results"
  default_root_object = ""

  origin {
    domain_name = "${aws_api_gateway_rest_api.poll_api.id}.execute-api.${var.region}.amazonaws.com"
    origin_id   = "api-gateway-origin"
    origin_path = "/${var.environment}"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"] # ✅ required
    }
  }

  default_cache_behavior {
    target_origin_id       = "api-gateway-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    default_ttl            = 0
    max_ttl                = 0
    min_ttl                = 0

    forwarded_values {
      query_string = true
      headers      = ["Origin"]

      cookies {
        forward = "none" # ✅ required block
      }
    }
  }

  ordered_cache_behavior {
    path_pattern           = "proxy/results*"
    target_origin_id       = "api-gateway-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    default_ttl            = 30
    max_ttl                = 60
    min_ttl                = 10

    forwarded_values {
      query_string = true
      headers      = ["Origin"]

      cookies {
        forward = "none" # ✅ required block
      }
    }
  }

  price_class = "PriceClass_100"

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.common_tags
}

output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.poll_results_cache.domain_name}"
}



# ----------------------------
# OUTPUT
# ----------------------------

output "api_base_url" {
  value = "https://${aws_api_gateway_rest_api.poll_api.id}.execute-api.${var.region}.amazonaws.com/${var.environment}"
}

output "public_api_key" {
  value     = aws_api_gateway_api_key.public_key.value
  sensitive = true
}

output "proxy_api_url" {
  value = "https://${aws_api_gateway_rest_api.poll_api.id}.execute-api.${var.region}.amazonaws.com/${var.environment}/proxy"
}


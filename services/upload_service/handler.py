"""
Upload Lambda.

Route:
  POST /uploads/product-image   admin-only

Accepts {filename, contentType} and returns a presigned PUT URL the admin
client can upload to directly. After upload the file is publicly readable
because the bucket is configured with public-read.
"""
import json
import os
import re
import time
import uuid

import boto3


s3 = boto3.client("s3")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json",
}


def _resp(status, payload):
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(payload),
    }


def _claims(event):
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        or {}
    )


def _is_admin(event) -> bool:
    admin_group = os.environ.get("ADMIN_GROUP", "admins")
    groups = _claims(event).get("cognito:groups", "")
    if isinstance(groups, list):
        return admin_group in groups
    return admin_group in str(groups).split(",")


_SAFE = re.compile(r"[^a-zA-Z0-9._-]+")


def _safe_filename(name: str) -> str:
    cleaned = _SAFE.sub("-", (name or "image").strip())
    return cleaned[:64] or "image"


def handler(event, context):
    if not _is_admin(event):
        return _resp(403, {"message": "Admins only"})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    filename = _safe_filename(str(body.get("filename", "")))
    if filename.lower().endswith((".heic", ".heif")):
        return _resp(
            400,
            {
                "message": "HEIC/HEIF is not supported in web browsers. "
                "Please upload JPEG, PNG, or WebP."
            },
        )
    content_type = str(body.get("contentType", "")).strip() or "image/jpeg"

    if not content_type.startswith("image/"):
        return _resp(400, {"message": "Only image uploads are allowed"})

    bucket = os.environ["IMAGES_BUCKET_NAME"]
    key = f"products/{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}-{filename}"
    region = os.environ.get("AWS_REGION", "us-west-1")

    upload_url = s3.generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=300,
        HttpMethod="PUT",
    )

    public_url = f"https://{bucket}.s3.{region}.amazonaws.com/{key}"

    return _resp(
        200,
        {
            "uploadUrl": upload_url,
            "publicUrl": public_url,
            "key": key,
            "contentType": content_type,
            "expiresIn": 300,
        },
    )

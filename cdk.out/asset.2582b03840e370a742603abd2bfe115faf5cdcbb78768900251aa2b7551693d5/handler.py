"""
Products Lambda.

Routes:
  GET    /products              public  list active products (optional ?category=)
  GET    /products/{sku}        public  get one product
  POST   /products              admin   create product
  PUT    /products/{sku}        admin   update fields (name, description, price, stock, ...)
  DELETE /products/{sku}        admin   soft-delete (sets active=false)

Admin checks live in this Lambda, not API Gateway, so the Cognito user must
belong to the "admins" group for any mutation.
"""
import json
import os
import time
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError


ddb = boto3.resource("dynamodb")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
    "Content-Type": "application/json",
}


def _to_decimal(value) -> Decimal:
    return Decimal(str(value))


def _decimals_to_native(obj):
    if isinstance(obj, list):
        return [_decimals_to_native(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _decimals_to_native(v) for k, v in obj.items()}
    if isinstance(obj, Decimal):
        # int when whole, float otherwise
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    return obj


def _resp(status, payload):
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(_decimals_to_native(payload)),
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


def _table():
    return ddb.Table(os.environ["PRODUCTS_TABLE_NAME"])


def _list_products(event):
    qs = event.get("queryStringParameters") or {}
    category = qs.get("category")
    table = _table()

    if category:
        res = table.query(
            IndexName="category-index",
            KeyConditionExpression=boto3.dynamodb.conditions.Key("category").eq(
                category
            ),
        )
    else:
        res = table.scan()

    items = [it for it in res.get("Items", []) if it.get("active", True)]
    items.sort(key=lambda it: it.get("name", ""))
    return _resp(200, {"products": items})


def _get_product(sku):
    res = _table().get_item(Key={"sku": sku})
    item = res.get("Item")
    if not item or not item.get("active", True):
        return _resp(404, {"message": "Product not found"})
    return _resp(200, item)


def _create_product(event):
    if not _is_admin(event):
        return _resp(403, {"message": "Admins only"})
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    required = ["sku", "name", "price", "stock", "category"]
    missing = [f for f in required if body.get(f) in (None, "")]
    if missing:
        return _resp(400, {"message": f"Missing fields: {missing}"})

    now = int(time.time() * 1000)
    item = {
        "sku": str(body["sku"]).strip(),
        "name": str(body["name"]).strip(),
        "description": str(body.get("description", "")),
        "category": str(body["category"]).strip(),
        "price": _to_decimal(body["price"]),
        "currency": body.get("currency", "USD"),
        "stock": int(body["stock"]),
        "imageUrl": str(body.get("imageUrl", "")),
        "active": True,
        "createdAt": now,
        "updatedAt": now,
    }

    try:
        _table().put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(sku)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(409, {"message": "SKU already exists"})
        raise

    return _resp(201, item)


def _update_product(event, sku):
    if not _is_admin(event):
        return _resp(403, {"message": "Admins only"})
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    allowed = {
        "name": str,
        "description": str,
        "category": str,
        "price": _to_decimal,
        "currency": str,
        "stock": int,
        "imageUrl": str,
        "active": bool,
    }

    set_parts = ["updatedAt = :updatedAt"]
    values = {":updatedAt": int(time.time() * 1000)}
    names = {}

    for field, caster in allowed.items():
        if field in body and body[field] is not None:
            placeholder = f":{field}"
            name_alias = f"#{field}"
            set_parts.append(f"{name_alias} = {placeholder}")
            values[placeholder] = caster(body[field])
            names[name_alias] = field

    if len(set_parts) == 1:
        return _resp(400, {"message": "No updatable fields provided"})

    try:
        res = _table().update_item(
            Key={"sku": sku},
            UpdateExpression="SET " + ", ".join(set_parts),
            ExpressionAttributeValues=values,
            ExpressionAttributeNames=names,
            ConditionExpression="attribute_exists(sku)",
            ReturnValues="ALL_NEW",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"message": "Product not found"})
        raise

    return _resp(200, res.get("Attributes", {}))


def _delete_product(event, sku):
    if not _is_admin(event):
        return _resp(403, {"message": "Admins only"})
    try:
        _table().update_item(
            Key={"sku": sku},
            UpdateExpression="SET active = :a, updatedAt = :u",
            ExpressionAttributeValues={
                ":a": False,
                ":u": int(time.time() * 1000),
            },
            ConditionExpression="attribute_exists(sku)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _resp(404, {"message": "Product not found"})
        raise
    return _resp(200, {"sku": sku, "active": False})


def handler(event, context):
    method = event.get("httpMethod", "")
    path_params = event.get("pathParameters") or {}
    sku = path_params.get("sku")

    if method == "GET" and sku:
        return _get_product(sku)
    if method == "GET":
        return _list_products(event)
    if method == "POST":
        return _create_product(event)
    if method == "PUT" and sku:
        return _update_product(event, sku)
    if method == "DELETE" and sku:
        return _delete_product(event, sku)

    return _resp(405, {"message": f"Method not allowed: {method}"})

"""
My Orders Lambda.

Routes:
  GET /me/orders                -> list my orders (newest first)
  GET /me/orders/{orderId}      -> get one of my orders

Uses the userId-createdAt-index GSI for efficient per-user listing.
"""
import json
import os
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key


ddb = boto3.resource("dynamodb")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,GET",
    "Content-Type": "application/json",
}


def _decimals_to_native(obj):
    if isinstance(obj, list):
        return [_decimals_to_native(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _decimals_to_native(v) for k, v in obj.items()}
    if isinstance(obj, Decimal):
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    return obj


def _resp(status, payload):
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(_decimals_to_native(payload)),
    }


def _user_id(event):
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        .get("sub")
    )


def handler(event, context):
    user_id = _user_id(event)
    if not user_id:
        return _resp(401, {"message": "Unauthorized"})

    table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])
    index = os.environ.get("ORDERS_USER_INDEX", "userId-createdAt-index")

    method = event.get("httpMethod", "")
    path_params = event.get("pathParameters") or {}
    order_id = path_params.get("orderId")

    if method != "GET":
        return _resp(405, {"message": f"Method not allowed: {method}"})

    if order_id:
        res = table.get_item(Key={"orderId": order_id})
        item = res.get("Item")
        if not item or item.get("userId") != user_id:
            return _resp(404, {"message": "Order not found"})
        return _resp(200, item)

    res = table.query(
        IndexName=index,
        KeyConditionExpression=Key("userId").eq(user_id),
        ScanIndexForward=False,  # newest first
        Limit=100,
    )
    return _resp(200, {"orders": res.get("Items", [])})

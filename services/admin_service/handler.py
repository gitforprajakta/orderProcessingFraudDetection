"""
Admin Lambda.

Routes (all admin-only, enforced by Cognito group claim):
  GET  /admin/orders                            -> list all orders (optionally ?status=)
  POST /admin/orders/{orderId}/decision         -> manually APPROVE or BLOCK a REVIEW order
"""
import json
import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr


ddb = boto3.resource("dynamodb")
events = boto3.client("events")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
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


def _list_orders(event):
    qs = event.get("queryStringParameters") or {}
    status = qs.get("status")
    table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])

    if status:
        res = table.scan(FilterExpression=Attr("status").eq(status))
    else:
        res = table.scan()

    items = res.get("Items", [])
    items.sort(key=lambda it: it.get("createdAt", 0), reverse=True)
    return _resp(200, {"orders": items})


def _override_decision(event, order_id):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    decision = str(body.get("decision", "")).upper()
    if decision not in {"APPROVE", "BLOCK"}:
        return _resp(400, {"message": "decision must be APPROVE or BLOCK"})

    table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])
    bus_name = os.environ["EVENT_BUS_NAME"]
    admin_email = _claims(event).get("email", "")

    res = table.get_item(Key={"orderId": order_id})
    order = res.get("Item")
    if not order:
        return _resp(404, {"message": "Order not found"})

    now_ms = int(time.time() * 1000)
    table.update_item(
        Key={"orderId": order_id},
        UpdateExpression=(
            "SET #status = :s, fraudDecision = :d, "
            "adminOverride = :over, adminEmail = :ae, evaluatedAt = :ev"
        ),
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":s": decision,
            ":d": decision,
            ":over": True,
            ":ae": admin_email,
            ":ev": now_ms,
        },
    )

    detail_type = "OrderApproved" if decision == "APPROVE" else "OrderBlocked"
    out_detail = {
        "orderId": order_id,
        "userId": order.get("userId"),
        "decision": decision,
        "adminOverride": True,
        "adminEmail": admin_email,
        "evaluatedAt": now_ms,
        "items": _decimals_to_native(order.get("items", [])),
        "orderTotal": _decimals_to_native(order.get("orderTotal", 0)),
    }
    events.put_events(
        Entries=[
            {
                "EventBusName": bus_name,
                "Source": "admin.service",
                "DetailType": detail_type,
                "Detail": json.dumps(out_detail),
            }
        ]
    )

    return _resp(200, {"orderId": order_id, "status": decision})


def handler(event, context):
    if not _is_admin(event):
        return _resp(403, {"message": "Admins only"})

    method = event.get("httpMethod", "")
    path = event.get("resource", "")
    path_params = event.get("pathParameters") or {}

    if path == "/admin/orders" and method == "GET":
        return _list_orders(event)
    if path == "/admin/orders/{orderId}/decision" and method == "POST":
        return _override_decision(event, path_params.get("orderId", ""))

    return _resp(405, {"message": f"Method not allowed: {method} {path}"})

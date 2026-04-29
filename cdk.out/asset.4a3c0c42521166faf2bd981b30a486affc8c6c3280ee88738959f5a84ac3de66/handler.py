"""
Admin Lambda.

Routes (all admin-only, enforced by Cognito group claim):
  GET  /admin/orders                            -> list all orders (optionally ?status=)
  POST /admin/orders/{orderId}/decision         -> manually APPROVE or BLOCK a REVIEW order
                                                   (also deletes the matching message from
                                                   the SQS ReviewQueue when receiptHandle is
                                                   provided in the request body)
  GET  /admin/review-queue                      -> pull pending OrderReview messages from SQS
                                                   so admins can act on them
"""
import json
import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError


ddb = boto3.resource("dynamodb")
events = boto3.client("events")
sqs = boto3.client("sqs")

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


def _list_review_queue(event):
    """
    Pull pending OrderReview messages from the SQS ReviewQueue.

    Each message body is the EventBridge event we routed in for an
    OrderReview decision. We surface the orderId, score, evaluation time,
    and the SQS receiptHandle so the frontend can pass it back when the
    admin clicks Approve/Block — that's how we delete the right message.

    Note: receive_message uses the queue's visibility timeout, so messages
    "in flight" for one admin become invisible to the other two for a
    short window. That naturally prevents double-processing.
    """
    queue_url = os.environ.get("REVIEW_QUEUE_URL")
    if not queue_url:
        return _resp(500, {"message": "REVIEW_QUEUE_URL not configured"})

    qs = event.get("queryStringParameters") or {}
    try:
        max_messages = max(1, min(10, int(qs.get("max", "10"))))
    except (TypeError, ValueError):
        max_messages = 10

    try:
        res = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=max_messages,
            WaitTimeSeconds=1,
            VisibilityTimeout=30,
            MessageAttributeNames=["All"],
        )
    except ClientError as exc:
        return _resp(500, {"message": f"SQS receive failed: {exc}"})

    sqs_messages = res.get("Messages", []) or []
    orders_table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])

    items = []
    for m in sqs_messages:
        try:
            body = json.loads(m.get("Body") or "{}")
        except json.JSONDecodeError:
            body = {}
        detail = body.get("detail") or {}
        order_id = detail.get("orderId")

        order = None
        if order_id:
            try:
                order = orders_table.get_item(Key={"orderId": order_id}).get(
                    "Item"
                )
            except ClientError:
                order = None

        items.append(
            {
                "messageId": m.get("MessageId"),
                "receiptHandle": m.get("ReceiptHandle"),
                "orderId": order_id,
                "score": detail.get("score"),
                "decision": detail.get("decision"),
                "evaluatedAt": detail.get("evaluatedAt"),
                "order": order,
            }
        )

    return _resp(200, {"messages": items, "count": len(items)})


def _delete_review_message(receipt_handle: str) -> None:
    queue_url = os.environ.get("REVIEW_QUEUE_URL")
    if not queue_url or not receipt_handle:
        return
    try:
        sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)
    except ClientError as exc:
        # Not fatal — the DB and SNS notifications are the source of truth.
        # The message will eventually go to DLQ if it can't be processed.
        print(f"SQS delete_message failed: {exc}")


def _override_decision(event, order_id):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    decision = str(body.get("decision", "")).upper()
    if decision not in {"APPROVE", "BLOCK"}:
        return _resp(400, {"message": "decision must be APPROVE or BLOCK"})

    receipt_handle = body.get("receiptHandle")

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

    # Once a decision is recorded the order should no longer sit in the
    # ReviewQueue waiting on another admin.
    if receipt_handle:
        _delete_review_message(receipt_handle)

    return _resp(
        200,
        {
            "orderId": order_id,
            "status": decision,
            "removedFromReviewQueue": bool(receipt_handle),
        },
    )


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
    if path == "/admin/review-queue" and method == "GET":
        return _list_review_queue(event)

    return _resp(405, {"message": f"Method not allowed: {method} {path}"})

import json
import os
import time

import boto3


ddb = boto3.resource("dynamodb")
sqs = boto3.client("sqs")
events = boto3.client("events")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json",
}


def _response(status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body),
    }


def _pull_and_delete_review_message(queue_url: str, order_id: str, max_attempts: int = 5) -> bool:
    for _ in range(max_attempts):
        result = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=1,
            VisibilityTimeout=20,
        )
        messages = result.get("Messages", [])
        if not messages:
            continue

        for msg in messages:
            receipt_handle = msg["ReceiptHandle"]
            try:
                body = json.loads(msg.get("Body") or "{}")
            except json.JSONDecodeError:
                body = {}

            if body.get("orderId") == order_id:
                sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)
                return True

            # Put unrelated review requests back immediately.
            sqs.change_message_visibility(
                QueueUrl=queue_url,
                ReceiptHandle=receipt_handle,
                VisibilityTimeout=0,
            )

    return False


def handler(event, context):
    table_name = os.environ["ORDERS_TABLE_NAME"]
    bus_name = os.environ["EVENT_BUS_NAME"]
    review_queue_url = os.environ["REVIEW_QUEUE_URL"]
    table = ddb.Table(table_name)

    order_id = (event.get("pathParameters") or {}).get("orderId")
    if not order_id:
        return _response(400, {"message": "orderId path parameter is required"})

    if "body" not in event or event["body"] is None:
        return _response(400, {"message": "Missing request body"})
    try:
        body = json.loads(event["body"])
    except json.JSONDecodeError:
        return _response(400, {"message": "Invalid JSON"})

    action = str(body.get("action", "")).upper()
    if action == "REJECT":
        action = "BLOCK"
    if action not in {"APPROVE", "BLOCK"}:
        return _response(400, {"message": "action must be APPROVE or BLOCK"})

    existing = table.get_item(Key={"orderId": order_id}).get("Item")
    if not existing:
        return _response(404, {"message": f"Order {order_id} not found"})
    if existing.get("status") != "REVIEW":
        return _response(
            409,
            {
                "message": f"Order {order_id} is not in REVIEW state",
                "currentStatus": existing.get("status"),
            },
        )

    removed = _pull_and_delete_review_message(review_queue_url, order_id)
    if not removed:
        return _response(
            409,
            {"message": f"Order {order_id} review request not found in SQS"},
        )

    resolved_status = "APPROVE" if action == "APPROVE" else "BLOCK"
    resolved_at = int(time.time() * 1000)
    table.update_item(
        Key={"orderId": order_id},
        UpdateExpression=(
            "SET #status = :status, fraudDecision = :decision, evaluatedAt = :resolvedAt"
        ),
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":status": resolved_status,
            ":decision": resolved_status,
            ":resolvedAt": resolved_at,
        },
    )

    events.put_events(
        Entries=[
            {
                "EventBusName": bus_name,
                "Source": "review.service",
                "DetailType": "OrderReviewResolved",
                "Detail": json.dumps(
                    {
                        "orderId": order_id,
                        "action": action,
                        "resolvedStatus": resolved_status,
                        "resolvedAt": resolved_at,
                    }
                ),
            }
        ]
    )

    return _response(
        200,
        {
            "ok": True,
            "orderId": order_id,
            "status": resolved_status,
            "fraudDecision": resolved_status,
        },
    )

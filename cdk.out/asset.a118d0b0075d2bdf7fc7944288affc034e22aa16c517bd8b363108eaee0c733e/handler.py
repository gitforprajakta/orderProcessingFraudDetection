"""
Notification Lambda.

Triggered by EventBridge for OrderApproved / OrderBlocked / OrderReview events.
Publishes a human-friendly message to the OrderNotificationsTopic SNS topic so
the three admins subscribed to the topic get an email for every decision —
including REVIEW orders that are also placed onto the SQS ReviewQueue.
"""
import json
import os

import boto3


sns = boto3.client("sns")


SUBJECT_PREFIX = {
    "OrderApproved": "[NimbusMart] APPROVE",
    "OrderBlocked": "[NimbusMart] BLOCK",
    "OrderReview": "[NimbusMart] REVIEW (in SQS queue)",
}

HUMAN_LINE = {
    "OrderApproved": "An order was APPROVED.",
    "OrderBlocked": "An order was BLOCKED.",
    "OrderReview": (
        "An order needs manual REVIEW. It has been placed on the SQS "
        "ReviewQueue — sign in as admin and approve or block it."
    ),
}


def handler(event, context):
    topic_arn = os.environ["SNS_TOPIC_ARN"]

    detail_type = event.get("detail-type") or event.get("detailType") or "Unknown"
    detail = event.get("detail") or {}

    order_id = detail.get("orderId", "unknown")
    score = detail.get("score")
    admin_email = detail.get("adminEmail")
    admin_override = detail.get("adminOverride")

    subject = SUBJECT_PREFIX.get(detail_type, f"[NimbusMart] {detail_type}")
    # SNS subjects are limited to 100 chars.
    subject = (subject + f" — {order_id[:8]}")[:100]

    lines = [
        HUMAN_LINE.get(detail_type, f"Order event: {detail_type}"),
        f"Order ID: {order_id}",
    ]
    if score is not None:
        lines.append(f"Fraud score: {score}")
    if admin_override:
        lines.append(f"Admin override by: {admin_email or 'unknown'}")

    text_message = "\n".join(lines) + "\n\n" + json.dumps(
        {"event": detail_type, "detail": detail}, default=str, indent=2
    )

    sns.publish(
        TopicArn=topic_arn,
        Subject=subject,
        Message=text_message,
    )

    return {"published": True, "event": detail_type, "orderId": order_id}

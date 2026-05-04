import json
import os

import boto3


sns = boto3.client("sns")


def handler(event, context):
    topic_arn = os.environ["SNS_TOPIC_ARN"]

    detail_type = event.get("detail-type") or event.get("detailType") or "Unknown"
    detail = event.get("detail") or {}
    order_id = detail.get("orderId", "unknown")

    if detail_type == "OrderSentToReviewQueue":
        subject = f"Order in review queue: {order_id}"
    elif detail_type == "OrderReviewResolved":
        subject = f"Order review resolved: {order_id}"
    else:
        subject = f"Order decision: {detail_type}"

    msg = "\n".join(
        [
            f"Event: {detail_type}",
            f"Order ID: {order_id}",
            "",
            "Details:",
            json.dumps(detail, indent=2),
        ]
    )

    sns.publish(
        TopicArn=topic_arn,
        Subject=subject,
        Message=msg,
    )

    # Also return for easy troubleshooting in Lambda logs.
    return {"published": True, "event": detail_type, "orderId": detail.get("orderId")}


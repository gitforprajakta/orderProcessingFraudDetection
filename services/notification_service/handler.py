import json
import os

import boto3


sns = boto3.client("sns")


def handler(event, context):
    topic_arn = os.environ["SNS_TOPIC_ARN"]

    detail_type = event.get("detail-type") or event.get("detailType") or "Unknown"
    detail = event.get("detail") or {}

    msg = {
        "event": detail_type,
        "detail": detail,
    }

    sns.publish(
        TopicArn=topic_arn,
        Subject=f"Order decision: {detail_type}",
        Message=json.dumps(msg),
    )

    # Also return for easy troubleshooting in Lambda logs.
    return {"published": True, "event": detail_type, "orderId": detail.get("orderId")}


import json
import os
import time
from decimal import Decimal

import boto3

from order_features import order_detail_to_feature_vector
from xgb_inference import predict_probability


ddb = boto3.resource("dynamodb")
events = boto3.client("events")
sqs = boto3.client("sqs")


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _local_score(detail: dict) -> float:
    """
    Deterministic fraud scorer for AWS testing without an ML endpoint.
    The thresholds are intentionally simple so test orders are predictable.
    """
    total = float(detail.get("orderTotal", 0.0))
    country = str(detail.get("shippingCountry", "")).upper()
    item_count = sum(int(item.get("qty", 1)) for item in detail.get("items", []) or [])

    score = 0.05
    if total > 500:
        score += 0.25
    if total > 1500:
        score += 0.35
    if country not in {"US", "CA"}:
        score += 0.2
    if item_count >= 5:
        score += 0.15

    return _clamp01(score)


def _xgboost_score(detail: dict) -> float:
    features = order_detail_to_feature_vector(detail)
    return _clamp01(predict_probability(features))


def _update_order_status(order_id: str, out_detail: dict, review_message_id: str | None = None) -> None:
    table_name = os.environ.get("ORDERS_TABLE_NAME")
    if not table_name or order_id == "unknown":
        return

    table = ddb.Table(table_name)
    update_expression = (
        "SET #status = :status, fraudDecision = :decision, "
        "fraudScore = :score, fraudModelVersion = :model, evaluatedAt = :evaluated"
    )
    expression_values = {
        ":status": out_detail["decision"],
        ":decision": out_detail["decision"],
        ":score": Decimal(str(out_detail["score"])),
        ":model": out_detail["modelVersion"],
        ":evaluated": out_detail["evaluatedAt"],
    }
    if review_message_id:
        update_expression += ", reviewMessageId = :reviewMessageId, reviewQueueAt = :reviewQueueAt"
        expression_values[":reviewMessageId"] = review_message_id
        expression_values[":reviewQueueAt"] = out_detail["evaluatedAt"]

    table.update_item(
        Key={"orderId": order_id},
        UpdateExpression=update_expression,
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues=expression_values,
    )


def handler(event, context):
    bus_name = os.environ["EVENT_BUS_NAME"]
    review_queue_url = os.environ["REVIEW_QUEUE_URL"]
    approve_th = float(os.environ.get("APPROVE_THRESHOLD", "0.30"))
    block_th = float(os.environ.get("BLOCK_THRESHOLD", "0.70"))

    detail = event.get("detail") or {}
    order_id = detail.get("orderId", "unknown")
    rules_score = _local_score(detail)
    try:
        xgboost_score = _xgboost_score(detail)
        score = max(xgboost_score, rules_score)
        model_version = "lambda-xgboost-json-v1+rules-v1"
    except Exception as exc:
        # Keep the event flow working, but make the fallback visible in logs.
        print(f"XGBoost Lambda inference failed; falling back to local rules: {exc}")
        score = rules_score
        model_version = "local-rules-v1"

    if score < approve_th:
        decision = "APPROVE"
        detail_type = "OrderApproved"
    elif score >= block_th:
        decision = "BLOCK"
        detail_type = "OrderBlocked"
    else:
        decision = "REVIEW"
        detail_type = "OrderReview"

    out_detail = {
        "orderId": order_id,
        "score": score,
        "decision": decision,
        "modelVersion": model_version,
        "thresholds": {"approve": approve_th, "block": block_th},
        "evaluatedAt": int(time.time() * 1000),
    }
    review_message_id = None
    if decision == "REVIEW":
        message_body = json.dumps(
            {
                "orderId": order_id,
                "score": score,
                "decision": decision,
                "queuedAt": out_detail["evaluatedAt"],
            }
        )
        send_result = sqs.send_message(
            QueueUrl=review_queue_url,
            MessageBody=message_body,
        )
        review_message_id = send_result.get("MessageId")

    _update_order_status(order_id, out_detail, review_message_id)

    entries = [
        {
            "EventBusName": bus_name,
            "Source": "fraud.service",
            "DetailType": detail_type,
            "Detail": json.dumps(out_detail),
        }
    ]
    if decision == "REVIEW":
        entries.append(
            {
                "EventBusName": bus_name,
                "Source": "fraud.service",
                "DetailType": "OrderSentToReviewQueue",
                "Detail": json.dumps(
                    {
                        "orderId": order_id,
                        "decision": decision,
                        "score": score,
                        "reviewMessageId": review_message_id,
                        "queuedAt": out_detail["evaluatedAt"],
                    }
                ),
            }
        )
    events.put_events(Entries=entries)

    return {"ok": True, "emitted": detail_type, "orderId": order_id, "score": score}


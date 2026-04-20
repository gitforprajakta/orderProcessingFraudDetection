import json
import os
import time

import boto3

from order_features import order_detail_to_feature_vector, vector_to_csv_line


events = boto3.client("events")
sagemaker_runtime = boto3.client("sagemaker-runtime")


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _local_score(detail: dict) -> float:
    """
    Deterministic heuristic scorer so the event-driven system is testable
    without provisioning SageMaker immediately.
    """
    total = float(detail.get("orderTotal", 0.0))
    country = str(detail.get("shippingCountry", "")).upper()
    item_count = len(detail.get("items", []) or [])

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


def _sagemaker_score(detail: dict) -> float:
    endpoint = os.environ["SAGEMAKER_ENDPOINT_NAME"]
    vec = order_detail_to_feature_vector(detail)
    payload = vector_to_csv_line(vec)

    resp = sagemaker_runtime.invoke_endpoint(
        EndpointName=endpoint,
        ContentType="text/csv",
        Body=payload.encode("utf-8"),
    )
    raw = resp["Body"].read().decode("utf-8").strip()
    # Built-in XGBoost binary:logistic returns a probability per row.
    return _clamp01(float(raw))


def handler(event, context):
    bus_name = os.environ["EVENT_BUS_NAME"]
    mode = os.environ.get("FRAUD_SCORER_MODE", "local").lower()
    approve_th = float(os.environ.get("APPROVE_THRESHOLD", "0.30"))
    block_th = float(os.environ.get("BLOCK_THRESHOLD", "0.70"))

    detail = event.get("detail") or {}
    order_id = detail.get("orderId", "unknown")

    if mode == "sagemaker":
        score = _sagemaker_score(detail)
        model_version = os.environ.get("MODEL_VERSION", "sagemaker")
    else:
        score = _local_score(detail)
        model_version = "local-heuristic-v1"

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

    events.put_events(
        Entries=[
            {
                "EventBusName": bus_name,
                "Source": "fraud.service",
                "DetailType": detail_type,
                "Detail": json.dumps(out_detail),
            }
        ]
    )

    return {"ok": True, "emitted": detail_type, "orderId": order_id, "score": score}


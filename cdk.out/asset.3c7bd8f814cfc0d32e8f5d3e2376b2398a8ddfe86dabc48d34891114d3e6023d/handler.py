import json
import os
import time
import uuid
from decimal import Decimal

import boto3


ddb = boto3.resource("dynamodb")
events = boto3.client("events")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json",
}


def _to_decimal(value: float) -> Decimal:
    """DynamoDB Table API rejects Python float; Decimal is required for numbers."""
    return Decimal(str(value))


def _bad_request(message: str):
    return {
        "statusCode": 400,
        "headers": CORS_HEADERS,
        "body": json.dumps({"message": message}),
    }


def handler(event, context):
    table_name = os.environ["ORDERS_TABLE_NAME"]
    bus_name = os.environ["EVENT_BUS_NAME"]
    table = ddb.Table(table_name)

    if "body" not in event or event["body"] is None:
        return _bad_request("Missing request body")

    try:
        body = json.loads(event["body"])
    except json.JSONDecodeError:
        return _bad_request("Invalid JSON")

    items = body.get("items")
    currency = body.get("currency", "USD")
    shipping_postal = body.get("shippingPostal")
    shipping_country = body.get("shippingCountry")

    if not isinstance(items, list) or len(items) == 0:
        return _bad_request("items must be a non-empty list")
    if not shipping_postal or not shipping_country:
        return _bad_request("shippingPostal and shippingCountry are required")

    order_total = 0.0
    normalized_items = []
    for i in items:
        try:
            sku = i["sku"]
            qty = int(i["qty"])
            unit_price = float(i["unitPrice"])
        except Exception:
            return _bad_request("Each item must have sku, qty, unitPrice")
        if qty <= 0 or unit_price < 0:
            return _bad_request("qty must be > 0 and unitPrice must be >= 0")
        order_total += qty * unit_price
        normalized_items.append(
            {"sku": sku, "qty": qty, "unitPrice": _to_decimal(unit_price)}
        )

    order_id = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)

    # Try to take userId from Cognito JWT authorizer context.
    user_id = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        .get("sub")
    ) or "anonymous"

    order_item = {
        "orderId": order_id,
        "userId": user_id,
        "status": "PENDING",
        "createdAt": now_ms,
        "currency": currency,
        "shippingPostal": shipping_postal,
        "shippingCountry": shipping_country,
        "orderTotal": _to_decimal(order_total),
        "items": normalized_items,
    }

    table.put_item(Item=order_item)

    # EventBridge Detail must be JSON-serializable (floats OK; Decimal is not).
    detail_items = [
        {
            "sku": it["sku"],
            "qty": it["qty"],
            "unitPrice": float(it["unitPrice"]),
        }
        for it in normalized_items
    ]
    events.put_events(
        Entries=[
            {
                "EventBusName": bus_name,
                "Source": "order.service",
                "DetailType": "OrderCreated",
                "Detail": json.dumps(
                    {
                        "orderId": order_id,
                        "userId": user_id,
                        "createdAt": now_ms,
                        "currency": currency,
                        "shippingPostal": shipping_postal,
                        "shippingCountry": shipping_country,
                        "orderTotal": float(order_total),
                        "items": detail_items,
                    }
                ),
            }
        ]
    )

    return {
        "statusCode": 202,
        "headers": CORS_HEADERS,
        "body": json.dumps({"orderId": order_id, "status": "PENDING"}),
    }


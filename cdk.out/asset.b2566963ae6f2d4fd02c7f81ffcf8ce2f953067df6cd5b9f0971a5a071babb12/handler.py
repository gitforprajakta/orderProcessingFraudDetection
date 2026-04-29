"""
Order Lambda.

Receives a POST /orders request from an authenticated Cognito user,
validates each line item against the Products table (server-side pricing),
atomically decrements stock, persists the order in DynamoDB, clears the
user's cart, and emits an OrderCreated event so the Fraud Lambda can score it.
"""
import json
import os
import time
import uuid
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError


ddb = boto3.resource("dynamodb")
events = boto3.client("events")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json",
}


def _to_decimal(value) -> Decimal:
    """DynamoDB requires Decimal, never float."""
    return Decimal(str(value))


def _resp(status: int, payload: dict):
    return {
        "statusCode": status,
        "headers": CORS_HEADERS,
        "body": json.dumps(payload),
    }


def _bad_request(message: str):
    return _resp(400, {"message": message})


def _claims(event):
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        or {}
    )


def _get_product(table, sku: str):
    res = table.get_item(Key={"sku": sku})
    item = res.get("Item")
    if not item or not item.get("active", True):
        return None
    return item


def _restore_stock(table, decrements):
    """Best-effort rollback for stock decrements that already succeeded."""
    for sku, qty in decrements:
        try:
            table.update_item(
                Key={"sku": sku},
                UpdateExpression="SET stock = stock + :q",
                ExpressionAttributeValues={":q": qty},
            )
        except ClientError:
            pass


def handler(event, context):
    orders_table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])
    products_table = ddb.Table(os.environ["PRODUCTS_TABLE_NAME"])
    carts_table = ddb.Table(os.environ["CARTS_TABLE_NAME"])
    bus_name = os.environ["EVENT_BUS_NAME"]

    if "body" not in event or event["body"] is None:
        return _bad_request("Missing request body")

    try:
        body = json.loads(event["body"])
    except json.JSONDecodeError:
        return _bad_request("Invalid JSON")

    items_in = body.get("items")
    currency = body.get("currency", "USD")
    shipping_postal = body.get("shippingPostal")
    shipping_country = body.get("shippingCountry")

    if not isinstance(items_in, list) or len(items_in) == 0:
        return _bad_request("items must be a non-empty list")
    if not shipping_postal or not shipping_country:
        return _bad_request("shippingPostal and shippingCountry are required")

    claims = _claims(event)
    user_id = claims.get("sub")
    user_email = claims.get("email") or ""
    if not user_id:
        return _resp(401, {"message": "Unauthorized: missing user identity"})

    # ------------------------------------------------------------------
    # Validate items against the Products table; use server-side prices.
    # Atomically decrement stock with conditional updates so we never
    # oversell. Roll back any successful decrements on failure.
    # ------------------------------------------------------------------
    decremented = []
    priced_items = []
    order_total = Decimal("0")

    for raw in items_in:
        try:
            sku = str(raw["sku"]).strip()
            qty = int(raw["qty"])
        except Exception:
            _restore_stock(products_table, decremented)
            return _bad_request("Each item must have sku and qty")

        if qty <= 0:
            _restore_stock(products_table, decremented)
            return _bad_request("qty must be > 0")

        product = _get_product(products_table, sku)
        if not product:
            _restore_stock(products_table, decremented)
            return _resp(404, {"message": f"Unknown SKU: {sku}"})

        unit_price = _to_decimal(product["price"])

        try:
            products_table.update_item(
                Key={"sku": sku},
                UpdateExpression="SET stock = stock - :q",
                ConditionExpression="stock >= :q",
                ExpressionAttributeValues={":q": qty},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                _restore_stock(products_table, decremented)
                return _resp(
                    409,
                    {
                        "message": f"Insufficient stock for {sku}",
                        "sku": sku,
                    },
                )
            raise

        decremented.append((sku, qty))
        line_total = unit_price * qty
        order_total += line_total
        priced_items.append(
            {
                "sku": sku,
                "name": product.get("name", sku),
                "qty": qty,
                "unitPrice": unit_price,
                "lineTotal": line_total,
            }
        )

    order_id = str(uuid.uuid4())
    now_ms = int(time.time() * 1000)

    order_record = {
        "orderId": order_id,
        "userId": user_id,
        "userEmail": user_email,
        "status": "PENDING",
        "createdAt": now_ms,
        "currency": currency,
        "shippingPostal": shipping_postal,
        "shippingCountry": shipping_country,
        "orderTotal": order_total,
        "items": priced_items,
    }

    try:
        orders_table.put_item(Item=order_record)
    except ClientError:
        _restore_stock(products_table, decremented)
        raise

    # Clear the user's cart now that the order is placed.
    try:
        carts_table.delete_item(Key={"userId": user_id})
    except ClientError:
        pass

    # EventBridge Detail must be JSON-serializable (no Decimal).
    detail_items = [
        {
            "sku": it["sku"],
            "name": it["name"],
            "qty": it["qty"],
            "unitPrice": float(it["unitPrice"]),
        }
        for it in priced_items
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

    return _resp(
        202,
        {
            "orderId": order_id,
            "status": "PENDING",
            "orderTotal": float(order_total),
            "currency": currency,
            "items": detail_items,
        },
    )

"""
Stock Restore Lambda.

Subscribed (via EventBridge) to OrderBlocked events from both the Fraud
Lambda and the Admin Lambda. When an order is blocked the items will not
ship, so we add the reserved quantities back to the Products table.

Idempotency: we mark the order with `stockRestored: true` after restoring,
and skip if already restored.
"""
import json
import os

import boto3
from botocore.exceptions import ClientError


ddb = boto3.resource("dynamodb")


def handler(event, context):
    detail = event.get("detail") or {}
    order_id = detail.get("orderId")
    if not order_id:
        return {"ok": False, "reason": "missing orderId"}

    orders_table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])
    products_table = ddb.Table(os.environ["PRODUCTS_TABLE_NAME"])

    res = orders_table.get_item(Key={"orderId": order_id})
    order = res.get("Item")
    if not order:
        return {"ok": False, "reason": "order not found"}
    if order.get("stockRestored"):
        return {"ok": True, "reason": "already restored"}

    restored = []
    for item in order.get("items", []) or []:
        sku = item.get("sku")
        qty = int(item.get("qty", 0) or 0)
        if not sku or qty <= 0:
            continue
        try:
            products_table.update_item(
                Key={"sku": sku},
                UpdateExpression="SET stock = stock + :q",
                ExpressionAttributeValues={":q": qty},
                ConditionExpression="attribute_exists(sku)",
            )
            restored.append({"sku": sku, "qty": qty})
        except ClientError as e:
            print(f"Failed to restore stock for {sku}: {e}")

    try:
        orders_table.update_item(
            Key={"orderId": order_id},
            UpdateExpression="SET stockRestored = :t",
            ExpressionAttributeValues={":t": True},
        )
    except ClientError as e:
        print(f"Failed to mark order restored: {e}")

    return {"ok": True, "orderId": order_id, "restored": restored}

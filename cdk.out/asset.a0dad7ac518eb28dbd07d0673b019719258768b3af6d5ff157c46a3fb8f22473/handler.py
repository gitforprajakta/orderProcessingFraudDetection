"""
Cart Lambda.

Routes (all customer-authenticated):
  GET    /cart                  -> read my cart
  DELETE /cart                  -> clear my cart
  POST   /cart/items            -> add item {sku, qty}
  PUT    /cart/items/{sku}      -> set qty {qty}
  DELETE /cart/items/{sku}      -> remove item

Cart is stored as a single DynamoDB item per user, keyed on Cognito sub.
Prices are looked up live from the Products table for snapshotting and
display, but the source of truth for prices on checkout is the order
Lambda (which always re-reads the product).
"""
import json
import os
import time
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError


ddb = boto3.resource("dynamodb")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
    "Content-Type": "application/json",
}


def _to_decimal(v):
    return Decimal(str(v))


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


def _user_id(event):
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        .get("sub")
    )


def _carts():
    return ddb.Table(os.environ["CARTS_TABLE_NAME"])


def _products():
    return ddb.Table(os.environ["PRODUCTS_TABLE_NAME"])


def _empty_cart(user_id):
    return {"userId": user_id, "items": [], "updatedAt": 0}


def _hydrate(cart):
    """Add per-line product info and totals to the cart for display."""
    items = cart.get("items") or []
    products = _products()
    hydrated = []
    subtotal = Decimal("0")
    for it in items:
        sku = it["sku"]
        qty = int(it["qty"])
        prod_res = products.get_item(Key={"sku": sku})
        prod = prod_res.get("Item")
        if not prod or not prod.get("active", True):
            continue
        unit = _to_decimal(prod["price"])
        line = unit * qty
        subtotal += line
        hydrated.append(
            {
                "sku": sku,
                "qty": qty,
                "name": prod.get("name", sku),
                "imageUrl": prod.get("imageUrl", ""),
                "unitPrice": unit,
                "lineTotal": line,
                "stock": int(prod.get("stock", 0)),
            }
        )
    return {
        "userId": cart["userId"],
        "items": hydrated,
        "subtotal": subtotal,
        "currency": "USD",
        "updatedAt": cart.get("updatedAt", 0),
    }


def _read_cart(user_id):
    res = _carts().get_item(Key={"userId": user_id})
    return res.get("Item") or _empty_cart(user_id)


def _write_cart(cart):
    cart["updatedAt"] = int(time.time() * 1000)
    _carts().put_item(Item=cart)


def _get(event):
    user_id = _user_id(event)
    cart = _read_cart(user_id)
    return _resp(200, _hydrate(cart))


def _clear(event):
    user_id = _user_id(event)
    try:
        _carts().delete_item(Key={"userId": user_id})
    except ClientError:
        pass
    return _resp(200, _hydrate(_empty_cart(user_id)))


def _add_item(event):
    user_id = _user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    sku = str(body.get("sku", "")).strip()
    try:
        qty = int(body.get("qty", 1))
    except Exception:
        return _resp(400, {"message": "qty must be an integer"})
    if not sku or qty <= 0:
        return _resp(400, {"message": "sku and qty>0 required"})

    prod = _products().get_item(Key={"sku": sku}).get("Item")
    if not prod or not prod.get("active", True):
        return _resp(404, {"message": "Unknown SKU"})

    cart = _read_cart(user_id)
    items = cart.get("items") or []
    found = False
    for it in items:
        if it["sku"] == sku:
            it["qty"] = int(it["qty"]) + qty
            found = True
            break
    if not found:
        items.append({"sku": sku, "qty": qty})
    cart["items"] = items
    _write_cart(cart)
    return _resp(200, _hydrate(cart))


def _set_item(event, sku):
    user_id = _user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})
    try:
        qty = int(body.get("qty", 0))
    except Exception:
        return _resp(400, {"message": "qty must be an integer"})

    cart = _read_cart(user_id)
    items = [it for it in (cart.get("items") or []) if it["sku"] != sku]
    if qty > 0:
        items.append({"sku": sku, "qty": qty})
    cart["items"] = items
    _write_cart(cart)
    return _resp(200, _hydrate(cart))


def _remove_item(event, sku):
    user_id = _user_id(event)
    cart = _read_cart(user_id)
    cart["items"] = [
        it for it in (cart.get("items") or []) if it["sku"] != sku
    ]
    _write_cart(cart)
    return _resp(200, _hydrate(cart))


def handler(event, context):
    method = event.get("httpMethod", "")
    path = event.get("resource", "")
    path_params = event.get("pathParameters") or {}
    sku = path_params.get("sku")

    if not _user_id(event):
        return _resp(401, {"message": "Unauthorized"})

    if path == "/cart" and method == "GET":
        return _get(event)
    if path == "/cart" and method == "DELETE":
        return _clear(event)
    if path == "/cart/items" and method == "POST":
        return _add_item(event)
    if path == "/cart/items/{sku}" and method == "PUT":
        return _set_item(event, sku)
    if path == "/cart/items/{sku}" and method == "DELETE":
        return _remove_item(event, sku)

    return _resp(405, {"message": f"Method not allowed: {method} {path}"})

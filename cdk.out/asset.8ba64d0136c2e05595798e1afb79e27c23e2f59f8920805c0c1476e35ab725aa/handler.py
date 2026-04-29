"""
Notification Lambda.

Triggered by EventBridge for OrderApproved / OrderBlocked / OrderReview events.

For each event we:
  1. Look up the full order from DynamoDB so we can include product-level
     details (name, SKU, qty, unit price, line total, image URL).
  2. Look up missing imageUrls from the Products table for older orders that
     pre-date the imageUrl-on-order-item change.
  3. Build a receipt-style plain-text email body that lists every item like
     a card and append the raw event JSON for traceability.
  4. Publish to the OrderNotificationsTopic SNS topic so the three admin
     subscribers receive the email.

NOTE: SNS email delivery is plain-text only. To get a real HTML "card" look
with embedded product images, switch this Lambda to send via SES instead.
"""
import json
import os
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError


sns = boto3.client("sns")
ddb = boto3.resource("dynamodb")


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


def _native(obj):
    """Recursively turn DynamoDB Decimals into plain ints / floats."""
    if isinstance(obj, list):
        return [_native(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _native(v) for k, v in obj.items()}
    if isinstance(obj, Decimal):
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    return obj


def _fmt_money(value, currency="USD") -> str:
    try:
        return f"{currency} {float(value):,.2f}"
    except (TypeError, ValueError):
        return f"{currency} {value}"


def _fmt_ts(ms) -> str:
    if ms is None:
        return "—"
    try:
        from datetime import datetime, timezone

        return (
            datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc)
            .strftime("%Y-%m-%d %H:%M:%S UTC")
        )
    except Exception:
        return str(ms)


def _load_order(order_id: str):
    table_name = os.environ.get("ORDERS_TABLE_NAME")
    if not table_name or not order_id or order_id == "unknown":
        return None
    try:
        res = ddb.Table(table_name).get_item(Key={"orderId": order_id})
    except ClientError as exc:
        print(f"DDB get_item failed for order {order_id}: {exc}")
        return None
    return _native(res.get("Item"))


def _backfill_image_urls(items):
    """For older orders that don't have imageUrl on the line items,
    fetch them from the Products table once each."""
    products_table_name = os.environ.get("PRODUCTS_TABLE_NAME")
    if not products_table_name:
        return items
    products = ddb.Table(products_table_name)
    cache = {}
    for it in items:
        if it.get("imageUrl"):
            continue
        sku = it.get("sku")
        if not sku:
            continue
        if sku not in cache:
            try:
                p = products.get_item(Key={"sku": sku}).get("Item") or {}
                cache[sku] = p.get("imageUrl", "") or ""
            except ClientError:
                cache[sku] = ""
        if cache[sku]:
            it["imageUrl"] = cache[sku]
    return items


def _render_item_card(idx: int, total: int, it: dict) -> str:
    """One product 'card' rendered as a labeled block of plain text."""
    name = it.get("name") or it.get("sku") or "Item"
    sku = it.get("sku", "—")
    qty = it.get("qty", 1)
    unit_price = it.get("unitPrice", 0)
    line_total = it.get("lineTotal")
    if line_total is None:
        try:
            line_total = float(unit_price) * float(qty)
        except (TypeError, ValueError):
            line_total = 0
    image_url = it.get("imageUrl") or "(no image)"
    category = it.get("category") or "—"

    width = 64
    border_top = "+" + "-" * (width - 2) + "+"
    title = f" Item {idx}/{total}: {name}"[: width - 2].ljust(width - 2)
    return "\n".join(
        [
            border_top,
            "|" + title + "|",
            border_top,
            f"  SKU         : {sku}",
            f"  Category    : {category}",
            f"  Quantity    : {qty}",
            f"  Unit price  : {_fmt_money(unit_price)}",
            f"  Line total  : {_fmt_money(line_total)}",
            f"  Image       : {image_url}",
        ]
    )


def _build_message(detail_type: str, detail: dict, order: dict | None) -> str:
    headline = HUMAN_LINE.get(detail_type, f"Order event: {detail_type}")
    order_id = detail.get("orderId", "unknown")
    score = detail.get("score")
    decision = detail.get("decision") or detail_type.replace("Order", "").upper()
    admin_email = detail.get("adminEmail")
    admin_override = detail.get("adminOverride")

    order = order or {}
    items = order.get("items") or detail.get("items") or []
    if items:
        items = _backfill_image_urls(items)

    currency = order.get("currency", "USD")
    order_total = order.get("orderTotal", detail.get("orderTotal", 0))

    user_email = order.get("userEmail") or "—"
    user_id = order.get("userId") or detail.get("userId") or "—"
    shipping_country = order.get("shippingCountry") or "—"
    shipping_postal = order.get("shippingPostal") or "—"
    created_at = _fmt_ts(order.get("createdAt"))
    evaluated_at = _fmt_ts(detail.get("evaluatedAt") or order.get("evaluatedAt"))

    sep = "=" * 64
    sub = "-" * 64

    lines = [
        sep,
        f"  NimbusMart  ·  {decision}",
        sep,
        headline,
        "",
        "ORDER",
        sub,
        f"  Order ID         : {order_id}",
        f"  Status           : {decision}",
        f"  Fraud score      : {score if score is not None else '—'}",
        f"  Order total      : {_fmt_money(order_total, currency)}",
        f"  Placed at        : {created_at}",
        f"  Decision at      : {evaluated_at}",
    ]
    if admin_override:
        lines.append(f"  Admin override   : {admin_email or 'unknown'}")
    lines += [
        "",
        "CUSTOMER",
        sub,
        f"  Email            : {user_email}",
        f"  User ID          : {user_id}",
        f"  Ship to          : {shipping_postal}, {shipping_country}",
    ]

    if items:
        lines += ["", f"ITEMS ({len(items)})", sub, ""]
        for i, it in enumerate(items, start=1):
            lines.append(_render_item_card(i, len(items), it))
            lines.append("")
    else:
        lines += [
            "",
            "ITEMS",
            sub,
            "  (no item details available for this order)",
        ]

    if detail_type == "OrderReview":
        lines += [
            "",
            "ACTION REQUIRED",
            sub,
            "  This order is parked on the SQS OrderReviewQueue.",
            "  Sign in to the admin app -> Review Queue tab,",
            "  then click APPROVE or BLOCK to release it from the queue.",
        ]

    lines += [
        "",
        sep,
        "Raw event payload (for debugging):",
        sep,
        json.dumps({"event": detail_type, "detail": detail}, default=str, indent=2),
    ]
    return "\n".join(lines)


def handler(event, context):
    topic_arn = os.environ["SNS_TOPIC_ARN"]

    detail_type = event.get("detail-type") or event.get("detailType") or "Unknown"
    detail = event.get("detail") or {}
    order_id = detail.get("orderId", "unknown")

    order = _load_order(order_id)

    subject = SUBJECT_PREFIX.get(detail_type, f"[NimbusMart] {detail_type}")
    subject = (subject + f" — {order_id[:8]}")[:100]  # SNS subject limit = 100

    message = _build_message(detail_type, detail, order)

    sns.publish(TopicArn=topic_arn, Subject=subject, Message=message)

    return {
        "published": True,
        "event": detail_type,
        "orderId": order_id,
        "itemsIncluded": len((order or {}).get("items") or []),
    }

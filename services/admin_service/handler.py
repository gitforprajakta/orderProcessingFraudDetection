"""
Admin Lambda.

Routes (all admin-only, enforced by Cognito group claim):
  GET    /admin/orders                            -> list all orders (optionally ?status=)
  GET    /admin/orders/{orderId}                  -> single order (admin view)
  POST   /admin/orders/{orderId}/decision         -> manually APPROVE or BLOCK a REVIEW order
                                                     (also deletes the matching message from
                                                     the SQS ReviewQueue when receiptHandle is
                                                     provided in the request body)
  GET    /admin/review-queue                      -> pull pending OrderReview messages from SQS
                                                     so admins can act on them
  GET    /admin/stats                             -> dashboard metrics (orders by status,
                                                     revenue, low-stock products, customer count)
  GET    /admin/users                             -> list Cognito users + groups
  POST   /admin/users/{username}/group            -> { groupName: "admins"|"customers", action: "add"|"remove" }
  POST   /admin/users/{username}/enabled          -> { enabled: true | false }
  GET    /admin/products                          -> list ALL products (active + inactive)
  GET    /admin/products/{sku}                    -> single product (admin view, inactive ok)
"""
import json
import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError


ddb = boto3.resource("dynamodb")
events = boto3.client("events")
sqs = boto3.client("sqs")
cognito = boto3.client("cognito-idp")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
    "Content-Type": "application/json",
}

ADMIN_GROUP = os.environ.get("ADMIN_GROUP", "admins")
CUSTOMER_GROUP = os.environ.get("CUSTOMER_GROUP", "customers")
LOW_STOCK_THRESHOLD = int(os.environ.get("LOW_STOCK_THRESHOLD", "5"))


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


def _claims(event):
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("claims", {})
        or {}
    )


def _is_admin(event) -> bool:
    groups = _claims(event).get("cognito:groups", "")
    if isinstance(groups, list):
        return ADMIN_GROUP in groups
    return ADMIN_GROUP in str(groups).split(",")


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------
def _list_orders(event):
    qs = event.get("queryStringParameters") or {}
    status = qs.get("status")
    table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])

    if status:
        res = table.scan(FilterExpression=Attr("status").eq(status))
    else:
        res = table.scan()

    items = res.get("Items", [])
    items.sort(key=lambda it: it.get("createdAt", 0), reverse=True)
    return _resp(200, {"orders": items})


def _get_order(order_id):
    table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])
    res = table.get_item(Key={"orderId": order_id})
    item = res.get("Item")
    if not item:
        return _resp(404, {"message": "Order not found"})
    return _resp(200, item)


def _list_review_queue(event):
    queue_url = os.environ.get("REVIEW_QUEUE_URL")
    if not queue_url:
        return _resp(500, {"message": "REVIEW_QUEUE_URL not configured"})

    qs = event.get("queryStringParameters") or {}
    try:
        max_messages = max(1, min(10, int(qs.get("max", "10"))))
    except (TypeError, ValueError):
        max_messages = 10

    try:
        res = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=max_messages,
            WaitTimeSeconds=1,
            VisibilityTimeout=30,
            MessageAttributeNames=["All"],
        )
    except ClientError as exc:
        return _resp(500, {"message": f"SQS receive failed: {exc}"})

    sqs_messages = res.get("Messages", []) or []
    orders_table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])

    items = []
    for m in sqs_messages:
        try:
            body = json.loads(m.get("Body") or "{}")
        except json.JSONDecodeError:
            body = {}
        detail = body.get("detail") or {}
        order_id = detail.get("orderId")

        order = None
        if order_id:
            try:
                order = orders_table.get_item(Key={"orderId": order_id}).get(
                    "Item"
                )
            except ClientError:
                order = None

        items.append(
            {
                "messageId": m.get("MessageId"),
                "receiptHandle": m.get("ReceiptHandle"),
                "orderId": order_id,
                "score": detail.get("score"),
                "decision": detail.get("decision"),
                "evaluatedAt": detail.get("evaluatedAt"),
                "order": order,
            }
        )

    return _resp(200, {"messages": items, "count": len(items)})


def _delete_review_message(receipt_handle: str) -> None:
    queue_url = os.environ.get("REVIEW_QUEUE_URL")
    if not queue_url or not receipt_handle:
        return
    try:
        sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)
    except ClientError as exc:
        # Not fatal — DB and SNS are the source of truth; the message will
        # eventually move to DLQ if it can't be processed.
        print(f"SQS delete_message failed: {exc}")


def _override_decision(event, order_id):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    decision = str(body.get("decision", "")).upper()
    if decision not in {"APPROVE", "BLOCK"}:
        return _resp(400, {"message": "decision must be APPROVE or BLOCK"})

    receipt_handle = body.get("receiptHandle")

    table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])
    bus_name = os.environ["EVENT_BUS_NAME"]
    admin_email = _claims(event).get("email", "")

    res = table.get_item(Key={"orderId": order_id})
    order = res.get("Item")
    if not order:
        return _resp(404, {"message": "Order not found"})

    now_ms = int(time.time() * 1000)
    table.update_item(
        Key={"orderId": order_id},
        UpdateExpression=(
            "SET #status = :s, fraudDecision = :d, "
            "adminOverride = :over, adminEmail = :ae, evaluatedAt = :ev"
        ),
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":s": decision,
            ":d": decision,
            ":over": True,
            ":ae": admin_email,
            ":ev": now_ms,
        },
    )

    detail_type = "OrderApproved" if decision == "APPROVE" else "OrderBlocked"
    out_detail = {
        "orderId": order_id,
        "userId": order.get("userId"),
        "decision": decision,
        "adminOverride": True,
        "adminEmail": admin_email,
        "evaluatedAt": now_ms,
        "items": _decimals_to_native(order.get("items", [])),
        "orderTotal": _decimals_to_native(order.get("orderTotal", 0)),
    }
    events.put_events(
        Entries=[
            {
                "EventBusName": bus_name,
                "Source": "admin.service",
                "DetailType": detail_type,
                "Detail": json.dumps(out_detail),
            }
        ]
    )

    if receipt_handle:
        _delete_review_message(receipt_handle)

    return _resp(
        200,
        {
            "orderId": order_id,
            "status": decision,
            "removedFromReviewQueue": bool(receipt_handle),
        },
    )


# ---------------------------------------------------------------------------
# Products (admin view — includes inactive items so they can be restored)
# ---------------------------------------------------------------------------
def _admin_list_products(_event):
    table = ddb.Table(os.environ["PRODUCTS_TABLE_NAME"])
    items = []
    last_key = None
    while True:
        kwargs = {}
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        res = table.scan(**kwargs)
        items.extend(res.get("Items", []))
        last_key = res.get("LastEvaluatedKey")
        if not last_key:
            break
    items.sort(key=lambda it: it.get("name", ""))
    return _resp(200, {"products": items})


def _admin_get_product(sku):
    table = ddb.Table(os.environ["PRODUCTS_TABLE_NAME"])
    res = table.get_item(Key={"sku": sku})
    item = res.get("Item")
    if not item:
        return _resp(404, {"message": "Product not found"})
    return _resp(200, item)


# ---------------------------------------------------------------------------
# Stats / dashboard
# ---------------------------------------------------------------------------
def _stats(_event):
    orders_table = ddb.Table(os.environ["ORDERS_TABLE_NAME"])
    products_table = ddb.Table(os.environ["PRODUCTS_TABLE_NAME"])

    orders = []
    last_key = None
    while True:
        kwargs = {}
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        res = orders_table.scan(**kwargs)
        orders.extend(res.get("Items", []))
        last_key = res.get("LastEvaluatedKey")
        if not last_key:
            break

    products = []
    last_key = None
    while True:
        kwargs = {}
        if last_key:
            kwargs["ExclusiveStartKey"] = last_key
        res = products_table.scan(**kwargs)
        products.extend(res.get("Items", []))
        last_key = res.get("LastEvaluatedKey")
        if not last_key:
            break

    by_status = {}
    revenue = Decimal("0")
    approved_count = 0
    seven_days_ago = int((time.time() - 7 * 24 * 3600) * 1000)
    last_7_days_orders = 0

    for o in orders:
        st = str(o.get("status", "UNKNOWN")).upper()
        by_status[st] = by_status.get(st, 0) + 1
        if st == "APPROVE":
            revenue += Decimal(str(o.get("orderTotal", 0)))
            approved_count += 1
        if int(o.get("createdAt", 0) or 0) >= seven_days_ago:
            last_7_days_orders += 1

    active_products = [p for p in products if p.get("active", True)]
    inactive_products = [p for p in products if not p.get("active", True)]
    low_stock = sorted(
        [
            {
                "sku": p.get("sku"),
                "name": p.get("name"),
                "stock": int(p.get("stock", 0)),
            }
            for p in active_products
            if int(p.get("stock", 0) or 0) <= LOW_STOCK_THRESHOLD
        ],
        key=lambda x: x["stock"],
    )

    user_pool_id = os.environ.get("USER_POOL_ID")
    customer_count = 0
    admin_count = 0
    if user_pool_id:
        try:
            customer_count = _count_in_group(user_pool_id, CUSTOMER_GROUP)
            admin_count = _count_in_group(user_pool_id, ADMIN_GROUP)
        except ClientError as exc:
            print(f"Cognito group count failed: {exc}")

    avg_order_value = (
        float(revenue) / approved_count if approved_count else 0.0
    )

    return _resp(
        200,
        {
            "orders": {
                "total": len(orders),
                "byStatus": by_status,
                "last7Days": last_7_days_orders,
                "revenueApproved": revenue,
                "averageApprovedOrderValue": avg_order_value,
            },
            "products": {
                "total": len(products),
                "active": len(active_products),
                "inactive": len(inactive_products),
                "lowStockThreshold": LOW_STOCK_THRESHOLD,
                "lowStock": low_stock,
            },
            "users": {
                "customers": customer_count,
                "admins": admin_count,
            },
        },
    )


def _count_in_group(user_pool_id: str, group: str) -> int:
    total = 0
    next_token = None
    while True:
        kwargs = {
            "UserPoolId": user_pool_id,
            "GroupName": group,
            "Limit": 60,
        }
        if next_token:
            kwargs["NextToken"] = next_token
        res = cognito.list_users_in_group(**kwargs)
        total += len(res.get("Users", []))
        next_token = res.get("NextToken")
        if not next_token:
            break
    return total


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
def _list_users(event):
    user_pool_id = os.environ.get("USER_POOL_ID")
    if not user_pool_id:
        return _resp(500, {"message": "USER_POOL_ID not configured"})

    qs = event.get("queryStringParameters") or {}
    try:
        limit = max(1, min(60, int(qs.get("limit", "60"))))
    except (TypeError, ValueError):
        limit = 60

    pagination = qs.get("paginationToken")
    kwargs = {"UserPoolId": user_pool_id, "Limit": limit}
    if pagination:
        kwargs["PaginationToken"] = pagination

    res = cognito.list_users(**kwargs)
    users = []
    for u in res.get("Users", []):
        attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
        username = u.get("Username")
        groups = []
        try:
            g_res = cognito.admin_list_groups_for_user(
                UserPoolId=user_pool_id, Username=username, Limit=10
            )
            groups = [g.get("GroupName") for g in g_res.get("Groups", [])]
        except ClientError as exc:
            print(f"admin_list_groups_for_user failed for {username}: {exc}")

        users.append(
            {
                "username": username,
                "email": attrs.get("email", ""),
                "emailVerified": attrs.get("email_verified") == "true",
                "enabled": u.get("Enabled", True),
                "status": u.get("UserStatus"),
                "createdAt": u.get("UserCreateDate").isoformat()
                if u.get("UserCreateDate")
                else None,
                "groups": groups,
            }
        )

    return _resp(
        200,
        {
            "users": users,
            "nextPaginationToken": res.get("PaginationToken"),
        },
    )


def _modify_user_group(event, username):
    user_pool_id = os.environ.get("USER_POOL_ID")
    if not user_pool_id:
        return _resp(500, {"message": "USER_POOL_ID not configured"})
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})

    group_name = str(body.get("groupName", "")).strip()
    action = str(body.get("action", "")).strip().lower()
    if group_name not in {ADMIN_GROUP, CUSTOMER_GROUP}:
        return _resp(
            400,
            {
                "message": f"groupName must be '{ADMIN_GROUP}' or '{CUSTOMER_GROUP}'"
            },
        )
    if action not in {"add", "remove"}:
        return _resp(400, {"message": "action must be 'add' or 'remove'"})

    acting_admin = _claims(event).get("cognito:username") or _claims(event).get(
        "sub"
    )
    if (
        action == "remove"
        and group_name == ADMIN_GROUP
        and acting_admin
        and acting_admin == username
    ):
        return _resp(
            400, {"message": "You cannot remove yourself from the admins group."}
        )

    try:
        if action == "add":
            cognito.admin_add_user_to_group(
                UserPoolId=user_pool_id,
                Username=username,
                GroupName=group_name,
            )
        else:
            cognito.admin_remove_user_from_group(
                UserPoolId=user_pool_id,
                Username=username,
                GroupName=group_name,
            )
    except ClientError as exc:
        return _resp(400, {"message": f"Cognito error: {exc}"})

    return _resp(
        200,
        {"username": username, "groupName": group_name, "action": action},
    )


def _set_user_enabled(event, username):
    user_pool_id = os.environ.get("USER_POOL_ID")
    if not user_pool_id:
        return _resp(500, {"message": "USER_POOL_ID not configured"})
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"message": "Invalid JSON"})
    enabled = body.get("enabled")
    if enabled not in (True, False):
        return _resp(400, {"message": "enabled must be true or false"})

    acting_admin = _claims(event).get("cognito:username") or _claims(event).get(
        "sub"
    )
    if not enabled and acting_admin and acting_admin == username:
        return _resp(400, {"message": "You cannot disable your own account."})

    try:
        if enabled:
            cognito.admin_enable_user(
                UserPoolId=user_pool_id, Username=username
            )
        else:
            cognito.admin_disable_user(
                UserPoolId=user_pool_id, Username=username
            )
    except ClientError as exc:
        return _resp(400, {"message": f"Cognito error: {exc}"})

    return _resp(200, {"username": username, "enabled": enabled})


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
def handler(event, context):
    if not _is_admin(event):
        return _resp(403, {"message": "Admins only"})

    method = event.get("httpMethod", "")
    path = event.get("resource", "")
    path_params = event.get("pathParameters") or {}

    if path == "/admin/orders" and method == "GET":
        return _list_orders(event)
    if path == "/admin/orders/{orderId}" and method == "GET":
        return _get_order(path_params.get("orderId", ""))
    if path == "/admin/orders/{orderId}/decision" and method == "POST":
        return _override_decision(event, path_params.get("orderId", ""))
    if path == "/admin/review-queue" and method == "GET":
        return _list_review_queue(event)
    if path == "/admin/stats" and method == "GET":
        return _stats(event)
    if path == "/admin/users" and method == "GET":
        return _list_users(event)
    if path == "/admin/users/{username}/group" and method == "POST":
        return _modify_user_group(event, path_params.get("username", ""))
    if path == "/admin/users/{username}/enabled" and method == "POST":
        return _set_user_enabled(event, path_params.get("username", ""))
    if path == "/admin/products" and method == "GET":
        return _admin_list_products(event)
    if path == "/admin/products/{sku}" and method == "GET":
        return _admin_get_product(path_params.get("sku", ""))

    return _resp(405, {"message": f"Method not allowed: {method} {path}"})

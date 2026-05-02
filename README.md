# NimbusMart — Serverless E-Commerce + ML Fraud Detection

A full-stack AWS-native e-commerce demo where every order flows through a real
event-driven fraud-detection pipeline powered by an XGBoost model running
inside AWS Lambda.

- React + Vite frontend hosted on AWS Amplify
- Real Cognito sign-up / login / email verification with admin & customer roles
- DynamoDB-backed product catalog, cart, and order history
- API Gateway + Lambda services for products, cart, orders, admin, uploads
- Atomic stock decrements at checkout (no overselling)
- EventBridge fan-out: OrderCreated → Fraud Lambda → FraudDecision → Notification + Stock-Restore
- XGBoost model trained locally, exported to JSON, evaluated in pure Python in Lambda
- S3 bucket + presigned uploads for product images
- SNS topic for order-decision notifications (APPROVE / BLOCK / REVIEW), with up to 3 admin emails auto-subscribed
- SQS `OrderReviewQueue` (with DLQ) holds every REVIEW order until an admin approves or blocks it
- CloudWatch logs for every Lambda

## Architecture

```
Browser (React SPA on AWS Amplify)
   │
   │  Amplify Auth (Cognito User Pool, email + password, groups)
   ▼
API Gateway (Cognito JWT authorizer)
   │
   ├── /products   ──────►  ProductsLambda   ──►  Products table
   ├── /cart       ──────►  CartLambda       ──►  Carts + Products tables
   ├── /orders     ──────►  OrderLambda      ──►  Products (stock--), Orders, EventBridge
   ├── /me/orders  ──────►  MyOrdersLambda   ──►  Orders (userId GSI)
   ├── /admin/*    ──────►  AdminLambda      ──►  Orders, Products, EventBridge
   └── /uploads/*  ──────►  UploadLambda     ──►  S3 presigned PUT

EventBridge (OrdersBus)
   ├── OrderCreated                  ──►  FraudLambda  ──► Orders (status), EventBridge (decision)
   ├── OrderApproved/Blocked/Review  ──►  NotificationLambda ──► SNS topic ──► 3 admin emails
   ├── OrderReview                   ──►  SQS OrderReviewQueue (waits for an admin)
   └── OrderBlocked                  ──►  StockRestoreLambda ──► Products (stock++)

Admin reviews a queued order:
   AdminLambda  GET  /admin/review-queue           ◄── pulls messages from SQS
   AdminLambda  POST /admin/orders/{id}/decision   ──► updates DDB
                                                   ──► EventBridge OrderApproved/Blocked
                                                   ──► deletes the SQS message

S3 (product images) ◄── public read for catalog images
```

## Demo accounts (auto-created on stack deploy)

| Role     | Email                  | Password             |
|----------|------------------------|----------------------|
| Customer | `testuser@example.com` | `YourSecurePassw0rd!`|
| Admin    | `admin@example.com`    | `AdminPassw0rd!`     |

You can also sign up new accounts from the React app — verification emails are
sent automatically by Cognito.

The login page exposes two tabs at the top:

- **Customer** — for shoppers. Sign-in lands on the catalog. If the account
  happens to be in the `admins` group, the page redirects to the admin
  console.
- **Administrator** — for admin sign-in. After sign-in, the app verifies the
  account is in the `admins` Cognito group. If it isn't, the user is signed
  out and shown an explanatory error.

The toggle is purely a UX/redirection hint; the real authority is the
`cognito:groups` claim in the ID token, which both API Gateway / Lambda and
the React `AdminRoute` enforce.

## Setting up admin accounts

Authority for "admin" comes from membership in the Cognito user pool group
named `admins`. There are five supported ways to create or grant admin
access — pick whichever fits your situation.

### Option A — use the auto-created demo admin

`cdk deploy` always creates `admin@example.com` / `AdminPassw0rd!` and adds
it to the `admins` group. Use this for the demo, then change or rotate the
credentials in production (see Option E).

### Option B — promote an existing user from the admin console

1. Sign in as any existing admin (e.g. the demo admin).
2. Open **Admin → Users**.
3. Find the user, click **Promote to admin**.
4. They will be in the `admins` group on their next token refresh / sign-in.

This is the everyday path once you have at least one bootstrapped admin.

### Option C — promote a user with the AWS CLI

Useful when no admin exists yet, or you're scripting onboarding.

```bash
export USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name OrderProcessingFraudDetectionStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" \
  --output text)

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username "alice@example.com" \
  --group-name admins
```

To remove admin access:

```bash
aws cognito-idp admin-remove-user-from-group \
  --user-pool-id "$USER_POOL_ID" \
  --username "alice@example.com" \
  --group-name admins
```

### Option D — promote a user from the AWS Console

1. AWS Console → **Cognito** → User pools → select the NimbusMart pool
   (the `CognitoUserPoolId` output).
2. **Users** tab → click the user you want to promote.
3. **Group memberships** → **Add user to group** → pick `admins`.
4. Save. The user must sign in (or refresh their session) to pick up the
   new claim.

### Option E — bootstrap a brand-new admin from scratch (CLI)

Creates the user, sets a permanent password, marks the email verified, and
adds them to `admins`:

```bash
export USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name OrderProcessingFraudDetectionStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" \
  --output text)
export ADMIN_EMAIL="alice@example.com"
export ADMIN_PASSWORD='ChangeMe-Now-1!'

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" \
  --permanent

aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username "$ADMIN_EMAIL" \
  --group-name admins
```

Hand the email and password to your new admin out-of-band — they should
log in via the **Administrator** tab on the login page.

### (Optional) subscribe new admins to SNS notifications

Admin order-decision emails (`APPROVE` / `BLOCK` / `REVIEW`) come from the
SNS topic `OrderNotificationsTopic`. To add a new admin's mailbox:

```bash
export TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name OrderProcessingFraudDetectionStack \
  --query "Stacks[0].Outputs[?OutputKey=='OrderNotificationsTopicArn'].OutputValue" \
  --output text)

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint alice@example.com
```

The subscriber must click the confirmation email AWS sends.

## Repository layout

```
infra/                  CDK TypeScript stack (everything AWS)
services/
  order_service/        POST /orders — server-side pricing + atomic stock decrement
  fraud_service/        XGBoost-in-Lambda + rules-based scorer
  notification_service/ Publishes fraud decisions to SNS
  products_service/     GET /products (public) + admin CRUD
  cart_service/         /cart/* routes (per-user, server-stored)
  my_orders_service/    /me/orders/* user-scoped order history
  admin_service/        /admin/orders + manual REVIEW approve/block
  upload_service/       /uploads/product-image (S3 presigned PUT for admins)
  stock_restore_service/Refund stock when an order is blocked
ml/                     Local XGBoost training utilities
frontend/               React + Vite SPA (Amplify-hosted)
amplify.yml             Amplify build spec (npm ci + npm run build)
```

## Prerequisites

- AWS CLI configured with credentials and a region (e.g. `us-west-1`)
- Node.js 18+
- Python 3.11+ (only needed if you want to retrain XGBoost locally)

```bash
export AWS_REGION=us-west-1
export AWS_DEFAULT_REGION=us-west-1
```

## 1. (Optional) Retrain XGBoost from your CSV

The repository already ships with model artifacts under
`services/fraud_service/artifacts/`. Re-run this only if you want to update
them:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements-ml.txt

python ml/train_xgboost_local.py --csv "/path/to/synthetic_fraud_dataset.csv"
```

This regenerates:

- `services/fraud_service/artifacts/xgb_model.json`
- `services/fraud_service/artifacts/inference_spec.json`

Lambda packages those JSON files at deploy time.

## 2. Deploy the backend (CDK)

```bash
npm install
npm run build
npx cdk synth          # validates the stack

# Bootstrap once per AWS account/region:
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}

npx cdk deploy
```

To pre-subscribe up to three admin emails to the SNS notifications topic
during the deploy (recommended), pass them via the `adminEmails` CDK
context (comma-separated). Each address gets a one-click confirmation
email from AWS:

```bash
npx cdk deploy -c adminEmails="alice@example.com,bob@example.com,carol@example.com"
```

You can also subscribe / unsubscribe later via the AWS console or the CLI
snippet in step 7.

Useful outputs:

| Output                       | Used by                        |
|------------------------------|--------------------------------|
| `ApiUrl`                     | Frontend `VITE_API_URL`        |
| `CognitoUserPoolId`          | Frontend `VITE_USER_POOL_ID`   |
| `CognitoUserPoolClientId`    | Frontend `VITE_USER_POOL_CLIENT_ID` |
| `AwsRegion`                  | Frontend `VITE_AWS_REGION`     |
| `ProductImagesBucketName`    | S3 bucket hosting catalog images |
| `OrdersTableName`            | DynamoDB                       |
| `ProductsTableName`          | DynamoDB                       |
| `CartsTableName`             | DynamoDB                       |
| `OrderNotificationsTopicArn` | Subscribe email for APPROVE / BLOCK / REVIEW alerts |
| `ReviewQueueUrl`             | SQS queue URL holding REVIEW orders |
| `ReviewQueueArn`             | SQS queue ARN                  |
| `ReviewQueueDlqUrl`          | DLQ for failed review messages |
| `AdminEmailsSubscribed`      | Echo of `-c adminEmails=` value used at deploy |

Re-fetch outputs anytime:

```bash
aws cloudformation describe-stacks \
  --stack-name OrderProcessingFraudDetectionStack \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
  --output table
```

The deploy automatically:

- Seeds 10 sample products into DynamoDB
- Creates the demo customer + admin Cognito users and assigns groups

## 3. Configure and run the frontend

The React app reads configuration from Vite env vars. For local dev, create
`frontend/.env.local`:

```bash
VITE_API_URL=https://xxx.execute-api.us-west-1.amazonaws.com/prod
VITE_AWS_REGION=us-west-1
VITE_USER_POOL_ID=us-west-1_xxxxxxxx
VITE_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then:

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Or build for static hosting:

```bash
cd frontend
npm run build        # output in frontend/dist
npm run preview      # local preview of the production build
```

## 4. Deploy the frontend to Amplify

### Option A — Connect your Git repository (recommended)

1. AWS Console → **Amplify** → **Host web app** → connect this repo.
2. Amplify auto-detects `amplify.yml`. Confirm and continue.
3. Add the four `VITE_*` environment variables in Amplify (App settings →
   Environment variables) using the CDK outputs.
4. Add a **Rewrite rule** so client-side routing works (App settings →
   Rewrites and redirects → "Rewrites and redirects" tab):

   | Source | Target | Type |
   |--------|--------|------|
   | `</^[^.]+$\|\.(?!(css\|gif\|ico\|jpg\|js\|png\|txt\|svg\|woff\|woff2\|ttf\|map\|json\|webp)$)([^.]+$)/>` | `/index.html` | `200 (Rewrite)` |

5. Trigger a build. Open the Amplify URL.

### Option B — Manual zip upload

```bash
cd frontend
npm install
npm run build
cd dist
zip -r ../../frontend-static.zip .
```

Drag-and-drop `frontend-static.zip` into Amplify "Deploy without Git provider".
Add the rewrite rule above.

## 5. Try it end-to-end

1. Open the Amplify URL.
2. Click **Sign up**, register a new email (or sign in as the demo customer).
3. Click any product → **Add to cart** → **Checkout**.
4. Pick a country/postal that drives the desired fraud decision (see below)
   and click **Place order**.
5. The order page polls every 2 seconds and shows the final decision once
   Fraud Lambda finishes scoring.

### Predictable fraud-rule examples

| Product           | Country | Likely outcome |
|-------------------|---------|----------------|
| BOOK-1 (Books)    | US      | APPROVE        |
| TABLET-1 ×1       | US      | REVIEW         |
| LAPTOP-1 ×6       | IN      | BLOCK          |

Rules layered on top of XGBoost:

- base 0.05
- `+0.25` if order total > $500
- `+0.35` if order total > $1500
- `+0.20` if shipping country not US/CA
- `+0.15` if total quantity ≥ 5

Decision thresholds: `<0.30` APPROVE, `0.30–0.70` REVIEW, `≥0.70` BLOCK.

The final score is `max(xgboost_probability, rules_score)` so demo orders are
deterministic regardless of model drift.

## 6. Admin workflow

1. Sign in via the **Administrator** tab on the login page using
   `admin@example.com` / `AdminPassw0rd!`.
2. You'll be redirected to the admin console (`/admin`).

The admin console has five tabs:

### Dashboard
At-a-glance metrics from `GET /admin/stats`:

- Total orders, orders in the last 7 days
- Approved revenue and average approved order value
- Active vs archived product counts
- Customer / admin counts (from Cognito groups)
- Orders broken down by `PENDING` / `REVIEW` / `APPROVE` / `BLOCK`
- Low-stock alerts (active products with stock ≤ `LOW_STOCK_THRESHOLD`,
  default 5; deep-links to the edit form)

### Inventory
Full product catalog management — including archived items.

- **+ New product** to create a new SKU
- **Search** by name, SKU, or category
- **Show archived** to include soft-deleted products
- **Edit** any product (active or archived)
- **Delete** soft-deletes (`active=false`); the product disappears from the
  public catalog but remains in DynamoDB and the order history
- **Restore** brings an archived product back (`active=true`)
- The product form includes a built-in S3 image uploader (presigned PUT)

Stock numbers are color-coded — orange when ≤ 5, red when 0.

### Orders
Every order, regardless of who placed it.

- Filter by status (default `REVIEW`)
- Click any order ID to open its admin detail page (full items, shipping,
  customer info, fraud score, model version, manual-decision controls)
- For `REVIEW`/`PENDING` orders, **Approve** or **Block** records an
  `adminOverride`, emits an `OrderApproved`/`OrderBlocked` EventBridge
  event, fires another SNS email, and (for blocks) restores stock via
  `stock_restore_service`

### Review Queue
SQS-backed queue of orders the fraud model flagged as `REVIEW`.

- Every `REVIEW` order is pushed to the `OrderReviewQueue` SQS queue and
  an SNS email goes out to all subscribed admins.
- Opening this tab calls `receive_message` with a 30-second visibility
  timeout, so an order claimed by one admin is briefly invisible to the
  other admins — avoiding double-processing.
- **Approve** / **Block** does three things atomically:
  1. Updates the order's `status` in DynamoDB.
  2. Emits an `OrderApproved` / `OrderBlocked` EventBridge event (which
     triggers another SNS email and, for `Block`, the stock-restore
     Lambda).
  3. **Deletes the SQS message** using the receipt handle returned by
     `GET /admin/review-queue`.

### Users
Cognito user-pool management.

- Lists every user with email, status (`enabled`/`disabled` +
  `CONFIRMED`/`UNCONFIRMED`), group memberships, and creation time
- **Promote to admin** / **Demote** — adds or removes the `admins` group
  membership for a user
- **Disable** / **Enable** — toggles `Enabled` on the Cognito user (a
  disabled user can't sign in but their data is preserved)
- You cannot demote or disable yourself (the API blocks it server-side
  too, so you can't lock the org out by accident)

## 7. SNS email subscriptions for the three admins

The recommended path is to pass the three admin emails when you deploy
the stack so CDK creates and manages the subscriptions:

```bash
npx cdk deploy -c adminEmails="alice@example.com,bob@example.com,carol@example.com"
```

To add or change subscribers later without redeploying:

```bash
export TOPIC_ARN=<OrderNotificationsTopicArn>

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint your-email@example.com
```

Confirm the subscription email. Every APPROVE / BLOCK / REVIEW decision is
emailed, including the second notification that fires when an admin
approves or blocks a queued order from the **Review Queue** tab.

## 8. Logs

```bash
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-OrderLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-FraudLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-NotificationLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-ProductsLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-CartLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-MyOrdersLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-AdminLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-UploadLambda" --since 10m
aws logs tail "/aws/lambda/OrderProcessingFraudDetection-StockRestoreLambda" --since 10m
```

## 9. Cleanup

```bash
npx cdk destroy
```

Generated local files that should not be committed:

- `.venv/`
- `cdk.out/`
- `node_modules/`
- `frontend/node_modules/`
- `frontend/dist/`
- `ml/artifacts/local_xgb/`

## API surface

Public:

- `GET  /products`                   list active products (`?category=` filter)
- `GET  /products/{sku}`             get one product

Customer-authenticated:

- `GET    /cart`                     read my cart
- `DELETE /cart`                     clear my cart
- `POST   /cart/items`               add `{sku, qty}`
- `PUT    /cart/items/{sku}`         set qty
- `DELETE /cart/items/{sku}`         remove item
- `POST   /orders`                   place order from cart-resolved items
- `GET    /me/orders`                my order history
- `GET    /me/orders/{orderId}`      one of my orders

Admin-only (`cognito:groups` must contain `admins`):

- `POST   /products`                 create product
- `PUT    /products/{sku}`           update product (use `{ "active": true }` to restore)
- `DELETE /products/{sku}`           soft-delete product (sets `active=false`)
- `GET    /admin/products`           list ALL products (active + archived)
- `GET    /admin/products/{sku}`     single product (returns archived items too)
- `GET    /admin/orders`             list all orders (`?status=` filter)
- `GET    /admin/orders/{id}`        single order (full admin view)
- `POST   /admin/orders/{id}/decision` `{decision: "APPROVE" | "BLOCK", receiptHandle?: string}`
  – when `receiptHandle` is present (returned by `/admin/review-queue`),
  the matching message is deleted from the SQS queue.
- `GET    /admin/review-queue`       pull pending REVIEW messages from SQS
  (`?max=1..10`, default 10). Each entry includes `receiptHandle`,
  `orderId`, `score`, and the order record from DynamoDB.
- `GET    /admin/stats`              dashboard metrics (orders by status,
  revenue, low-stock products, customer/admin counts)
- `GET    /admin/users`              list Cognito users (`?paginationToken=`,
  `?limit=` up to 60). Each entry includes `username`, `email`, `enabled`,
  `status`, `groups`, `createdAt`.
- `POST   /admin/users/{username}/group`   `{ "groupName": "admins"|"customers", "action": "add"|"remove" }`
- `POST   /admin/users/{username}/enabled` `{ "enabled": true | false }`
- `POST   /uploads/product-image`    presigned S3 PUT URL for `{filename, contentType}`

## Troubleshooting

| Issue | Check |
|-------|-------|
| `cdk deploy` fails | `npm install`, `npm run build`, then `npx cdk synth` |
| Sign-up email never arrives | Cognito sandbox limits sending to verified addresses; in production move out of sandbox |
| API returns `401` | Token expired (Amplify auto-refreshes; sign in again as a fallback) |
| API returns `403` on `/admin/*` | The user is not in the `admins` group |
| Order stays `PENDING` | Check Fraud Lambda logs and EventBridge rule `OnOrderCreated` |
| Browser CORS error | Redeploy CDK; verify the Amplify rewrite rule is set |
| Image upload fails | Bucket public-read configured in CDK; check Upload Lambda CloudWatch logs |
| React route 404 on refresh | Add the SPA rewrite rule in the Amplify Console (see step 4) |

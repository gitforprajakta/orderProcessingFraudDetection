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
- SNS topic for order-decision notifications
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
   ├── OrderCreated   ──►  FraudLambda  ──► Orders (status), EventBridge (decision)
   └── OrderBlocked   ──►  StockRestoreLambda ──► Products (stock++)
                       └►  NotificationLambda ──► SNS topic (email/SMS)

S3 (product images) ◄── public read for catalog images
```

## Demo accounts (auto-created on stack deploy)

| Role     | Email                  | Password             |
|----------|------------------------|----------------------|
| Customer | `testuser@example.com` | `YourSecurePassw0rd!`|
| Admin    | `admin@example.com`    | `AdminPassw0rd!`     |

You can also sign up new accounts from the React app — verification emails are
sent automatically by Cognito.

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
| `OrderNotificationsTopicArn` | Subscribe email for alerts     |

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

1. Sign in as `admin@example.com` (`AdminPassw0rd!`).
2. Click **Admin** in the navbar.
3. **Inventory** tab — add, edit, soft-delete products, upload images to S3
   directly from the form.
4. **Orders** tab — filter by status (default `REVIEW`), click **Approve** or
   **Block** to override fraud decisions. Block events automatically restore
   stock via `stock_restore_service`.

## 7. Optional: SNS email subscription

```bash
export TOPIC_ARN=<OrderNotificationsTopicArn>

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint your-email@example.com
```

Confirm the subscription email. Every fraud decision will be emailed.

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
- `PUT    /products/{sku}`           update product
- `DELETE /products/{sku}`           soft-delete product
- `GET    /admin/orders`             list all orders (`?status=` filter)
- `POST   /admin/orders/{id}/decision` `{decision: "APPROVE" | "BLOCK"}`
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

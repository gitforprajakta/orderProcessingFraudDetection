## Intelligent Event-Driven Order Processing (No Frontend)

This project deploys an **event-driven order flow** on AWS:

- **HTTPS** `POST /orders` (API Gateway) → **Cognito JWT** auth → **Order Lambda** → **DynamoDB** + **EventBridge** (`OrderCreated`)
- **EventBridge** → **Fraud Lambda** → score (local heuristic **or** SageMaker XGBoost) → `OrderApproved` / `OrderBlocked` / `OrderReview`
- **EventBridge** → **Notification Lambda** → **SNS**

Infrastructure is **AWS CDK (TypeScript)** in `infra/`. Lambda code is **Python** in `services/`.

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **AWS account** | Billing enabled if you use SageMaker |
| **AWS CLI** | `aws --version`; run `aws configure` (or env vars / SSO) |
| **Node.js 18+** | For CDK (`node --version`) |
| **Python 3.11+** | For ML preprocessing and SageMaker helper scripts (`python3 --version`) |
| **Region** | Pick one (e.g. `us-west-2`) and use it consistently |

**Python on macOS (Homebrew):** system Python is “externally managed” ([PEP 668](https://peps.python.org/pep-0668/)), so **do not** run `pip install` globally. Use a **virtual environment** (`.venv`) for all `pip` commands below.

Set your default region for CLI and CDK (replace with your region):

```bash
export AWS_REGION=us-west-2
export AWS_DEFAULT_REGION=us-west-2
```

---

## Step 1 — Clone and install CDK app

From the repository root:

```bash
npm install
```

Validate the app without deploying:

```bash
npx cdk synth
```

---

## Step 2 — Prepare ML artifacts (dataset → training CSV + inference JSON)

The dataset is at `ml/data/synthetic_fraud_dataset.csv`. This step builds `ml/artifacts/train.csv` and copies `inference_spec.json` into `services/fraud_service/artifacts/` (used by **Fraud Lambda** to match SageMaker features).

Create and use a venv once per machine (from the repo root):

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r ml/requirements-ml.txt
python ml/preprocess_and_train_artifacts.py --train-csv-no-header
deactivate                         # optional, when done
```

Re-run `pip install` / `python ml/preprocess...` inside the same venv whenever you change the CSV or preprocessing.

---

## Step 3 — Bootstrap CDK (once per AWS account + region)

CDK needs bootstrap resources in S3/SSM. Run **once** per account/region:

```bash
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}
```

If `AWS_ACCOUNT_ID` is not set:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}
```

---

## Step 4 — Deploy the stack

```bash
npx cdk deploy
```

Approve IAM changes when prompted. When it finishes, note the **Outputs**:

| Output | Purpose |
|--------|---------|
| `ApiUrl` | Base URL for `POST /orders` (ends with `prod`) |
| `CognitoUserPoolId` | User pool for test users |
| `CognitoUserPoolClientId` | App client for `USER_PASSWORD_AUTH` |
| `OrdersTableName` | DynamoDB orders table |
| `OrdersEventBusName` | Custom EventBridge bus |
| `MlArtifactsBucketName` | S3 bucket for training data / SageMaker artifacts |
| `SageMakerExecutionRoleArn` | Role for SageMaker training jobs |

**Default fraud scoring:** `FraudLambda` is deployed with `FRAUD_SCORER_MODE=local` (no SageMaker charges). You can test the full pipeline immediately after deploy.

---

## Step 5 — Test the API (Cognito + place order)

### 5a) Create a test user and get an `IdToken`

Replace placeholders with values from CDK outputs.

```bash
export REGION=$AWS_REGION
export USER_POOL_ID=<CognitoUserPoolId>
export USER_POOL_CLIENT_ID=<CognitoUserPoolClientId>
export USERNAME=testuser
export PASSWORD='YourSecurePassw0rd!'

aws cognito-idp admin-create-user \
  --region "$REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --user-attributes Name=email,Value=testuser@example.com \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --region "$REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username "$USERNAME" \
  --password "$PASSWORD" \
  --permanent

aws cognito-idp initiate-auth \
  --region "$REGION" \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$USER_POOL_CLIENT_ID" \
  --auth-parameters USERNAME="$USERNAME",PASSWORD="$PASSWORD"
```

From the JSON response, copy **`AuthenticationResult.IdToken`**:

```bash
export ID_TOKEN='<paste IdToken here>'
```

If the API returns **401 Unauthorized**, try the header as `Authorization: Bearer $ID_TOKEN` instead of only the raw token.

### 5b) Place an order

```bash
export API_URL=<ApiUrl from CDK output, no trailing slash>

curl -sS -X POST "$API_URL/orders" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [{"sku":"GADGET-1","qty":1,"unitPrice":199.99}],
    "currency":"USD",
    "shippingPostal":"95112",
    "shippingCountry":"US"
  }'
```

Expect **HTTP 202** and JSON like `{"orderId":"...","status":"PENDING"}`.

---

## Step 6 — Verify the pipeline

### DynamoDB

```bash
aws dynamodb scan --table-name <OrdersTableName> --limit 5
```

Confirm your `orderId` exists and `status` is `PENDING` (downstream Lambdas may update status only if you add that logic later).

### CloudWatch Logs

In the AWS Console: **CloudWatch → Log groups →** `/aws/lambda/OrderLambda`, `/aws/lambda/FraudLambda`, `/aws/lambda/NotificationLambda`.

Or CLI (replace log stream name after the first run):

```bash
aws logs tail /aws/lambda/FraudLambda --since 10m --follow
aws logs tail /aws/lambda/NotificationLambda --since 10m --follow
```

You should see fraud scoring and SNS publish in **Fraud** and **Notification** logs.

### SNS (optional)

Subscribe your email to the topic **OrderNotificationsTopic** in the SNS console to receive decision emails.

### EventBridge (optional)

**EventBridge → Event buses →** `OrdersBus` **→ Rules** to confirm `OrderCreated` and decision rules exist.

---

## Step 7 — Optional: SageMaker XGBoost endpoint (ML fraud score)

Use this when you want **`FraudLambda`** to call a **real-time SageMaker endpoint** trained on `ml/artifacts/train.csv`.

1. Ensure Step 2 completed so `ml/artifacts/train.csv` exists.

2. Activate the same venv and install the SageMaker Python SDK:

```bash
source .venv/bin/activate
pip install sagemaker
```

3. Train and deploy an endpoint (costs apply: training instance + endpoint instance):

```bash
python3 ml/run_xgboost_sagemaker.py \
  --role-arn "<SageMakerExecutionRoleArn>" \
  --bucket "<MlArtifactsBucketName>" \
  --region "$AWS_REGION" \
  --endpoint-name fraud-xgb-endpoint
```

4. Point **Fraud Lambda** at the endpoint. Easiest: **Lambda → FraudLambda → Configuration → Environment variables** and set:

   - `FRAUD_SCORER_MODE` = `sagemaker`
   - `SAGEMAKER_ENDPOINT_NAME` = `fraud-xgb-endpoint` (or the name you used)

   Leave `EVENT_BUS_NAME`, `APPROVE_THRESHOLD`, and `BLOCK_THRESHOLD` unchanged.

   If you use the AWS CLI, **fetch the current environment first** (CLI replaces the whole environment block):

```bash
aws lambda get-function-configuration --function-name <FraudLambdaName> --query Environment --output json
```

   Then merge your changes into that JSON and call `update-function-configuration` with the full `Variables` object.

5. Place another order (Step 5b) and tail **FraudLambda** logs to confirm SageMaker invocations (no errors).

---

## Step 8 — Tear down (avoid ongoing charges)

```bash
npx cdk destroy
```

Also delete the SageMaker **endpoint** and **endpoint configuration** in the SageMaker console if you created them (CDK destroy does not remove resources created by `run_xgboost_sagemaker.py`).

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| `error: externally-managed-environment` (pip on macOS) | Use a venv: `python3 -m venv .venv` then `source .venv/bin/activate` before `pip install` (see Step 2). Do not use `--break-system-packages`. |
| Preprocess prints XGBoost / `libomp` error on Mac | Optional offline XGBoost eval failed; **preprocessing still succeeds**. Install OpenMP with `brew install libomp` if you want local XGBoost metrics. |
| `cdk bootstrap` fails | Correct `AWS_ACCOUNT_ID` / `AWS_REGION`; IAM user can create S3/SSM |
| `cdk deploy` fails | Node deps: `npm install`; run `npx cdk synth` locally |
| API **403/401** | `IdToken` expired (tokens are short-lived); re-run `initiate-auth` |
| **No Fraud Lambda logs** | Event rule on custom bus `OrdersBus`; Order Lambda must use same bus name in `PutEvents` |
| **SageMaker access denied** | Fraud Lambda execution role needs `sagemaker:InvokeEndpoint` (already in stack); endpoint name must match env var |
| **`Float types are not supported. Use Decimal types instead`** (Order Lambda / DynamoDB) | Fixed in code: money fields use `decimal.Decimal`. Redeploy after `git pull` / update: `npx cdk deploy`. |

---

## Repository layout (short)

- `infra/` — CDK TypeScript (`infra/bin/app.ts`, `infra/lib/platform-stack.ts`)
- `services/` — Python Lambdas (`order_service`, `fraud_service`, `notification_service`)
- `ml/` — Dataset, preprocessing, SageMaker training helper

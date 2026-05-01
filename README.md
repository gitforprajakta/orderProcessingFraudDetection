# Intelligent Event-Driven Order Processing

This project deploys an AWS serverless order processing and fraud detection flow:

- Amplify-hosted static frontend submits orders with one click.
- API Gateway protects `POST /orders` with Cognito.
- Order Lambda writes the order to DynamoDB and emits `OrderCreated` to EventBridge.
- Fraud Lambda scores the order, updates DynamoDB with `fraudScore` and `fraudDecision`, and emits a decision event.
- Notification Lambda publishes the decision to SNS.

No SageMaker endpoint is required. XGBoost is trained locally and exported as JSON for Lambda-hosted inference.

## Architecture Note

The original design referenced SageMaker real-time inference. This implementation avoids SageMaker instance quota and cost issues:

- XGBoost can be trained locally from the CSV dataset.
- The trained model is exported to `services/fraud_service/artifacts/xgb_model.json`.
- Fraud Lambda evaluates the exported trees in pure Python.
- The final score uses the higher of the XGBoost probability and deterministic risk rules so demo examples are predictable.

## Prerequisites

- AWS CLI configured with credentials
- Node.js 18+
- Python 3.11+
- AWS region, for example `us-west-2`

```bash
export AWS_REGION=us-west-2
export AWS_DEFAULT_REGION=us-west-2
```

## Train XGBoost Locally

Run this when you want to regenerate Lambda model artifacts from the CSV:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements-ml.txt

python ml/train_xgboost_local.py \
  --csv "/Users/prajakta/Documents/MSSE Sem-1/CMPE-281/Project Stuff/Dataset/synthetic_fraud_dataset.csv"
```

This generates:

- `services/fraud_service/artifacts/xgb_model.json`
- `services/fraud_service/artifacts/inference_spec.json`
- `ml/artifacts/local_xgb/metrics.json`
- `ml/artifacts/local_xgb/xgb_model.joblib`

Lambda uses only the JSON files under `services/fraud_service/artifacts/`.

## Deploy Backend

Install dependencies and validate CDK:

```bash
npm install
npm run build
npx cdk synth
```

Bootstrap once per AWS account and region:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}
```

Deploy:

```bash
export DEMO_USER_PASSWORD='<choose-a-demo-password>'
npm run deploy
```

CDK creates the demo Cognito user automatically using the password from `DEMO_USER_PASSWORD`:

```text
Username: testuser
```

Useful outputs:

- `ApiUrl`
- `CognitoUserPoolClientId`
- `OrdersTableName`
- `OrderLambdaName`
- `FraudLambdaName`
- `NotificationLambdaName`
- `OrderNotificationsTopicArn`

Retrieve outputs later:

```bash
aws cloudformation describe-stacks \
  --stack-name OrderProcessingFraudDetectionStack \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
  --output table
```

## Deploy Frontend

For Amplify drag-and-drop deploy, upload a zip whose root contains `index.html`, `app.js`, and `styles.css`.

```bash
rm -f frontend-static.zip
cd frontend
zip -r ../frontend-static.zip index.html app.js styles.css config.js
```

Upload `frontend-static.zip` to Amplify.

For Git-based Amplify deploy, connect this repository and use `amplify.yml`. It publishes the `frontend/` folder from GitHub.

Important: `npm run deploy` regenerates `frontend/config.js` locally from the current CDK stack outputs. Commit and push the updated `frontend/config.js` after each backend redeploy so Amplify receives the latest API URL and Cognito client ID. This file contains public frontend settings only; do not put passwords or other secrets in it.

The demo password is not committed. Set it with `DEMO_USER_PASSWORD` before deployment and enter the same value in the frontend login form.

## Local Frontend

```bash
cd frontend
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080).

## One-Click Flow

In the UI, enter only order details:

- currency
- shipping country
- shipping postal code
- item SKU
- quantity
- unit price

Click **Submit Order and Run Fraud Check**.

The app automatically signs in to Cognito, calls Order Lambda, writes to DynamoDB, triggers EventBridge, and runs Fraud Lambda.

The API response returns:

```json
{"orderId":"...","status":"PENDING"}
```

`PENDING` is normal because fraud scoring runs asynchronously.

## Check DynamoDB Result

Use the `orderId` from the frontend response:

```bash
export ORDERS_TABLE_NAME=<OrdersTableName>
export ORDER_ID=<orderId returned by API>

aws dynamodb get-item \
  --table-name "$ORDERS_TABLE_NAME" \
  --key "{\"orderId\":{\"S\":\"$ORDER_ID\"}}"
```

Look for:

- `status`: `APPROVE`, `REVIEW`, or `BLOCK`
- `fraudScore`: final score from model plus rules
- `fraudDecision`: same final decision
- `fraudModelVersion`: `lambda-xgboost-json-v1+rules-v1`

## Decision Rules

Rule score starts at `0.05`.

- `+0.25` if order total is greater than `500`
- `+0.35` if order total is greater than `1500`
- `+0.20` if shipping country is not `US` or `CA`
- `+0.15` if total item quantity is `5` or more

Final decision:

- `score < 0.30` -> `APPROVE`
- `0.30 <= score < 0.70` -> `REVIEW`
- `score >= 0.70` -> `BLOCK`

`REVIEW` is currently a final flagged state. It updates DynamoDB and sends an `OrderReview` event, but there is no manual approval UI yet.

## Test Examples

Approve:

```json
{
  "items": [{ "sku": "BOOK-1", "qty": 1, "unitPrice": 49.99 }],
  "currency": "USD",
  "shippingPostal": "95112",
  "shippingCountry": "US"
}
```

Review:

```json
{
  "items": [{ "sku": "TABLET-1", "qty": 1, "unitPrice": 699.99 }],
  "currency": "USD",
  "shippingPostal": "95112",
  "shippingCountry": "US"
}
```

Block:

```json
{
  "items": [{ "sku": "LAPTOP-1", "qty": 6, "unitPrice": 399.99 }],
  "currency": "USD",
  "shippingPostal": "400001",
  "shippingCountry": "IN"
}
```

## Logs

```bash
export ORDER_LAMBDA_NAME=<OrderLambdaName>
export FRAUD_LAMBDA_NAME=<FraudLambdaName>
export NOTIFICATION_LAMBDA_NAME=<NotificationLambdaName>

aws logs tail "/aws/lambda/$ORDER_LAMBDA_NAME" --since 10m
aws logs tail "/aws/lambda/$FRAUD_LAMBDA_NAME" --since 10m
aws logs tail "/aws/lambda/$NOTIFICATION_LAMBDA_NAME" --since 10m
```

## Optional SNS Email

```bash
export TOPIC_ARN=<OrderNotificationsTopicArn>

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint your-email@example.com
```

Confirm the subscription email. New orders should send fraud decision emails.

## Cleanup

Destroy AWS resources:

```bash
npx cdk destroy
```

Generated local files that should not be committed:

- `.venv/`
- `cdk.out/`
- `node_modules/`
- `frontend-static.zip`
- `ml/artifacts/local_xgb/`

## Troubleshooting

| Issue | What to check |
|-------|---------------|
| `cdk deploy` fails | Run `npm install`, `npm run build`, then `npx cdk synth` |
| API returns `401` | Demo Cognito user may not exist yet; set `DEMO_USER_PASSWORD` and run `npm run deploy` |
| API returns `403` | Verify `frontend/config.js` has the latest `CognitoUserPoolClientId` |
| DynamoDB stays `PENDING` | Check Fraud Lambda logs and EventBridge rule `OnOrderCreated` |
| Browser CORS error | Redeploy backend and refresh the Amplify/local frontend |

## Repository Layout

- `infra/` - CDK TypeScript stack
- `services/order_service/` - API order Lambda
- `services/fraud_service/` - Lambda-hosted fraud scoring
- `services/notification_service/` - SNS notification Lambda
- `ml/` - local XGBoost training utilities
- `frontend/` - static browser UI
# Intelligent Event-Driven Order Processing

This project deploys an AWS serverless order flow with XGBoost inference inside Lambda:

- Amplify-hosted frontend submits orders to API Gateway.
- API Gateway uses Cognito auth.
- Order Lambda writes the order to DynamoDB and emits `OrderCreated` to EventBridge.
- Fraud Lambda loads a trained XGBoost model JSON, calculates `fraudScore`, updates DynamoDB with `fraudDecision`, and emits a decision event.
- Notification Lambda publishes the decision to SNS.

No SageMaker endpoint is required.

## Architecture Note

Your original diagram shows SageMaker training and real-time endpoint inference. Because the AWS account cannot use SageMaker instances, this project now replaces the SageMaker endpoint with **Lambda-hosted XGBoost inference**:

- XGBoost is trained locally from your CSV.
- The trained model is exported to `services/fraud_service/artifacts/xgb_model.json`.
- Fraud Lambda uses pure Python to evaluate the exported XGBoost trees.
- Lambda does not need the native `xgboost` package, Docker, or SageMaker.

## Prerequisites

- AWS CLI configured with credentials
- Node.js 18+
- Python 3.11+
- AWS region, for example `us-west-2`

```bash
export AWS_REGION=us-west-2
export AWS_DEFAULT_REGION=us-west-2
```

## 1. Train XGBoost Locally for Lambda

Run this before `cdk deploy`, because Fraud Lambda packages the generated model artifacts.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements-ml.txt

python ml/train_xgboost_local.py \
  --csv "/Users/prajakta/Documents/MSSE Sem-1/CMPE-281/Project Stuff/Dataset/synthetic_fraud_dataset.csv"
```

This generates:

- `services/fraud_service/artifacts/xgb_model.json`
- `services/fraud_service/artifacts/inference_spec.json`
- `ml/artifacts/local_xgb/metrics.json`
- `ml/artifacts/local_xgb/xgb_model.joblib`

The `.joblib` file is for local testing only. Lambda uses the JSON files under `services/fraud_service/artifacts/`.

## 2. Validate CDK

```bash
npm install
npm run build
npx cdk synth
```

## 3. Bootstrap AWS

Run once per account and region:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}
```

## 4. Deploy Backend

```bash
npx cdk deploy
```

Copy these CDK outputs:

- `ApiUrl`
- `CognitoUserPoolId`
- `CognitoUserPoolClientId`
- `OrdersTableName`
- `OrderLambdaName`
- `FraudLambdaName`
- `NotificationLambdaName`
- `OrderNotificationsTopicArn`

Retrieve outputs later:

```bash
aws cloudformation describe-stacks \
  --stack-name OrderProcessingFraudDetectionStack \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
  --output table
```

## 5. Create Cognito Test User

```bash
export REGION=$AWS_REGION
export USER_POOL_ID=<CognitoUserPoolId>
export USER_POOL_CLIENT_ID=<CognitoUserPoolClientId>
export USERNAME=testuser
export PASSWORD='<choose-a-demo-password>'

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
```

If the user already exists, run only `admin-set-user-password`.

## 6. Test From Frontend Locally

```bash
cd frontend
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080).

Enter:

- Username: `testuser`
- Password: the value you deployed with `DEMO_USER_PASSWORD`

Click **Submit Order and Run Fraud Check**.

If browser Cognito login fails, get the token from CLI and paste it into the `Cognito IdToken` box:

```bash
aws cognito-idp initiate-auth \
  --region "$REGION" \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$USER_POOL_CLIENT_ID" \
  --auth-parameters USERNAME="$USERNAME",PASSWORD="$PASSWORD" \
  --query "AuthenticationResult.IdToken" \
  --output text
```

## 7. Deploy Frontend to Amplify

Option A, easiest manual deploy:

1. Open AWS Console → **Amplify**.
2. Choose **Deploy without Git provider**.
3. App name: `order-processing-fraud-frontend`.
4. Drag and drop the `frontend/` folder, or zip the contents of `frontend/` and upload it.
5. Open the Amplify URL.
6. Enter the demo username and the password you deployed with `DEMO_USER_PASSWORD`.
7. Click **Submit Order and Run Fraud Check**.

Option B, Git-based deploy:

1. Push this repository to GitHub.
2. In Amplify, choose **Host web app** → GitHub.
3. Select the repo and branch.
4. Amplify will use `amplify.yml`, which publishes the `frontend/` folder.
5. Deploy and open the Amplify URL.

API Gateway CORS allows the Amplify frontend origin.

## 8. Check DynamoDB Result

The API response returns:

```json
{"orderId":"...","status":"PENDING"}
```

`PENDING` is normal because fraud scoring happens asynchronously. Use that `orderId`:

```bash
export ORDERS_TABLE_NAME=<OrdersTableName>
export ORDER_ID=<orderId returned by API>

aws dynamodb get-item \
  --table-name "$ORDERS_TABLE_NAME" \
  --key "{\"orderId\":{\"S\":\"$ORDER_ID\"}}"
```

Look for:

- `status`: `APPROVE`, `REVIEW`, or `BLOCK`
- `fraudScore`: final Fraud Lambda score, using the higher of model probability and deterministic risk rules
- `fraudDecision`: same final decision
- `fraudModelVersion`: `lambda-xgboost-json-v1+rules-v1`

If `status` is still `PENDING`, wait a few seconds and run the command again.

## 9. Check CloudWatch Logs

Log groups:

- `/aws/lambda/OrderProcessingFraudDetection-OrderLambda`
- `/aws/lambda/OrderProcessingFraudDetection-FraudLambda`
- `/aws/lambda/OrderProcessingFraudDetection-NotificationLambda`

CLI:

```bash
export ORDER_LAMBDA_NAME=<OrderLambdaName>
export FRAUD_LAMBDA_NAME=<FraudLambdaName>
export NOTIFICATION_LAMBDA_NAME=<NotificationLambdaName>

aws logs tail "/aws/lambda/$ORDER_LAMBDA_NAME" --since 10m
aws logs tail "/aws/lambda/$FRAUD_LAMBDA_NAME" --since 10m
aws logs tail "/aws/lambda/$NOTIFICATION_LAMBDA_NAME" --since 10m
```

Expected evidence:

- Order Lambda ran after `POST /orders`.
- Fraud Lambda returned `emitted`, `orderId`, and `score`.
- Notification Lambda returned `published: true`.

If you see `XGBoost Lambda inference failed`, regenerate artifacts with Step 1 and redeploy.

## 10. Optional SNS Email Test

```bash
export TOPIC_ARN=<OrderNotificationsTopicArn>

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint your-email@example.com
```

Confirm the subscription email. New orders should send decision emails.

## Test Order Examples

Low-risk example:

```json
{
  "items": [{"sku": "BOOK-1", "qty": 1, "unitPrice": 49.99}],
  "currency": "USD",
  "shippingPostal": "95112",
  "shippingCountry": "US"
}
```

High-risk example:

```json
{
  "items": [{"sku": "LAPTOP-1", "qty": 6, "unitPrice": 399.99}],
  "currency": "USD",
  "shippingPostal": "400001",
  "shippingCountry": "IN"
}
```

## Cleanup

```bash
npx cdk destroy
```

Generated local files that should not be committed:

- `.venv/`
- `cdk.out/`
- `node_modules/`
- `ml/artifacts/local_xgb/`

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| `cdk deploy` fails | Run Step 1 first so Fraud Lambda has model artifacts, then run `npm run build` and `npx cdk synth` |
| API returns `401` | Token expired or wrong auth header; get a fresh `IdToken` |
| API returns `403` | Verify `CognitoUserPoolClientId` and user pool outputs |
| DynamoDB stays `PENDING` | Check Fraud Lambda logs and EventBridge rule `OnOrderCreated` |
| Browser Cognito login fails | Use CLI `initiate-auth` and paste the token manually |
| Browser CORS error | Redeploy backend and refresh the Amplify/local frontend |

## Repository Layout

- `infra/` - CDK TypeScript stack
- `services/order_service/` - API order Lambda
- `services/fraud_service/` - Lambda-hosted XGBoost fraud scoring
- `services/notification_service/` - SNS notification Lambda
- `ml/` - local CSV/XGBoost training utilities
- `frontend/` - static UI for local or Amplify hosting
# Intelligent Event-Driven Order Processing

This project deploys a no-SageMaker AWS order processing flow:

- API Gateway `POST /orders` with Cognito auth
- Order Lambda writes the order to DynamoDB and emits `OrderCreated` to EventBridge
- Fraud Lambda scores the order, updates DynamoDB with `fraudScore` and `fraudDecision`, and emits a decision event
- Notification Lambda publishes the decision to SNS

Important: local XGBoost training with your CSV is still available for experimentation and metrics, but the AWS Fraud Lambda now uses a lightweight deterministic rules scorer. This avoids SageMaker instance quota and cost issues.

## Why You Saw Extra Lambdas

CDK can create helper Lambdas for custom resources. The previous stack had a SageMaker artifacts S3 bucket with `autoDeleteObjects`, which creates an extra custom-resource Lambda. SageMaker resources have now been removed, so the application stack should only have these three app Lambdas:

- `OrderProcessingFraudDetection-OrderLambda`
- `OrderProcessingFraudDetection-FraudLambda`
- `OrderProcessingFraudDetection-NotificationLambda`

## Prerequisites

- AWS CLI configured with credentials
- Node.js 18+
- Python 3.11+
- AWS region, for example `us-west-2`

```bash
export AWS_REGION=us-west-2
export AWS_DEFAULT_REGION=us-west-2
```

## 1. Local CSV Training

Use this to train/test XGBoost locally with your CSV. This does not deploy the model to AWS.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements-ml.txt

python ml/train_xgboost_local.py \
  --csv "/Users/prajakta/Documents/MSSE Sem-1/CMPE-281/Project Stuff/Dataset/synthetic_fraud_dataset.csv"

python ml/predict_xgboost_local.py \
  --csv "/Users/prajakta/Documents/MSSE Sem-1/CMPE-281/Project Stuff/Dataset/synthetic_fraud_dataset.csv" \
  --row-index 25
```

Generated local artifacts:

- `ml/artifacts/local_xgb/xgb_model.joblib`
- `ml/artifacts/local_xgb/sklearn_preprocessor.joblib`
- `ml/artifacts/local_xgb/metrics.json`

## 2. Install and Validate CDK

From the repository root:

```bash
npm install
npm run build
npx cdk synth
```

If `cdk synth` succeeds, the CloudFormation template is valid.

## 3. Bootstrap AWS Account

Run this once per AWS account and region:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}
```

## 4. Deploy

```bash
npx cdk deploy
```

Copy the CDK outputs:

- `ApiUrl`
- `CognitoUserPoolId`
- `CognitoUserPoolClientId`
- `OrdersTableName`
- `OrderLambdaName`
- `FraudLambdaName`
- `NotificationLambdaName`
- `OrderNotificationsTopicArn`

You can retrieve outputs again:

```bash
aws cloudformation describe-stacks \
  --stack-name OrderProcessingFraudDetectionStack \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
  --output table
```

## 5. Create Cognito Test User

Replace the output placeholders:

```bash
export REGION=$AWS_REGION
export USER_POOL_ID=<CognitoUserPoolId>
export USER_POOL_CLIENT_ID=<CognitoUserPoolClientId>
export USERNAME=testuser
export PASSWORD='<choose-a-demo-password>'

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
```

If the user already exists, skip `admin-create-user` and run only `admin-set-user-password`.

## 6. Get IdToken

```bash
aws cognito-idp initiate-auth \
  --region "$REGION" \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$USER_POOL_CLIENT_ID" \
  --auth-parameters USERNAME="$USERNAME",PASSWORD="$PASSWORD" \
  --query "AuthenticationResult.IdToken" \
  --output text
```

Copy the printed token:

```bash
export ID_TOKEN='<paste token here>'
```

## 7. Call `POST /orders`

```bash
export API_URL=<ApiUrl>
```

Approve-like request:

```bash
curl -sS -X POST "$API_URL/orders" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"sku":"BOOK-1","qty":1,"unitPrice":49.99}],"currency":"USD","shippingPostal":"95112","shippingCountry":"US"}'
```

Review-like request:

```bash
curl -sS -X POST "$API_URL/orders" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"sku":"TABLET-1","qty":1,"unitPrice":699.99}],"currency":"USD","shippingPostal":"95112","shippingCountry":"US"}'
```

Block-like request:

```bash
curl -sS -X POST "$API_URL/orders" \
  -H "Authorization: $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"sku":"LAPTOP-1","qty":6,"unitPrice":399.99}],"currency":"USD","shippingPostal":"400001","shippingCountry":"IN"}'
```

Expected API response:

```json
{"orderId":"...","status":"PENDING"}
```

`PENDING` is normal. Fraud scoring runs asynchronously through EventBridge.

## 8. Check DynamoDB Result

Use the `orderId` from the API response:

```bash
export ORDERS_TABLE_NAME=<OrdersTableName>
export ORDER_ID=<orderId returned by API>

aws dynamodb get-item \
  --table-name "$ORDERS_TABLE_NAME" \
  --key "{\"orderId\":{\"S\":\"$ORDER_ID\"}}"
```

Look for:

- `status`: final value is `APPROVE`, `REVIEW`, or `BLOCK`
- `fraudScore`: final Fraud Lambda score, using the higher of model probability and deterministic risk rules
- `fraudDecision`: same final decision
- `fraudModelVersion`: `lambda-xgboost-json-v1+rules-v1`

If `status` is still `PENDING`, wait a few seconds and run the `get-item` command again.

## 9. Check CloudWatch Logs

CloudWatch log groups are explicitly created by CDK with one-week retention:

- `/aws/lambda/OrderProcessingFraudDetection-OrderLambda`
- `/aws/lambda/OrderProcessingFraudDetection-FraudLambda`
- `/aws/lambda/OrderProcessingFraudDetection-NotificationLambda`

CLI:

```bash
export ORDER_LAMBDA_NAME=<OrderLambdaName>
export FRAUD_LAMBDA_NAME=<FraudLambdaName>
export NOTIFICATION_LAMBDA_NAME=<NotificationLambdaName>

aws logs tail "/aws/lambda/$ORDER_LAMBDA_NAME" --since 10m
aws logs tail "/aws/lambda/$FRAUD_LAMBDA_NAME" --since 10m
aws logs tail "/aws/lambda/$NOTIFICATION_LAMBDA_NAME" --since 10m
```

Expected evidence:

- Order Lambda was invoked by API Gateway
- Fraud Lambda returned `emitted`, `orderId`, and `score`
- Notification Lambda returned `published: true`

## 10. Optional SNS Email Test

Subscribe your email:

```bash
export TOPIC_ARN=<OrderNotificationsTopicArn>

aws sns subscribe \
  --topic-arn "$TOPIC_ARN" \
  --protocol email \
  --notification-endpoint your-email@example.com
```

Confirm the subscription from your email inbox. New orders should send fraud decision emails.

## 11. Local Frontend

```bash
cd frontend
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080).

Use:

- API Base URL: `ApiUrl`
- Cognito IdToken: token from Step 6
- Keep Bearer token unchecked first. If API returns `401`, try checking it.

## Decision Rules

Fraud Lambda uses:

- `score < 0.30` -> `APPROVE`
- `0.30 <= score < 0.70` -> `REVIEW`
- `score >= 0.70` -> `BLOCK`

The score increases when:

- order total is greater than `500`
- order total is greater than `1500`
- shipping country is not `US` or `CA`
- total item quantity is `5` or more

## Cleanup

```bash
npx cdk destroy
```

Generated local files that should not be committed:

- `.venv/`
- `cdk.out/`
- `node_modules/`
- `ml/artifacts/local_xgb/`

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| `cdk deploy` fails | Run `npm install`, `npm run build`, then `npx cdk synth` |
| API returns `401` | Token expired or wrong auth header; get a fresh `IdToken` |
| API returns `403` | Cognito authorizer/token mismatch; verify user pool and client output values |
| DynamoDB stays `PENDING` | Check Fraud Lambda logs and EventBridge rule `OnOrderCreated` |
| No Notification logs | Check EventBridge rule `OnFraudDecision` and SNS permissions |
| Browser CORS error | Redeploy latest CDK changes, then refresh the frontend |

## Repository Layout

- `infra/` - CDK TypeScript stack
- `services/order_service/` - API order Lambda
- `services/fraud_service/` - fraud scoring Lambda
- `services/notification_service/` - SNS notification Lambda
- `ml/` - local CSV/XGBoost training utilities
- `frontend/` - simple browser UI for submitting orders

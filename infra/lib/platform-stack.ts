import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";

export class PlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // DynamoDB tables
    // -----------------------------------------------------------------------

    // Orders: PK=orderId, GSI on userId for "my orders" queries.
    const ordersTable = new dynamodb.Table(this, "OrdersTable", {
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    ordersTable.addGlobalSecondaryIndex({
      indexName: "userId-createdAt-index",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.NUMBER },
    });

    // Products catalog: PK=sku, GSI on category for filtered listings.
    const productsTable = new dynamodb.Table(this, "ProductsTable", {
      partitionKey: { name: "sku", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    productsTable.addGlobalSecondaryIndex({
      indexName: "category-index",
      partitionKey: { name: "category", type: dynamodb.AttributeType.STRING },
    });

    // Carts: one item per user; userId is the Cognito sub.
    const cartsTable = new dynamodb.Table(this, "CartsTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------------
    // EventBridge bus + SNS topic
    // -----------------------------------------------------------------------
    const bus = new events.EventBus(this, "OrdersBus", {
      eventBusName: "OrdersBus",
    });

    const topic = new sns.Topic(this, "OrderNotificationsTopic", {
      topicName: "OrderNotificationsTopic",
    });

    // -----------------------------------------------------------------------
    // S3 bucket for product images
    // Public-read so the React frontend can display images by direct URL.
    // -----------------------------------------------------------------------
    const productImagesBucket = new s3.Bucket(this, "ProductImagesBucket", {
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      publicReadAccess: true,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
        },
      ],
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------------
    // Lambdas
    // -----------------------------------------------------------------------
    const orderLambdaName = "OrderProcessingFraudDetection-OrderLambda";
    const fraudLambdaName = "OrderProcessingFraudDetection-FraudLambda";
    const notificationLambdaName =
      "OrderProcessingFraudDetection-NotificationLambda";
    const productsLambdaName =
      "OrderProcessingFraudDetection-ProductsLambda";
    const cartLambdaName = "OrderProcessingFraudDetection-CartLambda";
    const myOrdersLambdaName =
      "OrderProcessingFraudDetection-MyOrdersLambda";
    const adminLambdaName = "OrderProcessingFraudDetection-AdminLambda";
    const uploadLambdaName = "OrderProcessingFraudDetection-UploadLambda";
    const stockRestoreLambdaName =
      "OrderProcessingFraudDetection-StockRestoreLambda";

    const commonRuntime = lambda.Runtime.PYTHON_3_11;

    const orderLambda = new lambda.Function(this, "OrderLambda", {
      functionName: orderLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/order_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(15),
      environment: {
        ORDERS_TABLE_NAME: ordersTable.tableName,
        PRODUCTS_TABLE_NAME: productsTable.tableName,
        CARTS_TABLE_NAME: cartsTable.tableName,
        EVENT_BUS_NAME: bus.eventBusName,
      },
    });

    const fraudLambda = new lambda.Function(this, "FraudLambda", {
      functionName: fraudLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/fraud_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: {
        EVENT_BUS_NAME: bus.eventBusName,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        MODEL_ARTIFACT_DIR: "artifacts",
        APPROVE_THRESHOLD: "0.30",
        BLOCK_THRESHOLD: "0.70",
      },
    });

    const notificationLambda = new lambda.Function(this, "NotificationLambda", {
      functionName: notificationLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/notification_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: { SNS_TOPIC_ARN: topic.topicArn },
    });

    const productsLambda = new lambda.Function(this, "ProductsLambda", {
      functionName: productsLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/products_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        PRODUCTS_TABLE_NAME: productsTable.tableName,
        IMAGES_BUCKET_NAME: productImagesBucket.bucketName,
        ADMIN_GROUP: "admins",
      },
    });

    const cartLambda = new lambda.Function(this, "CartLambda", {
      functionName: cartLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/cart_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        CARTS_TABLE_NAME: cartsTable.tableName,
        PRODUCTS_TABLE_NAME: productsTable.tableName,
      },
    });

    const myOrdersLambda = new lambda.Function(this, "MyOrdersLambda", {
      functionName: myOrdersLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/my_orders_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORDERS_TABLE_NAME: ordersTable.tableName,
        ORDERS_USER_INDEX: "userId-createdAt-index",
      },
    });

    const adminLambda = new lambda.Function(this, "AdminLambda", {
      functionName: adminLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/admin_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(15),
      environment: {
        ORDERS_TABLE_NAME: ordersTable.tableName,
        PRODUCTS_TABLE_NAME: productsTable.tableName,
        EVENT_BUS_NAME: bus.eventBusName,
        ADMIN_GROUP: "admins",
      },
    });

    const uploadLambda = new lambda.Function(this, "UploadLambda", {
      functionName: uploadLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/upload_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        IMAGES_BUCKET_NAME: productImagesBucket.bucketName,
        ADMIN_GROUP: "admins",
      },
    });

    const stockRestoreLambda = new lambda.Function(this, "StockRestoreLambda", {
      functionName: stockRestoreLambdaName,
      runtime: commonRuntime,
      code: lambda.Code.fromAsset("services/stock_restore_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(15),
      environment: {
        ORDERS_TABLE_NAME: ordersTable.tableName,
        PRODUCTS_TABLE_NAME: productsTable.tableName,
      },
    });

    // CloudWatch log groups (1-week retention).
    [
      orderLambdaName,
      fraudLambdaName,
      notificationLambdaName,
      productsLambdaName,
      cartLambdaName,
      myOrdersLambdaName,
      adminLambdaName,
      uploadLambdaName,
      stockRestoreLambdaName,
    ].forEach((functionName) => {
      new logs.LogGroup(this, `${functionName}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    });

    // -----------------------------------------------------------------------
    // IAM permissions
    // -----------------------------------------------------------------------
    ordersTable.grantReadWriteData(orderLambda);
    productsTable.grantReadWriteData(orderLambda);
    cartsTable.grantReadWriteData(orderLambda);
    bus.grantPutEventsTo(orderLambda);

    ordersTable.grantWriteData(fraudLambda);
    bus.grantPutEventsTo(fraudLambda);

    topic.grantPublish(notificationLambda);

    productsTable.grantReadWriteData(productsLambda);

    cartsTable.grantReadWriteData(cartLambda);
    productsTable.grantReadData(cartLambda);

    ordersTable.grantReadData(myOrdersLambda);

    ordersTable.grantReadWriteData(adminLambda);
    productsTable.grantReadWriteData(adminLambda);
    bus.grantPutEventsTo(adminLambda);

    productImagesBucket.grantPut(uploadLambda);

    ordersTable.grantReadData(stockRestoreLambda);
    productsTable.grantReadWriteData(stockRestoreLambda);

    // -----------------------------------------------------------------------
    // EventBridge rules
    // -----------------------------------------------------------------------
    new events.Rule(this, "OnOrderCreated", {
      eventBus: bus,
      eventPattern: {
        source: ["order.service"],
        detailType: ["OrderCreated"],
      },
      targets: [new targets.LambdaFunction(fraudLambda)],
    });

    new events.Rule(this, "OnFraudDecision", {
      eventBus: bus,
      eventPattern: {
        source: ["fraud.service", "admin.service"],
        detailType: ["OrderApproved", "OrderBlocked", "OrderReview"],
      },
      targets: [new targets.LambdaFunction(notificationLambda)],
    });

    // Refund stock when an order is blocked (by Fraud Lambda or Admin).
    new events.Rule(this, "OnOrderBlockedRestoreStock", {
      eventBus: bus,
      eventPattern: {
        source: ["fraud.service", "admin.service"],
        detailType: ["OrderBlocked"],
      },
      targets: [new targets.LambdaFunction(stockRestoreLambda)],
    });

    // -----------------------------------------------------------------------
    // Cognito with self-signup, email verification, and groups
    // -----------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      userVerification: {
        emailSubject: "Verify your account",
        emailBody:
          "Welcome! Your verification code is {####}",
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient("UserPoolClient", {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    new cognito.CfnUserPoolGroup(this, "AdminsGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "admins",
      description: "Administrators with inventory and review-order privileges",
      precedence: 1,
    });

    new cognito.CfnUserPoolGroup(this, "CustomersGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "customers",
      description: "Regular shoppers (default group)",
      precedence: 10,
    });

    // -----------------------------------------------------------------------
    // Custom resource Lambda: create demo customer + demo admin users
    // -----------------------------------------------------------------------
    const demoUsersHandler = new lambda.Function(this, "DemoUsersHandler", {
      runtime: commonRuntime,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromInline(`
import boto3

cognito = boto3.client("cognito-idp")


def _ensure_user(user_pool_id, username, email, password, group):
    try:
        cognito.admin_get_user(UserPoolId=user_pool_id, Username=username)
    except cognito.exceptions.UserNotFoundException:
        cognito.admin_create_user(
            UserPoolId=user_pool_id,
            Username=username,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
            MessageAction="SUPPRESS",
        )
    cognito.admin_set_user_password(
        UserPoolId=user_pool_id,
        Username=username,
        Password=password,
        Permanent=True,
    )
    if group:
        cognito.admin_add_user_to_group(
            UserPoolId=user_pool_id,
            Username=username,
            GroupName=group,
        )


def handler(event, context):
    props = event["ResourceProperties"]
    user_pool_id = props["UserPoolId"]
    physical_id = f"demo-users-{user_pool_id}"

    if event["RequestType"] == "Delete":
        return {"PhysicalResourceId": physical_id}

    for u in props.get("Users", []):
        _ensure_user(
            user_pool_id,
            u["Username"],
            u["Email"],
            u["Password"],
            u.get("Group", ""),
        )

    return {"PhysicalResourceId": physical_id}
`),
    });
    demoUsersHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminAddUserToGroup",
        ],
        resources: [userPool.userPoolArn],
      })
    );

    const demoUsersProvider = new cr.Provider(this, "DemoUsersProvider", {
      onEventHandler: demoUsersHandler,
    });

    new cdk.CustomResource(this, "DemoUsers", {
      serviceToken: demoUsersProvider.serviceToken,
      properties: {
        UserPoolId: userPool.userPoolId,
        Users: [
          {
            Username: "testuser@example.com",
            Email: "testuser@example.com",
            Password: "YourSecurePassw0rd!",
            Group: "customers",
          },
          {
            Username: "admin@example.com",
            Email: "admin@example.com",
            Password: "AdminPassw0rd!",
            Group: "admins",
          },
        ],
      },
    });

    // -----------------------------------------------------------------------
    // Custom resource Lambda: seed sample products into DynamoDB
    // -----------------------------------------------------------------------
    const seedProductsHandler = new lambda.Function(this, "SeedProductsHandler", {
      runtime: commonRuntime,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromInline(`
import json
import os
import time
from decimal import Decimal

import boto3

ddb = boto3.resource("dynamodb")


def handler(event, context):
    props = event["ResourceProperties"]
    table_name = props["TableName"]
    products_json = props["ProductsJson"]
    physical_id = f"seed-products-{table_name}"

    if event["RequestType"] == "Delete":
        return {"PhysicalResourceId": physical_id}

    table = ddb.Table(table_name)
    products = json.loads(products_json)
    now = int(time.time() * 1000)
    for p in products:
        item = {
            "sku": p["sku"],
            "name": p["name"],
            "description": p["description"],
            "category": p["category"],
            "price": Decimal(str(p["price"])),
            "currency": p.get("currency", "USD"),
            "stock": int(p["stock"]),
            "imageUrl": p["imageUrl"],
            "active": True,
            "createdAt": now,
            "updatedAt": now,
        }
        table.put_item(Item=item)

    return {"PhysicalResourceId": physical_id}
`),
    });
    productsTable.grantWriteData(seedProductsHandler);

    const seedProductsProvider = new cr.Provider(this, "SeedProductsProvider", {
      onEventHandler: seedProductsHandler,
    });

    const sampleProducts = [
      {
        sku: "BOOK-1",
        name: "The Cloud Pioneers",
        description:
          "A best-selling paperback covering the rise of modern cloud computing.",
        category: "books",
        price: 19.99,
        stock: 100,
        imageUrl:
          "https://images.unsplash.com/photo-1512820790803-83ca734da794?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "HEADPHONES-1",
        name: "AeroSound Wireless Headphones",
        description: "Comfortable over-ear headphones with 30-hour battery life.",
        category: "electronics",
        price: 89.99,
        stock: 50,
        imageUrl:
          "https://images.unsplash.com/photo-1518443895914-c5dc4f2ab57f?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "MOUSE-1",
        name: "Glide Pro Wireless Mouse",
        description: "Ergonomic mouse with silent clicks and USB-C charging.",
        category: "electronics",
        price: 39.99,
        stock: 80,
        imageUrl:
          "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "KEYBOARD-1",
        name: "Mechanical Keyboard K87",
        description: "Tenkeyless mechanical keyboard with RGB and hot-swappable switches.",
        category: "electronics",
        price: 119.99,
        stock: 40,
        imageUrl:
          "https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "WATCH-1",
        name: "Pulse Smartwatch",
        description: "Health and fitness tracker with GPS, heart rate, and sleep monitoring.",
        category: "wearables",
        price: 199.99,
        stock: 25,
        imageUrl:
          "https://images.unsplash.com/photo-1546868871-7041f2a55e12?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "TABLET-1",
        name: "FlexPad 10 Tablet",
        description: "10-inch HD tablet, perfect for reading, video, and notes.",
        category: "electronics",
        price: 299.99,
        stock: 20,
        imageUrl:
          "https://images.unsplash.com/photo-1561154464-82e9adf32764?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "PHONE-1",
        name: "Nimbus 5G Smartphone",
        description:
          "Flagship smartphone with triple-lens camera and 256GB storage.",
        category: "electronics",
        price: 699.99,
        stock: 30,
        imageUrl:
          "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "MONITOR-1",
        name: "UltraView 27-inch 4K Monitor",
        description: "27-inch IPS monitor with 4K resolution and USB-C input.",
        category: "electronics",
        price: 449.99,
        stock: 15,
        imageUrl:
          "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "CAMERA-1",
        name: "Voyager Mirrorless Camera",
        description:
          "24MP mirrorless camera with interchangeable lens and 4K video.",
        category: "electronics",
        price: 899.99,
        stock: 12,
        imageUrl:
          "https://images.unsplash.com/photo-1519183071298-a2962be96e63?auto=format&fit=crop&w=800&q=70",
      },
      {
        sku: "LAPTOP-1",
        name: "Stratus 14 Laptop",
        description:
          "Slim 14-inch laptop with 16GB RAM, 512GB SSD, and all-day battery.",
        category: "electronics",
        price: 1199.99,
        stock: 10,
        imageUrl:
          "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=800&q=70",
      },
    ];

    new cdk.CustomResource(this, "SeedProducts", {
      serviceToken: seedProductsProvider.serviceToken,
      properties: {
        TableName: productsTable.tableName,
        ProductsJson: JSON.stringify(sampleProducts),
      },
    });

    // -----------------------------------------------------------------------
    // API Gateway with Cognito authorizer
    // -----------------------------------------------------------------------
    const api = new apigw.RestApi(this, "OrdersApi", {
      restApiName: "OrdersApi",
      deployOptions: { tracingEnabled: false },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      { cognitoUserPools: [userPool] }
    );

    const authMethodOpts: apigw.MethodOptions = {
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizer,
    };

    // ----- /products (public read, admin write)
    const products = api.root.addResource("products");
    const productsIntegration = new apigw.LambdaIntegration(productsLambda);
    products.addMethod("GET", productsIntegration); // public list
    products.addMethod("POST", productsIntegration, authMethodOpts); // admin create

    const productBySku = products.addResource("{sku}");
    productBySku.addMethod("GET", productsIntegration); // public read
    productBySku.addMethod("PUT", productsIntegration, authMethodOpts); // admin update
    productBySku.addMethod("DELETE", productsIntegration, authMethodOpts); // admin delete

    // ----- /orders (POST = place order, customer-auth)
    const orders = api.root.addResource("orders");
    orders.addMethod(
      "POST",
      new apigw.LambdaIntegration(orderLambda),
      authMethodOpts
    );

    // ----- /me/orders (list my orders) and /me/orders/{id}
    const me = api.root.addResource("me");
    const meOrders = me.addResource("orders");
    const myOrdersIntegration = new apigw.LambdaIntegration(myOrdersLambda);
    meOrders.addMethod("GET", myOrdersIntegration, authMethodOpts);
    meOrders
      .addResource("{orderId}")
      .addMethod("GET", myOrdersIntegration, authMethodOpts);

    // ----- /cart (customer-auth)
    const cart = api.root.addResource("cart");
    const cartIntegration = new apigw.LambdaIntegration(cartLambda);
    cart.addMethod("GET", cartIntegration, authMethodOpts);
    cart.addMethod("DELETE", cartIntegration, authMethodOpts); // clear cart
    const cartItems = cart.addResource("items");
    cartItems.addMethod("POST", cartIntegration, authMethodOpts); // add item
    const cartItemBySku = cartItems.addResource("{sku}");
    cartItemBySku.addMethod("PUT", cartIntegration, authMethodOpts);
    cartItemBySku.addMethod("DELETE", cartIntegration, authMethodOpts);

    // ----- /admin (admin-only, enforced by Lambda)
    const admin = api.root.addResource("admin");
    const adminIntegration = new apigw.LambdaIntegration(adminLambda);
    const adminOrders = admin.addResource("orders");
    adminOrders.addMethod("GET", adminIntegration, authMethodOpts);
    adminOrders
      .addResource("{orderId}")
      .addResource("decision")
      .addMethod("POST", adminIntegration, authMethodOpts);

    // ----- /uploads/product-image (admin-only, presigned PUT)
    const uploads = api.root.addResource("uploads");
    uploads
      .addResource("product-image")
      .addMethod(
        "POST",
        new apigw.LambdaIntegration(uploadLambda),
        authMethodOpts
      );

    // -----------------------------------------------------------------------
    // Stack outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, "ApiUrl", { value: api.url.replace(/\/$/, "") });
    new cdk.CfnOutput(this, "CognitoUserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "CognitoUserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "AwsRegion", { value: this.region });
    new cdk.CfnOutput(this, "OrdersEventBusName", { value: bus.eventBusName });
    new cdk.CfnOutput(this, "OrdersTableName", { value: ordersTable.tableName });
    new cdk.CfnOutput(this, "ProductsTableName", {
      value: productsTable.tableName,
    });
    new cdk.CfnOutput(this, "CartsTableName", { value: cartsTable.tableName });
    new cdk.CfnOutput(this, "ProductImagesBucketName", {
      value: productImagesBucket.bucketName,
    });
    new cdk.CfnOutput(this, "OrderLambdaName", {
      value: orderLambda.functionName,
    });
    new cdk.CfnOutput(this, "FraudLambdaName", {
      value: fraudLambda.functionName,
    });
    new cdk.CfnOutput(this, "NotificationLambdaName", {
      value: notificationLambda.functionName,
    });
    new cdk.CfnOutput(this, "OrderNotificationsTopicArn", {
      value: topic.topicArn,
    });
  }
}

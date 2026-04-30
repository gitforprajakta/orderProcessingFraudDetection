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
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cr from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";

export class PlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB
    const ordersTable = new dynamodb.Table(this, "OrdersTable", {
      partitionKey: { name: "orderId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // EventBridge bus
    const bus = new events.EventBus(this, "OrdersBus", {
      eventBusName: "OrdersBus",
    });

    // SNS
    const topic = new sns.Topic(this, "OrderNotificationsTopic", {
      topicName: "OrderNotificationsTopic",
    });
    const notificationEmails = (this.node.tryGetContext("notificationEmails") as string[]) || [];
    notificationEmails.forEach((email, index) => {
      if (email && email.includes("@")) {
        topic.addSubscription(
          new subscriptions.EmailSubscription(email, {
            json: true,
          })
        );
      } else {
        cdk.Annotations.of(this).addWarning(
          `notificationEmails[${index}] is not a valid email: ${email}`
        );
      }
    });

    const reviewQueue = new sqs.Queue(this, "ReviewRequestsQueue", {
      queueName: "ReviewRequestsQueue",
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
    });

    const orderLambdaName = "OrderProcessingFraudDetection-OrderLambda";
    const fraudLambdaName = "OrderProcessingFraudDetection-FraudLambda";
    const notificationLambdaName =
      "OrderProcessingFraudDetection-NotificationLambda";
    const reviewLambdaName = "OrderProcessingFraudDetection-ReviewLambda";

    // Lambdas (Python)
    const orderLambda = new lambda.Function(this, "OrderLambda", {
      functionName: orderLambdaName,
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("services/order_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORDERS_TABLE_NAME: ordersTable.tableName,
        EVENT_BUS_NAME: bus.eventBusName,
      },
    });

    const fraudLambda = new lambda.Function(this, "FraudLambda", {
      functionName: fraudLambdaName,
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("services/fraud_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: {
        EVENT_BUS_NAME: bus.eventBusName,
        ORDERS_TABLE_NAME: ordersTable.tableName,
        REVIEW_QUEUE_URL: reviewQueue.queueUrl,
        MODEL_ARTIFACT_DIR: "artifacts",
        APPROVE_THRESHOLD: "0.30",
        BLOCK_THRESHOLD: "0.70",
      },
    });

    const notificationLambda = new lambda.Function(this, "NotificationLambda", {
      functionName: notificationLambdaName,
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("services/notification_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        SNS_TOPIC_ARN: topic.topicArn,
      },
    });
    const reviewLambda = new lambda.Function(this, "ReviewLambda", {
      functionName: reviewLambdaName,
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("services/review_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(15),
      environment: {
        ORDERS_TABLE_NAME: ordersTable.tableName,
        EVENT_BUS_NAME: bus.eventBusName,
        REVIEW_QUEUE_URL: reviewQueue.queueUrl,
      },
    });

    [
      orderLambdaName,
      fraudLambdaName,
      notificationLambdaName,
      reviewLambdaName,
    ].forEach((functionName) => {
      new logs.LogGroup(this, `${functionName}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    });

    // Permissions
    ordersTable.grantWriteData(orderLambda);
    bus.grantPutEventsTo(orderLambda);

    ordersTable.grantWriteData(fraudLambda);
    bus.grantPutEventsTo(fraudLambda);
    reviewQueue.grantSendMessages(fraudLambda);

    topic.grantPublish(notificationLambda);
    ordersTable.grantReadWriteData(reviewLambda);
    bus.grantPutEventsTo(reviewLambda);
    reviewQueue.grantConsumeMessages(reviewLambda);

    // EventBridge rules
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
        source: ["fraud.service", "review.service"],
        detailType: [
          "OrderApproved",
          "OrderBlocked",
          "OrderReview",
          "OrderSentToReviewQueue",
          "OrderReviewResolved",
        ],
      },
      targets: [new targets.LambdaFunction(notificationLambda)],
    });

    // Cognito
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true, username: true },
      mfa: cognito.Mfa.OPTIONAL,
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient("UserPoolClient", {
      authFlows: { userPassword: true },
      generateSecret: false,
    });

    const demoUsername = "testuser";
    const demoPassword = "YourSecurePassw0rd!";
    const demoUserHandler = new lambda.Function(this, "DemoUserHandler", {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
import boto3

cognito = boto3.client("cognito-idp")


def handler(event, context):
    props = event["ResourceProperties"]
    user_pool_id = props["UserPoolId"]
    username = props["Username"]
    password = props["Password"]
    email = props["Email"]
    physical_id = f"{user_pool_id}:{username}"

    if event["RequestType"] == "Delete":
        return {"PhysicalResourceId": physical_id}

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
    return {"PhysicalResourceId": physical_id}
`),
    });
    demoUserHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminSetUserPassword",
        ],
        resources: [userPool.userPoolArn],
      })
    );

    const demoUserProvider = new cr.Provider(this, "DemoUserProvider", {
      onEventHandler: demoUserHandler,
    });

    new cdk.CustomResource(this, "DemoUser", {
      serviceToken: demoUserProvider.serviceToken,
      properties: {
        UserPoolId: userPool.userPoolId,
        Username: demoUsername,
        Password: demoPassword,
        Email: "testuser@example.com",
      },
    });

    // API Gateway
    const api = new apigw.RestApi(this, "OrdersApi", {
      restApiName: "OrdersApi",
      deployOptions: { tracingEnabled: false },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ["OPTIONS", "POST"],
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      { cognitoUserPools: [userPool] }
    );

    const orders = api.root.addResource("orders");
    orders.addMethod("POST", new apigw.LambdaIntegration(orderLambda), {
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizer,
    });
    const reviews = api.root.addResource("reviews");
    const reviewOrder = reviews.addResource("{orderId}");
    const reviewDecision = reviewOrder.addResource("decision");
    reviewDecision.addMethod("POST", new apigw.LambdaIntegration(reviewLambda), {
      authorizationType: apigw.AuthorizationType.COGNITO,
      authorizer,
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: api.url.replace(/\/$/, "") });
    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "CognitoUserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "OrdersEventBusName", { value: bus.eventBusName });
    new cdk.CfnOutput(this, "OrdersTableName", { value: ordersTable.tableName });
    new cdk.CfnOutput(this, "OrderLambdaName", {
      value: orderLambda.functionName,
    });
    new cdk.CfnOutput(this, "FraudLambdaName", {
      value: fraudLambda.functionName,
    });
    new cdk.CfnOutput(this, "NotificationLambdaName", {
      value: notificationLambda.functionName,
    });
    new cdk.CfnOutput(this, "ReviewLambdaName", {
      value: reviewLambda.functionName,
    });
    new cdk.CfnOutput(this, "OrderNotificationsTopicArn", {
      value: topic.topicArn,
    });
    new cdk.CfnOutput(this, "ReviewQueueUrl", {
      value: reviewQueue.queueUrl,
    });
    new cdk.CfnOutput(this, "ReviewDecisionEndpoint", {
      value: `${api.url.replace(/\/$/, "")}/reviews/{orderId}/decision`,
    });
  }
}


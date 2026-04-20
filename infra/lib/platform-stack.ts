import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";

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

    const mlBucket = new s3.Bucket(this, "MlArtifactsBucket", {
      bucketName: undefined,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sageMakerRole = new iam.Role(this, "SageMakerExecutionRole", {
      assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess"),
      ],
    });
    mlBucket.grantReadWrite(sageMakerRole);

    // Lambdas (Python)
    const orderLambda = new lambda.Function(this, "OrderLambda", {
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
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("services/fraud_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        EVENT_BUS_NAME: bus.eventBusName,
        FRAUD_SCORER_MODE: "local",
        APPROVE_THRESHOLD: "0.30",
        BLOCK_THRESHOLD: "0.70",
      },
    });

    const notificationLambda = new lambda.Function(this, "NotificationLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset("services/notification_service"),
      handler: "handler.handler",
      timeout: cdk.Duration.seconds(10),
      environment: {
        SNS_TOPIC_ARN: topic.topicArn,
      },
    });

    // Permissions
    ordersTable.grantWriteData(orderLambda);
    bus.grantPutEventsTo(orderLambda);

    bus.grantPutEventsTo(fraudLambda);
    fraudLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:InvokeEndpoint"],
        resources: ["*"],
      })
    );

    topic.grantPublish(notificationLambda);

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
        source: ["fraud.service"],
        detailType: ["OrderApproved", "OrderBlocked", "OrderReview"],
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

    // API Gateway
    const api = new apigw.RestApi(this, "OrdersApi", {
      restApiName: "OrdersApi",
      deployOptions: { tracingEnabled: false },
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

    new cdk.CfnOutput(this, "ApiUrl", { value: api.url.replace(/\/$/, "") });
    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "CognitoUserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "OrdersEventBusName", { value: bus.eventBusName });
    new cdk.CfnOutput(this, "OrdersTableName", { value: ordersTable.tableName });
    new cdk.CfnOutput(this, "MlArtifactsBucketName", { value: mlBucket.bucketName });
    new cdk.CfnOutput(this, "SageMakerExecutionRoleArn", {
      value: sageMakerRole.roleArn,
    });
  }
}


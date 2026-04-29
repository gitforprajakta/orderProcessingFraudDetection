"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const apigw = __importStar(require("aws-cdk-lib/aws-apigateway"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const events = __importStar(require("aws-cdk-lib/aws-events"));
const targets = __importStar(require("aws-cdk-lib/aws-events-targets"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
class PlatformStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        const orderLambdaName = "OrderProcessingFraudDetection-OrderLambda";
        const fraudLambdaName = "OrderProcessingFraudDetection-FraudLambda";
        const notificationLambdaName = "OrderProcessingFraudDetection-NotificationLambda";
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
        [
            orderLambdaName,
            fraudLambdaName,
            notificationLambdaName,
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
        demoUserHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "cognito-idp:AdminCreateUser",
                "cognito-idp:AdminGetUser",
                "cognito-idp:AdminSetUserPassword",
            ],
            resources: [userPool.userPoolArn],
        }));
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
        const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, "CognitoAuthorizer", { cognitoUserPools: [userPool] });
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
exports.PlatformStack = PlatformStack;

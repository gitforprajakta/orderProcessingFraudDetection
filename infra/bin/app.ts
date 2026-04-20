#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";
import { PlatformStack } from "../lib/platform-stack";

const app = new cdk.App();

new PlatformStack(app, "OrderProcessingFraudDetectionStack", {
  description:
    "Event-driven order processing with ML-based fraud detection (CDK TS, Python Lambdas).",
});


#!/usr/bin/env python3
"""
Upload ml/artifacts/train.csv to S3 and run SageMaker XGBoost training + deploy real-time endpoint.
Requires: pip install -r requirements-ml.txt sagemaker
AWS credentials configured; IAM role with SageMaker + S3 access (see CDK outputs).
"""
from __future__ import annotations

import argparse
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--role-arn",
        required=True,
        help="SageMaker execution role ARN (from CDK output SageMakerExecutionRoleArn)",
    )
    parser.add_argument(
        "--bucket",
        required=True,
        help="S3 bucket for data + model output (from CDK output MlArtifactsBucketName)",
    )
    parser.add_argument(
        "--region",
        default=None,
        help="AWS region (default: session default)",
    )
    parser.add_argument(
        "--prefix",
        default="fraud-xgb",
        help="S3 prefix for train/output artifacts",
    )
    parser.add_argument(
        "--endpoint-name",
        default="fraud-xgb-endpoint",
        help="SageMaker real-time endpoint name to create",
    )
    parser.add_argument(
        "--instance-type",
        default="ml.m5.large",
        help="Training instance type",
    )
    args = parser.parse_args()

    try:
        from sagemaker import image_uris, session as sm_session
        from sagemaker.estimator import Estimator
    except ImportError as e:
        raise SystemExit(
            "Install sagemaker SDK: pip install sagemaker (see ml/README.md)"
        ) from e

    region = args.region or boto3.Session().region_name
    train_path = ROOT / "artifacts" / "train.csv"
    if not train_path.is_file():
        raise SystemExit(
            f"Missing {train_path}. Run: python ml/preprocess_and_train_artifacts.py"
        )

    sess = sm_session.Session(default_bucket=args.bucket)
    image_uri = image_uris.retrieve(
        framework="xgboost",
        region=region,
        version="1.5-1",
        image_scope="training",
    )

    train_s3 = sess.upload_data(
        str(train_path),
        bucket=args.bucket,
        key_prefix=f"{args.prefix}/input",
    )

    xgb = Estimator(
        image_uri=image_uri,
        role=args.role_arn,
        instance_count=1,
        instance_type=args.instance_type,
        output_path=f"s3://{args.bucket}/{args.prefix}/output",
        sagemaker_session=sess,
    )
    xgb.set_hyperparameters(
        objective="binary:logistic",
        num_round=150,
        max_depth=6,
        eta=0.1,
        subsample=0.8,
        eval_metric="auc",
    )

    xgb.fit({"train": train_s3})

    m = xgb.latest_training_job.sagemaker_session.describe_training_job(
        TrainingJobName=xgb.latest_training_job.name
    )
    model_data = m["ModelArtifacts"]["S3ModelArtifacts"]

    # Deploy endpoint
    predictor = xgb.deploy(
        initial_instance_count=1,
        instance_type="ml.m5.large",
        endpoint_name=args.endpoint_name,
    )
    print(f"Endpoint {predictor.endpoint_name} in {region}")
    print(f"Model data: {model_data}")
    print(
        "Set FraudLambda env: FRAUD_SCORER_MODE=sagemaker "
        f"SAGEMAKER_ENDPOINT_NAME={args.endpoint_name}"
    )


if __name__ == "__main__":
    main()

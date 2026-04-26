#!/usr/bin/env python3
"""
Train and evaluate XGBoost locally using the fraud CSV.
Saves model + preprocessing artifacts for local prediction.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import joblib
import xgboost as xgb
from sklearn.metrics import accuracy_score, classification_report, roc_auc_score
from sklearn.model_selection import train_test_split

from preprocess_and_train_artifacts import build_preprocessors, load_and_engineer


ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = (
    ROOT.parent.parent / "Project Stuff" / "Dataset" / "synthetic_fraud_dataset.csv"
)
DEFAULT_OUT = ROOT / "artifacts" / "local_xgb"
DEFAULT_LAMBDA_ARTIFACT_DIR = ROOT.parent / "services" / "fraud_service" / "artifacts"


def _parse_base_score(model: xgb.XGBClassifier) -> float:
    config = json.loads(model.get_booster().save_config())
    raw = config["learner"]["learner_model_param"].get("base_score", "0.5")
    base_score = float(str(raw).strip("[]"))
    base_score = min(max(base_score, 1e-12), 1.0 - 1e-12)
    return math.log(base_score / (1.0 - base_score))


def _export_lambda_model(model: xgb.XGBClassifier, path: Path) -> None:
    trees = [json.loads(tree) for tree in model.get_booster().get_dump(dump_format="json")]
    payload = {
        "version": 1,
        "model_type": "xgboost_tree_dump",
        "objective": "binary:logistic",
        "base_margin": _parse_base_score(model),
        "trees": trees,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))


def _export_inference_spec(pre, num_cols: list[str], cat_cols: list[str], path: Path) -> None:
    num_pipe = pre.named_transformers_["num"]
    imputer = num_pipe.named_steps["imputer"]
    scaler = num_pipe.named_steps["scaler"]
    cat_pipe = pre.named_transformers_["cat"]
    ohe = cat_pipe.named_steps["onehot"]
    spec = {
        "version": 1,
        "numeric_features": num_cols,
        "numeric_imputer_medians": [float(x) for x in imputer.statistics_.tolist()],
        "numeric_scaler_mean": [float(x) for x in scaler.mean_.tolist()],
        "numeric_scaler_scale": [
            float(x) if x > 1e-12 else 1.0 for x in scaler.scale_.tolist()
        ],
        "categorical_features": cat_cols,
        "categorical_categories": [[str(c) for c in arr] for arr in ohe.categories_],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(spec, f, separators=(",", ":"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--csv",
        type=Path,
        default=DEFAULT_CSV,
        help="Path to synthetic_fraud_dataset.csv",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT,
        help="Output directory for local model artifacts",
    )
    parser.add_argument(
        "--lambda-artifact-dir",
        type=Path,
        default=DEFAULT_LAMBDA_ARTIFACT_DIR,
        help="Output directory packaged with Fraud Lambda",
    )
    args = parser.parse_args()

    df = load_and_engineer(args.csv)
    y = df["Fraud_Label"].astype(int)
    X = df.drop(columns=["Fraud_Label"])

    pre, num_cols, cat_cols = build_preprocessors(X)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    pre.fit(X_train)
    X_train_t = pre.transform(X_train)
    X_test_t = pre.transform(X_test)

    model = xgb.XGBClassifier(
        n_estimators=300,
        max_depth=6,
        learning_rate=0.08,
        subsample=0.8,
        colsample_bytree=0.8,
        objective="binary:logistic",
        eval_metric="auc",
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_train_t, y_train)

    y_pred = model.predict(X_test_t)
    y_prob = model.predict_proba(X_test_t)[:, 1]

    metrics = {
        "accuracy": float(accuracy_score(y_test, y_pred)),
        "roc_auc": float(roc_auc_score(y_test, y_prob)),
        "n_train": int(len(y_train)),
        "n_test": int(len(y_test)),
    }

    args.out_dir.mkdir(parents=True, exist_ok=True)
    args.lambda_artifact_dir.mkdir(parents=True, exist_ok=True)
    model_path = args.out_dir / "xgb_model.joblib"
    model_json_path = args.out_dir / "xgb_model.json"
    pre_path = args.out_dir / "sklearn_preprocessor.joblib"
    inference_spec_path = args.out_dir / "inference_spec.json"
    metrics_path = args.out_dir / "metrics.json"
    lambda_model_path = args.lambda_artifact_dir / "xgb_model.json"
    lambda_spec_path = args.lambda_artifact_dir / "inference_spec.json"

    joblib.dump(model, model_path)
    joblib.dump(pre, pre_path)
    _export_lambda_model(model, model_json_path)
    _export_lambda_model(model, lambda_model_path)
    _export_inference_spec(pre, num_cols, cat_cols, inference_spec_path)
    _export_inference_spec(pre, num_cols, cat_cols, lambda_spec_path)
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2)

    print(f"CSV: {args.csv}")
    print(f"Model saved: {model_path}")
    print(f"Lambda model JSON saved: {lambda_model_path}")
    print(f"Lambda inference spec saved: {lambda_spec_path}")
    print(f"Preprocessor saved: {pre_path}")
    print(f"Metrics saved: {metrics_path}")
    print(f"Accuracy: {metrics['accuracy']:.4f}")
    print(f"ROC AUC : {metrics['roc_auc']:.4f}")
    print("\nClassification report:")
    print(classification_report(y_test, y_pred))


if __name__ == "__main__":
    main()

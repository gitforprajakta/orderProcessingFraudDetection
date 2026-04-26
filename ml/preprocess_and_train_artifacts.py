#!/usr/bin/env python3
"""
Build local preprocessing artifacts from synthetic_fraud_dataset.csv.
The AWS Fraud Lambda currently uses a lightweight rule scorer, not this model.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler


ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT / "data" / "synthetic_fraud_dataset.csv"
ARTIFACT_DIR_ML = ROOT / "artifacts"


def load_and_engineer(csv_path: Path) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    if "Fraud_Label" not in df.columns:
        raise ValueError("Expected column Fraud_Label")

    ts = pd.to_datetime(df["Timestamp"], errors="coerce")
    df = df.assign(
        hour=ts.dt.hour.fillna(12).astype(int),
        dow=ts.dt.dayofweek.fillna(0).astype(int),
    )

    df = df.drop(
        columns=["Transaction_ID", "User_ID", "Timestamp"],
        errors="ignore",
    )
    return df


def _export_inference_spec(pre, num_cols: list[str], cat_cols: list[str], path: Path) -> None:
    """JSON-only spec so FraudLambda can build the same vector without sklearn."""
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
        "numeric_scaler_scale": [float(x) if x > 1e-12 else 1.0 for x in scaler.scale_.tolist()],
        "categorical_features": cat_cols,
        "categorical_categories": [[str(c) for c in arr] for arr in ohe.categories_],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(spec, f, indent=2)


def build_preprocessors(X: pd.DataFrame):
    numeric_features = [
        "Transaction_Amount",
        "Account_Balance",
        "IP_Address_Flag",
        "Previous_Fraudulent_Activity",
        "Daily_Transaction_Count",
        "Avg_Transaction_Amount_7d",
        "Failed_Transaction_Count_7d",
        "Card_Age",
        "Transaction_Distance",
        "Risk_Score",
        "Is_Weekend",
        "hour",
        "dow",
    ]
    categorical_features = [
        "Transaction_Type",
        "Device_Type",
        "Location",
        "Merchant_Category",
        "Card_Type",
        "Authentication_Method",
    ]

    for c in numeric_features + categorical_features:
        if c not in X.columns:
            raise ValueError(f"Missing column {c}")

    numeric_transformer = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
        ]
    )

    try:
        ohe = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    except TypeError:
        ohe = OneHotEncoder(handle_unknown="ignore", sparse=False)

    categorical_transformer = Pipeline(
        steps=[
            ("onehot", ohe),
        ]
    )

    preprocessor = ColumnTransformer(
        transformers=[
            ("num", numeric_transformer, numeric_features),
            ("cat", categorical_transformer, categorical_features),
        ]
    )
    return preprocessor, numeric_features, categorical_features


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--csv",
        type=Path,
        default=DEFAULT_CSV,
        help="Path to synthetic_fraud_dataset.csv",
    )
    parser.add_argument(
        "--out-ml",
        type=Path,
        default=ARTIFACT_DIR_ML,
        help="Output directory for train.csv and preprocessor artifacts",
    )
    parser.add_argument(
        "--train-csv-no-header",
        action="store_true",
        help="Write train.csv without header",
    )
    args = parser.parse_args()

    df = load_and_engineer(args.csv)
    y = df["Fraud_Label"].astype(int)
    X = df.drop(columns=["Fraud_Label"])

    pre, num_cols, cat_cols = build_preprocessors(X)
    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    pre.fit(X_train)
    X_tr = pre.transform(X_train)
    X_va = pre.transform(X_val)

    meta = {
        "numeric_features": num_cols,
        "categorical_features": cat_cols,
        "feature_count_after_preprocess": int(X_tr.shape[1]),
        "n_train": int(len(y_train)),
        "n_val": int(len(y_val)),
        "label_positive_rate_train": float(y_train.mean()),
    }

    args.out_ml.mkdir(parents=True, exist_ok=True)
    train_path = args.out_ml / "train.csv"
    # Keep label in the first column for common XGBoost CSV training flows.
    train_mat = np.hstack([y_train.values.reshape(-1, 1), X_tr])
    val_mat = np.hstack([y_val.values.reshape(-1, 1), X_va])

    if args.train_csv_no_header:
        np.savetxt(train_path, train_mat, delimiter=",", fmt="%.8g")
    else:
        header = ["label"] + [f"f{i}" for i in range(X_tr.shape[1])]
        out_df = pd.DataFrame(train_mat, columns=header)
        out_df.to_csv(train_path, index=False)

    meta_path = args.out_ml / "preprocess_meta.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    inf_path = args.out_ml / "inference_spec.json"
    _export_inference_spec(pre, num_cols, cat_cols, inf_path)

    import joblib

    pre_path = args.out_ml / "sklearn_preprocessor.joblib"
    joblib.dump(pre, pre_path)

    print(f"Wrote {train_path} shape={train_mat.shape}")
    print(f"Wrote {pre_path}")
    print(f"Wrote {inf_path}")
    print(f"Validation matrix shape {val_mat.shape} (for optional local XGB eval)")

    # Quick XGBoost offline metrics (optional)
    try:
        import xgboost as xgb

        dtr = xgb.DMatrix(X_tr, label=y_train)
        dva = xgb.DMatrix(X_va, label=y_val)
        params = {
            "objective": "binary:logistic",
            "eval_metric": "auc",
            "max_depth": 6,
            "eta": 0.1,
            "subsample": 0.8,
        }
        booster = xgb.train(
            params,
            dtr,
            num_boost_round=100,
            evals=[(dtr, "train"), (dva, "val")],
            verbose_eval=False,
        )
        preds = booster.predict(dva)
        from sklearn.metrics import roc_auc_score

        auc = roc_auc_score(y_val, preds)
        print(f"Offline validation ROC-AUC (holdout): {auc:.4f}")
    except Exception as e:
        print(f"( skipping xgboost offline eval: {e})")


if __name__ == "__main__":
    main()

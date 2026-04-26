#!/usr/bin/env python3
"""
Run a local prediction using saved XGBoost + preprocessor artifacts.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import joblib
import pandas as pd

from preprocess_and_train_artifacts import load_and_engineer


ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = (
    ROOT.parent.parent / "Project Stuff" / "Dataset" / "synthetic_fraud_dataset.csv"
)
DEFAULT_ARTIFACT_DIR = ROOT / "artifacts" / "local_xgb"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        default=DEFAULT_ARTIFACT_DIR,
        help="Directory containing xgb_model.joblib and sklearn_preprocessor.joblib",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=DEFAULT_CSV,
        help="CSV to take a sample row from",
    )
    parser.add_argument(
        "--row-index",
        type=int,
        default=0,
        help="Row index to predict from engineered feature frame",
    )
    args = parser.parse_args()

    model_path = args.artifact_dir / "xgb_model.joblib"
    pre_path = args.artifact_dir / "sklearn_preprocessor.joblib"
    model = joblib.load(model_path)
    pre = joblib.load(pre_path)

    df = load_and_engineer(args.csv)
    y = df["Fraud_Label"].astype(int)
    X = df.drop(columns=["Fraud_Label"])

    if args.row_index < 0 or args.row_index >= len(X):
        raise IndexError(
            f"row-index {args.row_index} out of range for dataset size {len(X)}"
        )

    row = X.iloc[[args.row_index]]
    row_t = pre.transform(row)
    pred = int(model.predict(row_t)[0])
    prob = float(model.predict_proba(row_t)[0, 1])
    true_label = int(y.iloc[args.row_index])

    print(f"CSV row index: {args.row_index}")
    print(f"True label: {true_label}")
    print(f"Predicted label: {pred}")
    print(f"Predicted fraud probability: {prob:.6f}")
    print("\nSample feature row:")
    print(pd.DataFrame(row).to_string(index=False))


if __name__ == "__main__":
    main()

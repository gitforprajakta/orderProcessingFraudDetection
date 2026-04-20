"""
Map OrderCreated event detail -> same feature vector as ml/preprocess_and_train_artifacts.py
using inference_spec.json (no sklearn in Lambda).
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

_SPEC_CACHE: dict[str, Any] | None = None


def _load_spec() -> dict[str, Any]:
    global _SPEC_CACHE
    if _SPEC_CACHE is not None:
        return _SPEC_CACHE
    here = Path(__file__).resolve().parent
    path = os.environ.get("INFERENCE_SPEC_PATH", str(here / "artifacts" / "inference_spec.json"))
    with open(path, encoding="utf-8") as f:
        _SPEC_CACHE = json.load(f)
    return _SPEC_CACHE


def _location_from_country(code: str) -> str:
    c = (code or "").upper()
    mapping = {
        "US": "New York",
        "GB": "London",
        "UK": "London",
        "IN": "Mumbai",
        "AU": "Sydney",
        "JP": "Tokyo",
        "CA": "New York",
    }
    return mapping.get(c, "New York")


def order_detail_to_feature_vector(detail: dict) -> list[float]:
    """Build CSV row matching SageMaker training features (preprocessed space)."""
    spec = _load_spec()
    num_names = spec["numeric_features"]
    cat_names = spec["categorical_features"]
    medians = dict(zip(num_names, spec["numeric_imputer_medians"]))
    order_total = float(detail.get("orderTotal", 0.0))
    items = detail.get("items") or []
    nitems = max(1, len(items))
    created_ms = int(detail.get("createdAt", int(time.time() * 1000)))
    t = time.gmtime(created_ms / 1000.0)
    hour = t.tm_hour
    dow = t.tm_wday
    is_weekend = 1 if dow >= 5 else 0
    country = str(detail.get("shippingCountry", "US"))

    raw_num = {
        "Transaction_Amount": order_total,
        "Account_Balance": medians["Account_Balance"],
        "IP_Address_Flag": 0.0,
        "Previous_Fraudulent_Activity": 0.0,
        "Daily_Transaction_Count": float(nitems),
        "Avg_Transaction_Amount_7d": order_total * 1.1,
        "Failed_Transaction_Count_7d": 0.0,
        "Card_Age": 120.0,
        "Transaction_Distance": 800.0,
        "Risk_Score": 0.45,
        "Is_Weekend": float(is_weekend),
        "hour": float(hour),
        "dow": float(dow),
    }

    raw_cat = {
        "Transaction_Type": "Online",
        "Device_Type": "Mobile",
        "Location": _location_from_country(country),
        "Merchant_Category": "Electronics",
        "Card_Type": "Visa",
        "Authentication_Method": "OTP",
    }

    nums: list[float] = []
    for idx, n in enumerate(num_names):
        v = raw_num[n]
        mu = spec["numeric_scaler_mean"][idx]
        sc = spec["numeric_scaler_scale"][idx] or 1.0
        m = medians[n]
        imputed = float(v) if v == v else m  # nan check
        nums.append((imputed - mu) / sc)

    onehot: list[float] = []
    for ci, cname in enumerate(cat_names):
        allowed = spec["categorical_categories"][ci]
        val = raw_cat[cname]
        for a in allowed:
            onehot.append(1.0 if str(val) == str(a) else 0.0)

    return nums + onehot


def vector_to_csv_line(vec: list[float]) -> str:
    return ",".join(f"{x:.8g}" for x in vec)

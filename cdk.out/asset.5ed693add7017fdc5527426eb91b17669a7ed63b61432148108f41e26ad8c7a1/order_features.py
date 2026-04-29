"""
Map an OrderCreated event into the same preprocessed feature vector used
when training the local XGBoost model.
"""
from __future__ import annotations

import json
import math
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
    artifact_dir = Path(os.environ.get("MODEL_ARTIFACT_DIR", str(here / "artifacts")))
    with open(artifact_dir / "inference_spec.json", encoding="utf-8") as f:
        _SPEC_CACHE = json.load(f)
    return _SPEC_CACHE


def _location_from_country(code: str) -> str:
    mapping = {
        "US": "New York",
        "CA": "New York",
        "GB": "London",
        "UK": "London",
        "IN": "Mumbai",
        "AU": "Sydney",
        "JP": "Tokyo",
    }
    return mapping.get((code or "").upper(), "New York")


def order_detail_to_feature_vector(detail: dict[str, Any]) -> list[float]:
    spec = _load_spec()
    num_names = spec["numeric_features"]
    cat_names = spec["categorical_features"]
    medians = dict(zip(num_names, spec["numeric_imputer_medians"]))

    order_total = float(detail.get("orderTotal", 0.0))
    items = detail.get("items") or []
    item_count = max(1, sum(int(item.get("qty", 1)) for item in items))
    created_ms = int(detail.get("createdAt", int(time.time() * 1000)))
    created = time.gmtime(created_ms / 1000.0)
    country = str(detail.get("shippingCountry", "US"))
    high_risk_country = country.upper() not in {"US", "CA"}
    risk_score = 0.10
    if order_total > 500:
        risk_score += 0.25
    if order_total > 1500:
        risk_score += 0.35
    if high_risk_country:
        risk_score += 0.20
    if item_count >= 5:
        risk_score += 0.10
    risk_score = min(risk_score, 0.99)

    raw_num = {
        "Transaction_Amount": order_total,
        "Account_Balance": medians["Account_Balance"],
        "IP_Address_Flag": 1.0 if high_risk_country else 0.0,
        "Previous_Fraudulent_Activity": 1.0 if risk_score >= 0.80 else 0.0,
        "Daily_Transaction_Count": float(item_count),
        "Avg_Transaction_Amount_7d": order_total * 1.1,
        "Failed_Transaction_Count_7d": 3.0 if risk_score >= 0.70 else 0.0,
        "Card_Age": 120.0,
        "Transaction_Distance": 2500.0 if high_risk_country else 300.0,
        "Risk_Score": risk_score,
        "Is_Weekend": 1.0 if created.tm_wday >= 5 else 0.0,
        "hour": float(created.tm_hour),
        "dow": float(created.tm_wday),
    }

    raw_cat = {
        "Transaction_Type": "Online",
        "Device_Type": "Mobile",
        "Location": _location_from_country(country),
        "Merchant_Category": "Electronics",
        "Card_Type": "Visa",
        "Authentication_Method": "OTP",
    }

    numeric_values: list[float] = []
    for idx, name in enumerate(num_names):
        value = float(raw_num[name])
        if math.isnan(value):
            value = float(medians[name])
        mean = float(spec["numeric_scaler_mean"][idx])
        scale = float(spec["numeric_scaler_scale"][idx]) or 1.0
        numeric_values.append((value - mean) / scale)

    one_hot_values: list[float] = []
    for idx, name in enumerate(cat_names):
        value = str(raw_cat[name])
        for category in spec["categorical_categories"][idx]:
            one_hot_values.append(1.0 if value == str(category) else 0.0)

    return numeric_values + one_hot_values

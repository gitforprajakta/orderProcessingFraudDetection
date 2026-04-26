"""
Pure-Python XGBoost tree inference for Lambda.

The training script exports XGBoost's JSON tree dump, so the Lambda does not
need SageMaker, Docker, or the native xgboost Python package.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

_MODEL_CACHE: dict[str, Any] | None = None


def _load_model() -> dict[str, Any]:
    global _MODEL_CACHE
    if _MODEL_CACHE is not None:
        return _MODEL_CACHE

    here = Path(__file__).resolve().parent
    artifact_dir = Path(os.environ.get("MODEL_ARTIFACT_DIR", str(here / "artifacts")))
    with open(artifact_dir / "xgb_model.json", encoding="utf-8") as f:
        _MODEL_CACHE = json.load(f)
    return _MODEL_CACHE


def _sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def _node_index(node: dict[str, Any]) -> dict[int, dict[str, Any]]:
    indexed = {int(node["nodeid"]): node}
    for child in node.get("children", []):
        indexed.update(_node_index(child))
    return indexed


def _tree_margin(tree: dict[str, Any], features: list[float]) -> float:
    nodes = _node_index(tree)
    node = tree

    while "leaf" not in node:
        split_name = str(node["split"])
        feature_index = int(split_name[1:]) if split_name.startswith("f") else int(split_name)
        value = features[feature_index]

        if math.isnan(value):
            next_node_id = int(node["missing"])
        elif value < float(node["split_condition"]):
            next_node_id = int(node["yes"])
        else:
            next_node_id = int(node["no"])

        node = nodes[next_node_id]

    return float(node["leaf"])


def predict_probability(features: list[float]) -> float:
    model = _load_model()
    margin = float(model.get("base_margin", 0.0))
    for tree in model["trees"]:
        margin += _tree_margin(tree, features)
    return _sigmoid(margin)

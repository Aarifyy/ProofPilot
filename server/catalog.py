"""Loads the shared scene catalog and validates/clamps simulation specs.

The same catalog.json is served to the browser, so parameter names, units and
ranges are defined in exactly one place.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parent.parent / "static" / "catalog.json"


@lru_cache(maxsize=1)
def load_catalog() -> dict:
    with CATALOG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def scene_types() -> list[str]:
    return list(load_catalog().keys())


def _fmt(v: float) -> str:
    return f"{v:g}"


def validate_spec(spec: dict) -> dict:
    """Return a clean spec: known type, every param present and in range.

    Any change made (unknown param dropped, value clamped, physically
    inconsistent input fixed) is recorded in ``assumptions`` so the student
    can see exactly what was simulated.
    """
    catalog = load_catalog()
    stype = spec.get("type")
    if stype not in catalog:
        stype = "projectile"
    entry = catalog[stype]
    assumptions = list(spec.get("assumptions") or [])

    raw_params = spec.get("params") or {}
    params: dict[str, float] = {}
    for key, meta in entry["params"].items():
        value = raw_params.get(key)
        try:
            value = float(value) if value is not None else None
        except (TypeError, ValueError):
            value = None
        if value is None or not math.isfinite(value):
            params[key] = meta["default"]
            continue
        clamped = min(max(value, meta["min"]), meta["max"])
        if not math.isclose(clamped, value, rel_tol=1e-9, abs_tol=1e-12):
            assumptions.append(
                f"{meta['label']} {_fmt(value)} {meta['unit']} is outside the supported range; "
                f"using {_fmt(clamped)} {meta['unit']}."
            )
        params[key] = clamped

    raw_options = spec.get("options") or {}
    options: dict[str, str] = {}
    for key, meta in entry.get("options", {}).items():
        value = raw_options.get(key)
        options[key] = value if value in meta["choices"] else meta["default"]

    # Physical consistency fixes.
    if stype == "track":
        from .track_spec import validate_track
        x0_given = isinstance(raw_params, dict) and raw_params.get("x0") is not None
        track, shape = validate_track(spec.get("track"), options.get("shape", "bowl"), x0_given, assumptions)
        options["shape"] = shape
        if params["mu_k"] > params["mu_s"] and params["mu_s"] > 0:
            assumptions.append(
                "Kinetic friction cannot exceed static friction for the same surfaces; "
                f"setting μ_s = μ_k = {_fmt(params['mu_k'])}."
            )
            params["mu_s"] = params["mu_k"]
        elif params["mu_k"] > 0 and params["mu_s"] == 0:
            params["mu_s"] = params["mu_k"]
    if stype == "incline" and params["mu_k"] > params["mu_s"]:
        assumptions.append(
            "Kinetic friction cannot exceed static friction for the same surfaces; "
            f"setting μ_s = μ_k = {_fmt(params['mu_k'])}."
        )
        params["mu_s"] = params["mu_k"]

    out = {
        "type": stype,
        "title": spec.get("title") or entry["title"],
        "summary": spec.get("summary") or entry["description"],
        "params": params,
        "options": options,
        "assumptions": assumptions,
        "source": spec.get("source", "local"),
        "note": spec.get("note") or "",
    }
    if stype == "track":
        out["track"] = track
    return out


def catalog_for_prompt() -> str:
    """Compact human-readable catalog for the model's system prompt."""
    lines = []
    for stype, entry in load_catalog().items():
        lines.append(f"### {stype} — {entry['title']}\n{entry['description']}")
        for key, m in entry["params"].items():
            unit = f" [{m['unit']}]" if m["unit"] else ""
            scope = ""
            if m.get("shapes"):
                scope += f" (only for shape {'/'.join(m['shapes'])})"
            if m.get("bodies"):
                scope += f" (only for body {'/'.join(m['bodies'])})"
            lines.append(
                f"- {key}: {m['label']}{unit}, range {_fmt(m['min'])}..{_fmt(m['max'])}, default {_fmt(m['default'])}{scope}"
            )
        for key, m in entry.get("options", {}).items():
            scope = f" (only for body {'/'.join(m['bodies'])})" if m.get("bodies") else ""
            lines.append(f"- option {key}: one of {m['choices']}, default {m['default']}{scope}")
        lines.append("")
    return "\n".join(lines)

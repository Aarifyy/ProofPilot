"""Validation of AI- or user-supplied track geometry for the `track` scene.

The browser builds the geometry (static/js/physics/track.js) and runs its own
numerical checks (finite values, curvature, extent). Here we sanitise the
*structure* before it ever reaches the page: only known segment kinds, finite
numbers clamped to sane ranges, a bounded number of pieces, and maths
expressions restricted to a whitelist grammar. Expressions are never evaluated
on the server and never executed as code anywhere.
"""
from __future__ import annotations

import math
import re

MAX_SEGMENTS = 40
MAX_EXPR = 160
FUNCTIONS = ["asin", "acos", "atan", "sinh", "cosh", "tanh", "sqrt", "cbrt", "sin", "cos", "tan", "exp", "abs", "log", "ln"]
NAMES = sorted(FUNCTIONS + ["x", "pi", "e"], key=len, reverse=True)
TOKEN = re.compile(r"\s*(?:(?P<num>\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|(?P<id>[A-Za-z]+)|(?P<op>[-+*/^(),·×−]))")

SEGMENT_FIELDS = {
    "line": {"length": (0.01, 1000), "turn": (-180, 180), "radius": (0.05, 100)},
    "arc": {"radius": (0.05, 200), "turn": (-720, 720)},
    "curve": {"x0": (-1000, 1000), "x1": (-1000, 1000)},
    "hill": {"height": (-200, 200), "width": (0.2, 1000)},
    "drop": {"height": (-200, 200), "width": (0.2, 1000)},
    "spline": {},
}


def clean_expr(src: object) -> str | None:
    """Return the expression (without "y =") if it only uses the safe grammar, else None."""
    if not isinstance(src, str):
        return None
    s = re.sub(r"^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*", "", src.strip(), flags=re.IGNORECASE).replace("**", "^")
    if not s or len(s) > MAX_EXPR:
        return None
    pos, depth = 0, 0
    while pos < len(s):
        m = TOKEN.match(s, pos)
        if not m or m.end() == pos:
            if s[pos:].strip() == "":
                break
            return None
        if m.group("id"):
            word = m.group("id").lower()
            while word:
                name = next((n for n in NAMES if word.startswith(n)), None)
                if not name:
                    return None
                word = word[len(name):]
        op = m.group("op")
        if op == "(":
            depth += 1
        elif op == ")":
            depth -= 1
            if depth < 0:
                return None
        pos = m.end()
    return s if depth == 0 else None


def _num(v: object, lo: float, hi: float) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x):
        return None
    return min(max(x, lo), hi)


def clean_segment(seg: object) -> dict | None:
    if not isinstance(seg, dict):
        return None
    kind = seg.get("kind")
    if kind not in SEGMENT_FIELDS:
        return None
    out: dict = {"kind": kind}
    for key, (lo, hi) in SEGMENT_FIELDS[kind].items():
        v = _num(seg.get(key), lo, hi)
        if v is not None:
            out[key] = v
    if kind == "line":
        if "length" not in out:
            return None
        if seg.get("corner") is True:
            out["corner"] = True
        if out.get("radius") == 0.05 and not seg.get("radius"):
            out.pop("radius")
        if not out.get("turn"):
            out.pop("turn", None)
            out.pop("radius", None)
    elif kind == "arc":
        if "radius" not in out or abs(out.get("turn", 0)) < 1:
            return None
    elif kind == "curve":
        expr = clean_expr(seg.get("expr"))
        if expr is None or "x0" not in out or "x1" not in out or out["x1"] - out["x0"] < 0.05:
            return None
        out["expr"] = expr
    elif kind in ("hill", "drop"):
        if "height" not in out or "width" not in out or abs(out["height"]) < 1e-3:
            return None
    elif kind == "spline":
        pts = []
        for p in seg.get("points") or []:
            if isinstance(p, dict):
                x, y = _num(p.get("x"), -1000, 1000), _num(p.get("y"), -1000, 1000)
            elif isinstance(p, (list, tuple)) and len(p) == 2:
                x, y = _num(p[0], -1000, 1000), _num(p[1], -1000, 1000)
            else:
                x = y = None
            if x is not None and y is not None:
                pts.append({"x": x, "y": y})
        if not 2 <= len(pts) <= 30:
            return None
        out["points"] = pts
    return out


def validate_track(raw: object, shape: str, x0_given: bool, assumptions: list[str]) -> tuple[dict, str]:
    """Return (clean track dict, possibly-adjusted shape)."""
    raw = raw if isinstance(raw, dict) else {}
    track: dict = {"start_auto": bool(raw.get("start_auto", not x0_given))}
    expr_raw = raw.get("expr")
    if expr_raw:
        expr = clean_expr(expr_raw)
        if expr is None:
            assumptions.append(f"The track equation “{str(expr_raw)[:60]}” uses unsupported syntax, so a sine-wave track is shown instead.")
            if shape == "function":
                shape = "sine"
        else:
            track["expr"] = expr
    elif shape == "function":
        track["expr"] = "sin(x)"
        assumptions.append("No track equation was given; using y = sin(x).")

    segs_raw = raw.get("segments") or []
    if segs_raw:
        segs = [s for s in (clean_segment(s) for s in segs_raw[:MAX_SEGMENTS]) if s]
        dropped = min(len(segs_raw), MAX_SEGMENTS) - len(segs)
        if len(segs_raw) > MAX_SEGMENTS:
            assumptions.append(f"Only the first {MAX_SEGMENTS} track pieces were used.")
        if dropped:
            assumptions.append(f"{dropped} invalid track piece(s) were ignored.")
        if segs:
            track["segments"] = segs
    if shape == "custom" and not track.get("segments"):
        assumptions.append("No usable custom track pieces were provided; showing a demo roller coaster instead.")
    return track, shape

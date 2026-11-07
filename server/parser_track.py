"""Offline interpreter for the general `track` scene (bowls, waves, hills, loops, y = f(x) tracks).

Works on text already normalised by parser._normalise (lower case, number words → digits).
"""
from __future__ import annotations

import math
import re

from .catalog import validate_spec
from .parser import NUM_RE, _ctx, _gravity, _take, extract_quantities
from .track_spec import clean_expr

EXPR_RE = re.compile(
    r"\b(?:y|f\s*\(\s*x\s*\))\s*=\s*(.+?)(?=\s+(?:and|with|from|for|then|starting|where|between|over|place|put)\b|,|;|\.(?:\s|$)|$)"
)
X_RE = re.compile(rf"\bx\s*=\s*({NUM_RE})")
DOMAIN_RE = re.compile(rf"from\s+x\s*=\s*({NUM_RE})\s*(?:m\b)?\s*to\s*(?:x\s*=\s*)?({NUM_RE})")

SHAPE_TITLES = {
    "bowl": "Ball in a Semicircular Bowl", "parabola": "Parabolic Bowl", "sine": "Sine-Wave Track",
    "ramp": "Hill That Levels Out", "incline": "Incline with Run-out", "coaster": "Roller Coaster",
    "function": "Custom Function Track", "custom": "Custom Track",
}
BODY_WORDS = {"cart": ("cart", "car ", "trolley", "wagon", "coaster car"), "block": ("block", "box", "crate", "brick", "sled"),
              "point": ("point mass", "particle", "bead")}


def _has(t: str, *ws: str) -> bool:
    return any(w in t for w in ws)


def parse_track(text: str) -> dict:
    p: dict[str, float] = {}
    options: dict[str, str] = {}
    assumptions: list[str] = []
    track: dict = {}

    # explicit equation and x positions are removed before reading other numbers
    body_text = text
    m = EXPR_RE.search(text)
    if m:
        expr = clean_expr(m.group(1))
        if expr:
            track["expr"] = expr
        else:
            assumptions.append(f"Couldn't read the equation “{m.group(1).strip()}”; using a sine wave instead.")
        body_text = body_text.replace(m.group(0), " ")
    dm = DOMAIN_RE.search(body_text)
    if dm:
        p["xa"], p["xb"] = sorted((float(dm.group(1)), float(dm.group(2))))
        body_text = body_text.replace(dm.group(0), " ")
    xm = X_RE.search(body_text)
    if xm:
        p["x0"] = float(xm.group(1))
        body_text = body_text.replace(xm.group(0), " ")

    qs = extract_quantities(body_text)
    _gravity(body_text, qs, p, assumptions)
    t = body_text

    # ---- shape
    if "expr" in track:
        shape = "function"
    elif _has(t, "parabol"):
        shape = "parabola"
    elif _has(t, "bowl", "dish", "semicirc", "semi-circ", "hemisph", "half-pipe", "halfpipe", "half pipe", "u-shaped", "u shaped", "valley") and not _has(t, "sine", "wave"):
        shape = "bowl"
    elif _has(t, "sine", "sinus", "wave"):
        shape = "sine"
    elif _has(t, "coaster", "loop"):
        shape = "coaster"
    elif _has(t, "levels out", "becomes flat", "flattens", "gradually", "then flat") or (re.search(r"\bhill\b", t) and not re.search(r"\bhills\b", t)):
        shape = "ramp"
    elif re.search(r"\bhills\b", t):
        shape = "coaster"
    elif _has(t, "incline", "ramp", "slope"):
        shape = "incline"
    else:
        shape = "bowl"
    options["shape"] = shape

    # ---- body
    body = next((b for b, ws in BODY_WORDS.items() if _has(t, *ws)), None)
    if body is None:
        body = "cart" if shape == "coaster" and not _has(t, "ball", "marble", "sphere") else "ball"
    options["body"] = body
    if body == "ball":
        if _has(t, "slide", "sliding", "slides", "slid "):
            options["contact"] = "slide"
        if _has(t, "hollow", "shell", "basketball"):
            options["inertia"] = "hollow"
    if body == "cart" and _has(t, "locked", "on rails", "upstop", "can't fall", "cannot fall", "attached to the track", "attached to the rail"):
        options["rail"] = "locked"
    if _has(t, "to the left", "leftward", "leftwards", "push it left", "moving left", "towards the left"):
        options["dir"] = "left"

    speeds, masses, lengths = _take(qs, "speed"), _take(qs, "mass"), _take(qs, "length")
    angles, forces, times = _take(qs, "angle"), _take(qs, "force"), _take(qs, "time")
    bares = _take(qs, "bare")

    def bare_near(*words: str) -> float | None:
        for q in bares:
            if _ctx(q, *words):
                return q.value
        return None

    if masses:
        p["m"] = masses[0].value
    if speeds:
        p["v0"] = abs(speeds[0].value)
    elif _has(t, "push", "kick", "shove", "flick", "nudge", "give it a"):
        p["v0"] = 3
        assumptions.append("No push speed given; using an initial push of 3 m/s.")
    if forces:
        p["F"] = forces[0].value
        for q in times:
            if _ctx(q, "for"):
                p["tF"] = q.value
                break

    # ---- lengths by context
    used: set[int] = set()

    def take_len(*words: str) -> float | None:
        for q in lengths:
            if q.start not in used and _ctx(q, *words):
                used.add(q.start)
                return q.value
        return None

    h_drop = None
    if _has(t, "above", "dropped from", "drop it from", "from a height"):
        h_drop = take_len("above", "dropped from", "drop it from", "height of", "from a height")
        if h_drop is not None and shape in ("bowl", "parabola", "sine", "function"):
            p["h_drop"] = h_drop
    if shape == "bowl":
        r = take_len("radius")
        d = None if r is not None else take_len("diameter", "wide", "across", "width")
        if r is not None:
            p["R"] = r
        elif d is not None:
            p["R"] = d / 2
        else:
            other = next((q for q in lengths if q.start not in used), None)
            if other:
                used.add(other.start)
                p["R"] = other.value / 2
                assumptions.append(f"Interpreted {other.value:g} m as the dish's diameter (radius {other.value / 2:g} m).")
    elif shape == "parabola":
        w = take_len("wide", "width", "across")
        dep = take_len("deep", "depth", "high", "tall")
        if w is not None:
            p["W"] = w
        if dep is not None:
            p["D"] = dep
    elif shape == "sine":
        a = take_len("amplitude", "high", "tall", "height")
        lam = take_len("wavelength", "wave length", "long", "period", "spacing")
        if a is not None:
            p["A"] = a
        if lam is not None:
            p["lambda"] = lam
        n = bare_near("waves", "periods", "cycles")
        if n is not None:
            p["periods"] = n
    elif shape == "coaster":
        rl = take_len("loop", "radius")
        if rl is not None:
            p["R_loop"] = rl / 2 if _ctx(next(q for q in lengths if q.value == rl), "diameter") else rl
        elif not _has(t, "loop"):
            p["R_loop"] = 0
        hh = take_len("hill", "high", "tall", "height", "starts", "drop", "descent", "top")
        if hh is None:
            hh = next((q.value for q in lengths if q.start not in used), None)
        if hh is not None:
            p["H"] = hh
        n = bare_near("hills")
        if n is not None:
            p["hills"] = n
        elif _has(t, "smaller hill", "another hill", "second hill", "a hill", "one hill"):
            p["hills"] = 1
        elif not re.search(r"\bhills\b", t):
            p["hills"] = 0
        if _has(t, "smaller hill"):
            p["hill_ratio"] = 0.5
    elif shape == "ramp":
        hh = take_len("high", "tall", "height", "hill", "top")
        ll = take_len("long", "length")
        if hh is None and lengths:
            hh = next((q.value for q in lengths if q.start not in used), None)
        if hh is not None:
            p["H"] = hh
        if ll is not None:
            p["Lr"] = ll
        if _has(t, "steep") and "Lr" not in p:
            p["Lr"] = 1.2 * p.get("H", 10)
    elif shape == "incline":
        if angles:
            p["theta"] = angles[0].value
        ll = take_len("long", "length")
        if ll is not None:
            p["Ls"] = ll
    if shape == "function" and _has(t, "ball", "cart", "block") and "x0" in p:
        pass

    # ---- body size
    size = take_len("diameter", "radius of the ball", "ball of radius", "size", "wide")
    if size is not None and size < 3:
        p["size"] = size

    # ---- start position words
    if "x0" not in p:
        side = -1 if not _has(t, "right side", "right-hand", "right edge", "right rim") else 1
        if _has(t, "halfway up", "half way up", "half-way up"):
            if shape == "bowl":
                R = p.get("R", 5)
                p["x0"] = side * math.sqrt(R * R - (R / 2) ** 2)
            elif shape == "parabola":
                p["x0"] = side * p.get("W", 10) / 2 * math.sqrt(0.5)
        elif _has(t, "at the bottom", "from the bottom", "lowest point") and shape in ("bowl", "parabola"):
            p["x0"] = 0.0
        if _has(t, "top of the loop"):
            assumptions.append("Starting at the top of the loop isn't supported; starting at the top of the first hill instead.")

    # ---- friction
    mu = bare_near("friction", "mu", "coefficient", "rough")
    crr = bare_near("rolling resistance")
    rough = re.search(r"\b(?:friction|rough)\b", t) is not None
    if _has(t, "frictionless", "no friction", "without friction", "smooth", "on ice", "icy"):
        p["mu_s"] = p["mu_k"] = 0
        if body == "ball" and options.get("contact") != "slide":
            assumptions.append("No friction: nothing can make the ball spin, so it slides without rolling.")
    elif body == "cart":
        if crr is not None or mu is not None:
            p["c_rr"] = crr if crr is not None else mu
        elif rough:
            p["c_rr"] = 0.03
            assumptions.append("Friction on a wheeled cart modelled as rolling resistance c_rr = 0.03.")
    elif mu is not None:
        p["mu_s"] = p["mu_k"] = mu
    elif rough:
        p["mu_s"], p["mu_k"] = 0.4, 0.3
        assumptions.append("Friction modelled with μs = 0.4, μk = 0.3.")
    elif body == "ball" and _has(t, "roll"):
        p["mu_s"], p["mu_k"] = 0.6, 0.4
        assumptions.append("Rolling needs friction: using μs = 0.6, μk = 0.4.")
    e = bare_near("restitution", "bounc")
    if e is not None:
        p["e"] = e

    if "x0" not in p:
        track["start_auto"] = True
    entry_title = SHAPE_TITLES[shape]
    spec = validate_spec({
        "type": "track", "title": entry_title, "summary": "", "params": p, "options": options,
        "track": track, "assumptions": assumptions, "source": "local",
    })
    spec["summary"] = _summary(spec)
    return spec


def _summary(spec: dict) -> str:
    p, o = spec["params"], spec["options"]
    body = {"ball": "A ball", "cart": "A cart", "block": "A block", "point": "A point mass"}[o["body"]]
    shape = {
        "bowl": f"a semicircular bowl of radius {p['R']:g} m",
        "parabola": f"a parabolic bowl {p['W']:g} m wide and {p['D']:g} m deep",
        "sine": f"a sine-wave track (amplitude {p['A']:g} m, wavelength {p['lambda']:g} m)",
        "ramp": f"a {p['H']:g} m hill that levels out into a flat run",
        "incline": f"a {p['theta']:g}° incline followed by a flat run",
        "coaster": f"a roller-coaster track starting {p['H']:g} m up" + (f" with a {p['R_loop']:g} m-radius loop" if p["R_loop"] > 0 else ""),
        "function": f"the track y = {spec.get('track', {}).get('expr', 'sin(x)')}",
        "custom": "a custom track",
    }[o["shape"]]
    bits = []
    if p["h_drop"] > 0:
        bits.append(f"dropped from {p['h_drop']:g} m above the surface")
    if p["v0"] > 0:
        bits.append(f"pushed {o['dir']} at {p['v0']:g} m/s")
    elif p["h_drop"] == 0:
        bits.append("released from rest")
    if p["F"] > 0:
        bits.append(f"with a {p['F']:g} N force for {p['tF']:g} s")
    fr = p["c_rr"] if o["body"] == "cart" else p["mu_k"]
    bits.append("no friction" if fr == 0 else f"friction {fr:g}")
    return f"{body} on {shape}, " + ", ".join(bits) + "."

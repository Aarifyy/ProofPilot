"""Offline natural-language → simulation-spec parser.

Used when no Claude API key is configured or the API is unreachable, so the
app keeps working during a live demo. It recognises the scene from keywords and
assigns numbers to parameters by their units and the words around them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .catalog import load_catalog, validate_spec

NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
    "eighty": 80, "ninety": 90, "hundred": 100, "half": 0.5,
}

PLANETS = {"moon": 1.62, "mars": 3.71, "jupiter": 24.79, "venus": 8.87,
           "mercury": 3.7, "saturn": 10.44, "earth": 9.81, "pluto": 0.62}

# unit spelling -> (class, multiplier to catalog unit)
UNITS = [
    (r"m\s*/\s*s\s*(?:\^?\s*2|²)|ms-2|m/s/s|metres? per second squared|meters? per second squared", "accel", 1.0),
    (r"rad\s*/\s*s|radians? per second", "angvel", 1.0),
    (r"km\s*/\s*h|kmh|kph|kilometres? per hour|kilometers? per hour", "speed", 1 / 3.6),
    (r"mph|miles per hour", "speed", 0.44704),
    (r"m\s*/\s*s|mps|metres? per second|meters? per second|ms-1", "speed", 1.0),
    (r"n\s*/\s*m|newtons? per met(?:er|re)", "stiffness", 1.0),
    (r"°|deg(?:rees?)?\b|degs?\b", "angle", 1.0),
    (r"rad(?:ians?)?\b", "angle", 57.29577951308232),
    (r"kg\b|kilo(?:gram)?s?\b|kilogrammes?\b", "mass", 1.0),
    (r"g\b|grams?\b|grammes?\b", "mass", 0.001),
    (r"cm\b|centimet(?:er|re)s?\b", "length", 0.01),
    (r"mm\b|millimet(?:er|re)s?\b", "length", 0.001),
    (r"km\b|kilomet(?:er|re)s?\b", "length", 1000.0),
    (r"m\b|met(?:er|re)s?\b", "length", 1.0),
    (r"s\b|secs?\b|seconds?\b", "time", 1.0),
    (r"n\b|newtons?\b", "force", 1.0),
    (r"%|percent\b", "percent", 1.0),
]

NUM_RE = r"[-+−]?\d+(?:\.\d+)?|[-+−]?\.\d+"
UNIT_RE = "|".join(f"(?:{u})" for u, _, _ in UNITS)
TOKEN_RE = re.compile(rf"(?P<num>{NUM_RE})\s*(?P<unit>{UNIT_RE})?", re.IGNORECASE)


@dataclass
class Quantity:
    value: float
    kind: str          # unit class, or "bare"
    start: int
    before: str        # up to ~6 words preceding the number
    after: str         # a few words following


def _normalise(text: str) -> str:
    t = text.lower().replace("−", "-")
    # "forty-five" / "forty five" → 45
    t = re.sub(
        r"\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](one|two|three|four|five|six|seven|eight|nine)\b",
        lambda m: str(NUMBER_WORDS[m.group(1)] + NUMBER_WORDS[m.group(2)]),
        t,
    )
    t = re.sub(r"\b(" + "|".join(NUMBER_WORDS) + r")\b", lambda m: str(NUMBER_WORDS[m.group(1)]), t)
    t = t.replace("μ", " mu ").replace("µ", " mu ")
    return t


def _classify_unit(unit: str | None) -> tuple[str, float]:
    if not unit:
        return "bare", 1.0
    for pattern, kind, mult in UNITS:
        if re.fullmatch(pattern, unit.strip(), re.IGNORECASE):
            return kind, mult
    return "bare", 1.0


def extract_quantities(text: str) -> list[Quantity]:
    out = []
    for m in TOKEN_RE.finditer(text):
        # Skip numbers glued to letters, e.g. "m1" or "x2".
        if m.start() > 0 and text[m.start() - 1].isalpha():
            continue
        kind, mult = _classify_unit(m.group("unit"))
        value = float(m.group("num").replace("−", "-")) * mult
        before = " ".join(text[max(0, m.start() - 60):m.start()].split()[-6:])
        after = " ".join(text[m.end():m.end() + 40].split()[:5])
        out.append(Quantity(value, kind, m.start(), before, after))
    return out


TRACK_WORDS = (
    "bowl", "dish", "semicirc", "semi-circ", "hemisph", "half-pipe", "halfpipe", "half pipe", "u-shaped",
    "u shaped", "valley", "parabolic", "parabola", "sine", "sinus", "wave-shaped", "wave shaped", "wavy",
    "loop-the-loop", "loop the loop", "vertical loop", "circular loop", "roller coaster", "rollercoaster",
    "coaster", "track", "hills", "levels out", "becomes flat", "flattens", "skate", "curved surface",
)


def is_track_prompt(t: str) -> bool:
    if "pendulum" in t or "spring" in t:
        return False
    if re.search(r"\b(?:y|f\s*\(\s*x\s*\))\s*=", t):
        return True
    if any(w in t for w in TRACK_WORDS):
        return True
    return ("loop" in t and any(w in t for w in ("cart", "ball", "car", "marble"))) or bool(re.search(r"\bhill\b", t))


def detect_scene(text: str) -> str:
    t = text
    has = lambda *ws: any(w in t for w in ws)  # noqa: E731
    if has("double pendulum", "chaotic pendulum", "two pendulums", "chaos"):
        return "double_pendulum"
    if is_track_prompt(t):
        return "track"
    if "pendulum" in t and has("cart", "trolley", "sliding mass", "block", "spring", "rail"):
        return "cart_pendulum"
    if has("atwood", "pulley", "over a rope", "rope over", "string over"):
        return "atwood"
    if "pendulum" in t:
        return "pendulum"
    if "spring" in t or has("hooke", "n/m", "harmonic oscillator"):
        if has("hang", "hung", "vertical", "ceiling", "suspend", "dangl", "bungee"):
            return "spring_vertical"
        return "spring"
    if has("collid", "collision", "crash", "elastic", "momentum", "carts", "restitution", "head-on", "head on"):
        return "collision"
    if has("incline", "ramp", "slope", "inclined", "wedge", "slides down", "slide down", "sliding down"):
        return "incline"
    if has("swing"):
        return "pendulum"

    # Fall back to keyword scoring.
    catalog = load_catalog()
    best, best_score = "projectile", 0
    for stype, entry in catalog.items():
        score = sum(1 for kw in entry["keywords"] if kw in t)
        if score > best_score:
            best, best_score = stype, score
    return best


def _ctx(q: Quantity, *words: str) -> bool:
    ctx = q.before + " " + q.after
    return any(w in ctx for w in words)


def _take(qs: list[Quantity], kind: str) -> list[Quantity]:
    return [q for q in qs if q.kind == kind]


def parse_prompt(prompt: str) -> dict:
    text = _normalise(prompt)
    stype = detect_scene(text)
    if stype == "track":
        from .parser_track import parse_track
        return parse_track(text)
    qs = extract_quantities(text)
    p: dict[str, float] = {}
    options: dict[str, str] = {}
    assumptions: list[str] = []
    _gravity(text, qs, p, assumptions)
    return _parse_scene(stype, text, qs, p, options, assumptions)


def _gravity(text: str, qs: list[Quantity], p: dict, assumptions: list[str]) -> None:
    """Gravity: explicit acceleration, g = ..., or a named planet."""
    for q in _take(qs, "accel"):
        p["g"] = q.value
    if "g" not in p:
        m = re.search(r"\bg\s*=\s*(" + NUM_RE + ")", text)
        if m:
            p["g"] = float(m.group(1))
    if "g" not in p:
        for planet, g in PLANETS.items():
            if re.search(rf"\b(on|from|at) (the )?{planet}\b", text) or f"{planet}'s gravity" in text:
                p["g"] = g
                assumptions.append(f"Using surface gravity of {planet.title()}: g = {g} m/s².")
                break


def _parse_scene(stype: str, text: str, qs: list[Quantity], p: dict, options: dict, assumptions: list[str]) -> dict:
    speeds, angles, masses = _take(qs, "speed"), _take(qs, "angle"), _take(qs, "mass")
    lengths, stiff, angvel = _take(qs, "length"), _take(qs, "stiffness"), _take(qs, "angvel")
    bares = _take(qs, "bare") + _take(qs, "percent")

    def bare_near(*words: str) -> float | None:
        for q in bares:
            if _ctx(q, *words):
                return q.value / 100 if q.kind == "percent" else q.value
        return None

    if stype == "projectile":
        if speeds:
            p["v0"] = abs(speeds[0].value)
        if angles:
            p["angle"] = angles[0].value
        for q in lengths:
            if _ctx(q, "height", "high", "cliff", "tall", "tower", "building", "above", "top", "roof", "table", "bridge"):
                p["h0"] = q.value
        if masses:
            p["m"] = masses[0].value
        if any(w in text for w in ("air resistance", "drag", "air friction")):
            k = bare_near("drag", "resistance")
            p["drag"] = k if k is not None else 0.005
            if k is None:
                assumptions.append("Air resistance modelled as quadratic drag with k = 0.005 kg/m.")
        if "horizontal" in text and not angles:
            p["angle"] = 0
        if any(w in text for w in ("straight up", "vertically", "upward")) and not angles:
            p["angle"] = 90
        if "v0" not in p:
            # "at 25" with no unit — assume m/s.
            for q in bares:
                if _ctx(q, "speed", "velocity", "launched at", "thrown at", "fired at", "at"):
                    p["v0"] = abs(q.value)
                    assumptions.append(f"Interpreted {q.value:g} as a launch speed in m/s.")
                    break

    elif stype == "pendulum":
        if lengths:
            p["L"] = lengths[0].value
        if angles:
            p["theta0"] = angles[0].value
        if masses:
            p["m"] = masses[0].value
        if angvel:
            p["omega0"] = angvel[0].value
        if any(w in text for w in ("rod", "rigid", "bar ")):
            options["connector"] = "rod"
        if any(w in text for w in ("damp", "air resistance", "friction", "slowly stops")):
            b = bare_near("damp")
            p["b"] = b if b is not None else 0.1
            if b is None:
                assumptions.append("Damping modelled as linear drag with b = 0.1 s⁻¹.")

    elif stype in ("spring", "spring_vertical"):
        if masses:
            p["m"] = masses[0].value
        if stiff:
            p["k"] = stiff[0].value
        else:
            k = bare_near("spring constant", "stiffness", "k =", "k=")
            if k is not None:
                p["k"] = k
        key = "x0" if stype == "spring" else "y0"
        for q in lengths:
            sign = -1 if _ctx(q, "compress", "push", "squash") else 1
            if stype == "spring_vertical" and _ctx(q, "up", "raise", "lift"):
                sign = -1
            p[key] = sign * abs(q.value)
            break
        if speeds:
            p["v0"] = speeds[0].value
        if any(w in text for w in ("damp", "air resistance")):
            b = bare_near("damp")
            p["b"] = b if b is not None else 0.4
        if stype == "spring" and any(w in text for w in ("friction", "rough")) and "frictionless" not in text:
            mu = bare_near("friction", "coefficient", "mu")
            p["mu"] = mu if mu is not None else 0.1
            if mu is None:
                assumptions.append("Rough surface modelled with friction coefficient μ = 0.1.")

    elif stype == "incline":
        if angles:
            p["angle"] = angles[0].value
        if masses:
            p["m"] = masses[0].value
        if lengths:
            p["d"] = lengths[0].value
        if speeds:
            p["v0"] = abs(speeds[0].value)
        if "frictionless" in text or "smooth" in text:
            p["mu_s"] = p["mu_k"] = 0.0
        else:
            ms, mk = bare_near("static"), bare_near("kinetic", "dynamic", "sliding")
            generic = bare_near("friction", "coefficient", "mu")
            if ms is not None:
                p["mu_s"] = ms
            if mk is not None:
                p["mu_k"] = mk
            if generic is not None and ms is None and mk is None:
                p["mu_s"] = p["mu_k"] = generic
            elif ms is not None and mk is None:
                p["mu_k"] = min(ms, 0.8 * ms)
            elif mk is not None and ms is None:
                p["mu_s"] = max(mk, 1.2 * mk)

    elif stype == "collision":
        if len(masses) >= 1:
            p["m1"] = masses[0].value
        if len(masses) >= 2:
            p["m2"] = masses[1].value
        if len(speeds) >= 1:
            p["u1"] = abs(speeds[0].value)
        if len(speeds) >= 2:
            v2 = abs(speeds[1].value)
            toward = _ctx(speeds[1], "toward", "towards", "opposite", "head", "left", "back")
            p["u2"] = -v2 if (toward or "head-on" in text or "head on" in text) else v2
        elif any(w in text for w in ("at rest", "stationary", "still", "parked", "not moving")):
            p["u2"] = 0.0
        e = bare_near("restitution", "e =", "e=")
        if e is not None:
            p["e"] = e
        elif any(w in text for w in ("perfectly inelastic", "stick", "stuck", "couple", "combine")):
            p["e"] = 0.0
        elif "inelastic" in text:
            p["e"] = 0.5
            assumptions.append("'Inelastic' interpreted as coefficient of restitution e = 0.5.")
        elif "elastic" in text:
            p["e"] = 1.0

    elif stype == "atwood":
        if len(masses) >= 1:
            p["m1"] = masses[0].value
        if len(masses) >= 2:
            p["m2"] = masses[1].value
        if lengths:
            p["h"] = lengths[0].value

    elif stype == "cart_pendulum":
        cart_mass = [q for q in masses if _ctx(q, "cart", "trolley", "block", "slider")]
        bob_mass = [q for q in masses if _ctx(q, "bob", "pendulum", "ball")]
        if cart_mass:
            p["M"] = cart_mass[0].value
        if bob_mass:
            p["m"] = bob_mass[0].value
        rest = [q for q in masses if q not in cart_mass and q not in bob_mass]
        for key in ("M", "m"):
            if key not in p and rest:
                p[key] = rest.pop(0).value
        if stiff:
            p["k"] = stiff[0].value
        for q in lengths:
            if _ctx(q, "displace", "offset", "pulled", "shifted"):
                p["x0"] = q.value
            elif "L" not in p:
                p["L"] = q.value
        if angles:
            p["theta0"] = angles[0].value

    elif stype == "double_pendulum":
        for key, q in zip(("m1", "m2"), masses):
            p[key] = q.value
        for key, q in zip(("L1", "L2"), lengths):
            p[key] = q.value
        for key, q in zip(("theta1", "theta2"), angles):
            p[key] = q.value
        if "no ghost" in text or "without ghost" in text:
            options["ghost"] = "off"

    entry = load_catalog()[stype]
    summary = _summarise(stype, p, entry)
    return validate_spec({
        "type": stype,
        "title": entry["title"],
        "summary": summary,
        "params": p,
        "options": options,
        "assumptions": assumptions,
        "source": "local",
    })


def _summarise(stype: str, p: dict, entry: dict) -> str:
    if not p:
        return entry["description"] + " Using default values; adjust them in the Experiment panel."
    bits = []
    for key, value in p.items():
        meta = entry["params"].get(key)
        if meta:
            bits.append(f"{meta['label'].lower()} {value:g} {meta['unit']}".strip())
    return f"{entry['title']} with " + ", ".join(bits) + "."

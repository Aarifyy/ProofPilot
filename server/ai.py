"""Claude integration: prompt interpretation and the streaming AI tutor.

Every function here degrades gracefully: if no credentials are configured, or
the API errors, callers fall back to the offline parser / tutor.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Iterator

import anthropic

from .catalog import catalog_for_prompt, scene_types, validate_spec

log = logging.getLogger("proofpilot.ai")

MODEL = os.environ.get("PROOFPILOT_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"

_client: anthropic.Anthropic | None = None


def has_credentials() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(timeout=45.0, max_retries=1)
    return _client


# ---------------------------------------------------------------- interpret

INTERPRET_SYSTEM = f"""You convert a student's natural-language physics request into a simulation
specification for ProofPilot, an interactive physics lab. You must choose exactly one of the
supported simulation types and fill in its parameters.

Supported simulations (parameter key: meaning [catalog unit], allowed range, default):

{catalog_for_prompt()}

Rules:
- Convert every quantity to the catalog unit (e.g. km/h → m/s, cm → m, grams → kg, radians → degrees).
- Only include parameters the request states or clearly implies; omitted ones use defaults.
- "On the Moon/Mars/Jupiter" etc. sets g to that body's surface gravity.
- Angles: projectile angle is above horizontal; pendulum angles are from the downward vertical.
- Collisions: velocities to the right are positive; "towards each other" / "head-on" makes u2 negative;
  "elastic" → e = 1, "perfectly inelastic"/"stick together" → e = 0.
- Anything moving ON a surface or track (bowls, dishes, half-pipes, valleys, hills, sine/wave tracks,
  y = f(x) tracks, loop-the-loops, roller coasters, ramps that curve or level out) is the `track` scene —
  never a pendulum. A plain block on a straight ramp with no other features may use `incline`.
- If the request is not one of these systems, pick the closest one, set supported=false, and say in `note`
  what was simplified. Never invent a system that is not listed.

The `track` scene (world coordinates in metres, x to the right, y up):
- Prefer a preset `shape` when it fits, and set its parameters:
  bowl (semicircular dish, radius R; "diameter d" → R = d/2), parabola (width W, depth D),
  sine (y = A sin(2πx/λ + φ) for x from 0 to n·λ), ramp (hill of height H and length L that levels out
  into a flat run), incline (straight slope θ, length L, then flat), coaster (start platform at height H,
  a smooth drop to y = 0, `hills` extra hills of height hill_ratio·H shrinking by 25% each, then a vertical
  loop of radius R_loop if R_loop > 0, then a flat run).
- An explicit equation ("y = 2sin(x)", "f(x) = x^2/4") → shape `function` with track.expr set to the
  right-hand side, and xa/xb for the x-range (default −6..6). Allowed grammar only: numbers, x, pi, e,
  + - * / ^ ( ), implicit multiplication (2x, 3sin(x)), and sin cos tan asin acos atan sinh cosh tanh exp
  ln log sqrt abs cbrt. Make sure f is defined on the whole range (e.g. no sqrt of negatives).
- Anything else → shape `custom` with track.segments, built like a turtle: each piece starts where the
  previous ended, heading the same way (initial heading: to the right, from (0, 0)). Pieces:
    line {{length, turn}}: straight; `turn` (deg, + = counter-clockwise/up) is applied first as a smooth bend
      of radius `radius` (default 1 m) unless corner = true (a deliberate sharp corner).
    arc {{radius, turn}}: circular arc; turn = 360 is a full vertical loop; + curves upward when moving right.
    hill {{height, width}}: smooth bump (negative height = dip). drop {{height, width}}: smooth descent
      (negative = climb). Both start and end level.
    curve {{expr, x0, x1}}: y = f(x) piece, shifted to join on.  spline {{points}}: smooth curve through
      points given relative to the piece's start.
  Every segment object must contain every field; set unused numeric fields to 0, expr to "",
  points to [] and corner to false. Keep tracks smooth and physically sensible (no zero lengths).
- For non-track scenes, or preset shapes, set track.expr = "" and track.segments = [].
- Start: x0 = the surface x-coordinate where the body starts (omit x0 to use the shape's natural start:
  bowl/parabola near the left rim, sine at the bottom of the first valley, ramp/incline/coaster at the top).
  "Halfway up the left side" etc. → compute x0 from the geometry. Body released ON the surface →
  h_drop = 0 ("drop a ball into a bowl" = released from rest at the rim). Only "dropped from 2 m above"
  sets h_drop. A push / kick / initial speed → v0 with option dir (right/left); a force applied for some
  time → F (N, along the track) and tF (s). Never confuse the two.
- Bodies: ball (contact roll needs friction: if the ball rolls and no friction is given use mu_s 0.6,
  mu_k 0.4; "frictionless"/"no friction" → mu 0, which means it slides without spinning), cart (wheels;
  c_rr = rolling resistance; rail = locked only if it is attached to the rail / has upstop wheels / "cannot
  fall off"), block (slides with friction), point (idealised point mass/particle/bead).
  size = ball diameter / block side / cart length.
- `summary`: one plain sentence describing exactly what will be simulated, with numbers and units.
- `assumptions`: short statements of anything you inferred (e.g. "No air resistance", "Launched from ground level").
- `title`: 2–6 words, e.g. "Cannonball on the Moon".
"""

INTERPRET_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": scene_types()},
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "params": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "value": {"type": "number"}},
                "required": ["name", "value"],
                "additionalProperties": False,
            },
        },
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "value": {"type": "string"}},
                "required": ["name", "value"],
                "additionalProperties": False,
            },
        },
        "track": {
            "type": "object",
            "properties": {
                "expr": {"type": "string"},
                "segments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "enum": ["line", "arc", "hill", "drop", "curve", "spline"]},
                            "length": {"type": "number"},
                            "turn": {"type": "number"},
                            "radius": {"type": "number"},
                            "height": {"type": "number"},
                            "width": {"type": "number"},
                            "expr": {"type": "string"},
                            "x0": {"type": "number"},
                            "x1": {"type": "number"},
                            "points": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                                    "required": ["x", "y"],
                                    "additionalProperties": False,
                                },
                            },
                            "corner": {"type": "boolean"},
                        },
                        "required": ["kind", "length", "turn", "radius", "height", "width", "expr", "x0", "x1", "points", "corner"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["expr", "segments"],
            "additionalProperties": False,
        },
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "supported": {"type": "boolean"},
        "note": {"type": "string"},
    },
    "required": ["type", "title", "summary", "params", "options", "track", "assumptions", "supported", "note"],
    "additionalProperties": False,
}


def _create(**kwargs):
    """messages.create with server-side refusal fallbacks; retries without them if rejected."""
    try:
        return client().beta.messages.create(betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
    except anthropic.BadRequestError as e:
        log.warning("Fallback-enabled request rejected (%s); retrying without fallbacks", e.message)
        return client().messages.create(**kwargs)


def interpret_with_claude(prompt: str) -> dict:
    response = _create(
        model=MODEL,
        max_tokens=4000,
        thinking={"type": "adaptive"},
        output_config={
            "effort": "low",
            "format": {"type": "json_schema", "schema": INTERPRET_SCHEMA},
        },
        system=INTERPRET_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("Claude declined to interpret the request")
    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        raise RuntimeError(f"No text in response (stop_reason={response.stop_reason})")
    data = json.loads(text)
    spec = {
        "type": data["type"],
        "title": data["title"],
        "summary": data["summary"],
        "params": {p["name"]: p["value"] for p in data["params"]},
        "options": {o["name"]: o["value"] for o in data["options"]},
        "track": data.get("track") or {},
        "assumptions": data["assumptions"],
        "note": data["note"] if not data["supported"] else "",
        "source": "claude",
    }
    return validate_spec(spec)


# ---------------------------------------------------------------- tutor

TUTOR_SYSTEM = """You are ProofPilot's physics tutor, embedded next to a live, physically accurate
simulation the student is running. You can see the simulation's current parameters, measurements and
the student's predictions in a <simulation_state> block attached to their latest message.

How to teach:
- Be concise: usually 2–5 short sentences or a few bullet points. Students are mid-experiment.
- Ground every explanation in the student's actual numbers and what they can see on screen
  (labels, arrows, graphs). Quote the measured values.
- Prefer guiding questions and suggested experiments over lecturing. When a misconception shows up
  (e.g. "heavier things fall faster", "period depends on mass", "45° is always best"), name it gently,
  explain why it fails, and propose an experiment that would show it.
- Write maths in LaTeX with $...$ inline or $$...$$ for display. Use SI units.
- You may suggest an experiment the student can run with one click by writing, on its own line:
  [[try: param=value, param2=value2 | short button label]]
  Use only parameter keys listed in the state block, with values inside their ranges. At most two per reply.
- Never claim the simulation shows something it doesn't. If asked about something outside this
  simulation, answer briefly and connect it back.
"""


def tutor_stream(messages: list[dict], context: dict) -> Iterator[str]:
    """Yield text chunks of the tutor's reply."""
    convo = [{"role": m["role"], "content": m["content"]} for m in messages if m.get("content")]
    if not convo or convo[-1]["role"] != "user":
        raise ValueError("Last message must be from the user")
    state = json.dumps(context, ensure_ascii=False, indent=1)
    convo[-1] = {
        "role": "user",
        "content": f"<simulation_state>\n{state}\n</simulation_state>\n\n{convo[-1]['content']}",
    }
    kwargs = dict(
        model=MODEL,
        max_tokens=8000,
        thinking={"type": "adaptive"},
        output_config={"effort": "low"},
        system=TUTOR_SYSTEM,
        messages=convo,
    )
    try:
        stream_cm = client().beta.messages.stream(betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
        with stream_cm as stream:
            yield from stream.text_stream
            final = stream.get_final_message()
    except anthropic.BadRequestError as e:
        log.warning("Fallback-enabled stream rejected (%s); retrying without fallbacks", e.message)
        with client().messages.stream(**kwargs) as stream:
            yield from stream.text_stream
            final = stream.get_final_message()
    if final.stop_reason == "refusal":
        yield "\n\n*(The tutor couldn't answer that one — try rephrasing your question about the simulation.)*"

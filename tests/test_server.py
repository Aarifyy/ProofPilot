"""Server tests: offline parser, spec validation, offline tutor, API endpoints,
and the Claude code path (against a fake client, so no API key is needed)."""
import json
import types

import pytest
from fastapi.testclient import TestClient

from server import ai, app as app_module
from server.catalog import load_catalog, validate_spec
from server.parser import parse_prompt
from server.tutor_local import local_reply


# ---------------------------------------------------------------- parser
@pytest.mark.parametrize("prompt, stype, expect", [
    ("Simulate a ball being launched at 25 metres per second at 40 degrees.", "projectile", {"v0": 25, "angle": 40}),
    ("A cannonball fired at 90 km/h at 30° from a 20 m cliff", "projectile", {"v0": 25, "angle": 30, "h0": 20}),
    ("throw a ball at 10 m/s on the moon", "projectile", {"v0": 10, "g": 1.62}),
    ("pendulum 3 m long released from 60 degrees with a 2 kg bob", "pendulum", {"L": 3, "theta0": 60, "m": 2}),
    ("a 2kg block on a spring with k = 50 N/m pulled 20 cm", "spring", {"m": 2, "k": 50, "x0": 0.2}),
    ("a spring compressed by 10 cm with a 1 kg mass and 30 N/m", "spring", {"x0": -0.1, "k": 30}),
    ("a 500 g mass hanging from a vertical spring 40 N/m", "spring_vertical", {"m": 0.5, "k": 40}),
    ("a 5 kg block on a 35 degree ramp with friction coefficient 0.4", "incline", {"angle": 35, "m": 5, "mu_k": 0.4, "mu_s": 0.4}),
    ("block sliding down a frictionless 20° slope", "incline", {"angle": 20, "mu_s": 0, "mu_k": 0}),
    ("two carts collide head on: 3 kg at 4 m/s and 1 kg at 2 m/s, perfectly inelastic", "collision", {"m1": 3, "m2": 1, "u1": 4, "u2": -2, "e": 0}),
    ("a 2 kg cart hits a stationary 1 kg cart at 3 m/s elastically", "collision", {"u1": 3, "u2": 0, "e": 1}),
    ("atwood machine with 5 kg and 3 kg", "atwood", {"m1": 5, "m2": 3}),
    ("a pendulum hanging from a cart between two springs of 20 N/m", "cart_pendulum", {"k": 20}),
    ("chaotic double pendulum starting at 90 degrees and 45 degrees", "double_pendulum", {"theta1": 90, "theta2": 45}),
])
def test_parser(prompt, stype, expect):
    spec = parse_prompt(prompt)
    assert spec["type"] == stype
    for k, v in expect.items():
        assert spec["params"][k] == pytest.approx(v), (k, spec["params"])


def test_parser_rod_option_and_unknown_prompt():
    assert parse_prompt("a rigid rod pendulum at 120 degrees")["options"]["connector"] == "rod"
    spec = parse_prompt("hello there")
    assert spec["type"] in load_catalog()


# ---------------------------------------------------------------- validation
def test_validate_clamps_and_records_assumption():
    spec = validate_spec({"type": "projectile", "params": {"v0": 500, "angle": "x"}})
    assert spec["params"]["v0"] == 80
    assert spec["params"]["angle"] == 45  # invalid → default
    assert any("outside the supported range" in a for a in spec["assumptions"])


def test_validate_fixes_friction_order():
    spec = validate_spec({"type": "incline", "params": {"mu_s": 0.2, "mu_k": 0.5}})
    assert spec["params"]["mu_s"] == spec["params"]["mu_k"] == 0.5


def test_validate_unknown_type_and_option():
    spec = validate_spec({"type": "nope", "options": {"connector": "chain"}})
    assert spec["type"] == "projectile"
    spec = validate_spec({"type": "pendulum", "options": {"connector": "chain"}})
    assert spec["options"]["connector"] == "string"


# ---------------------------------------------------------------- offline tutor
def ctx(scene, **params):
    return {"scene": scene, "params": {k: {"value": v, "min": 0, "max": 100} for k, v in params.items()}, "derived": {}}


def test_tutor_mass_misconception_pendulum():
    reply = local_reply([{"role": "user", "content": "Does a heavier bob swing slower?"}], ctx("pendulum", m=1, L=2, g=9.81))
    assert "mass" in reply and "[[try:" in reply


def test_tutor_prediction_feedback():
    c = ctx("projectile", v0=20, angle=45)
    c["prediction"] = {"kind": "number", "student": 30, "actual": 40.8, "unit": "m", "hint": "Split the motion."}
    reply = local_reply([{"role": "user", "content": "I predicted R = 30 m"}], c)
    assert "26%" in reply and "Split the motion" in reply


def test_tutor_covers_every_scene():
    for scene in load_catalog():
        assert local_reply([{"role": "user", "content": "explain what is happening"}], ctx(scene)).strip()


# ---------------------------------------------------------------- API (offline)
@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("PROOFPILOT_OFFLINE", "1")
    return TestClient(app_module.app)


def test_api_offline(client):
    assert client.get("/api/status").json()["ai"] is False
    spec = client.post("/api/interpret", json={"prompt": "pendulum 2 m at 30 degrees"}).json()
    assert spec["type"] == "pendulum" and spec["source"] == "local"
    r = client.post("/api/tutor", json={"messages": [{"role": "user", "content": "why?"}], "context": ctx("pendulum")})
    assert r.status_code == 200 and r.headers["x-tutor-source"] == "local" and r.text
    assert client.get("/").status_code == 200
    assert client.get("/catalog.json").json() == load_catalog()


def test_api_rejects_empty_prompt(client):
    assert client.post("/api/interpret", json={"prompt": ""}).status_code == 422


# ---------------------------------------------------------------- Claude path (fake client)
class FakeMessages:
    def __init__(self, payload):
        self.payload, self.calls = payload, []

    def create(self, **kw):
        self.calls.append(kw)
        return types.SimpleNamespace(stop_reason="end_turn", content=[types.SimpleNamespace(type="text", text=json.dumps(self.payload))])


def test_interpret_with_claude_parses_structured_output(monkeypatch):
    payload = {"type": "projectile", "title": "Moon Throw", "summary": "A ball on the Moon.",
               "params": [{"name": "v0", "value": 12}, {"name": "g", "value": 1.62}, {"name": "bogus", "value": 1}],
               "options": [], "assumptions": ["No air"], "supported": True, "note": ""}
    fake = FakeMessages(payload)
    monkeypatch.setattr(ai, "_client", types.SimpleNamespace(beta=types.SimpleNamespace(messages=fake), messages=fake))
    spec = ai.interpret_with_claude("throw a ball at 12 m/s on the moon")
    assert spec["source"] == "claude" and spec["params"]["v0"] == 12 and spec["params"]["g"] == 1.62
    assert "bogus" not in spec["params"]
    call = fake.calls[0]
    assert call["model"] == ai.MODEL and call["fallbacks"] == "default"
    assert call["output_config"]["format"]["type"] == "json_schema"


def test_interpret_falls_back_to_parser_when_claude_fails(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.delenv("PROOFPILOT_OFFLINE", raising=False)

    def boom(prompt):
        raise RuntimeError("network down")

    monkeypatch.setattr(ai, "interpret_with_claude", boom)
    spec = TestClient(app_module.app).post("/api/interpret", json={"prompt": "atwood 4 kg and 2 kg"}).json()
    assert spec["type"] == "atwood" and "offline interpreter" in spec["note"]


def test_tutor_falls_back_when_claude_stream_fails(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.delenv("PROOFPILOT_OFFLINE", raising=False)

    def boom(messages, context):
        raise RuntimeError("network down")
        yield  # pragma: no cover

    monkeypatch.setattr(ai, "tutor_stream", boom)
    r = TestClient(app_module.app).post("/api/tutor", json={"messages": [{"role": "user", "content": "mass?"}], "context": ctx("pendulum")})
    assert "Offline tutor" in r.text and "mass" in r.text


# ---------------------------------------------------------------- general tracks
from server.track_spec import clean_expr, clean_segment  # noqa: E402


@pytest.mark.parametrize("prompt, shape, body, expect", [
    ("Drop a ball into a semicircular dish with a radius of 5 metres, with no friction.", "bowl", "ball", {"R": 5, "h_drop": 0, "mu_k": 0}),
    ("a ball dropped into a semicircular dish of 5m", "bowl", "ball", {"R": 2.5}),
    ("a ball dropped from 2 m above a bowl of radius 3 m", "bowl", "ball", {"R": 3, "h_drop": 2}),
    ("Create a cart travelling through a vertical loop-the-loop.", "coaster", "cart", {"hills": 0, "c_rr": 0}),
    ("A roller coaster cart starts on a 12 m hill and goes through a vertical loop of radius 4 m", "coaster", "cart", {"H": 12, "R_loop": 4}),
    ("Make a roller coaster with three hills and a loop.", "coaster", "cart", {"hills": 3}),
    ("Generate a sine-wave slope, place a ball at the bottom of the first valley, and push it to the right at 8 m/s.", "sine", "ball", {"v0": 8}),
    ("Create a smooth parabolic bowl with a ball starting halfway up the left side.", "parabola", "ball", {"x0": -3.5355339}),
    ("Generate a track following y = 2sin(x) and place a ball at x = 0 with an initial velocity of 5 m/s.", "function", "ball", {"x0": 0, "v0": 5}),
    ("Make a steep hill that gradually becomes flat, then apply friction.", "ramp", "ball", {"mu_k": 0.3}),
    ("a block slides down a hill with friction coefficient 0.25", "ramp", "block", {"mu_k": 0.25, "mu_s": 0.25}),
])
def test_parser_tracks(prompt, shape, body, expect):
    spec = parse_prompt(prompt)
    assert spec["type"] == "track" and spec["options"]["shape"] == shape and spec["options"]["body"] == body, spec
    for k, v in expect.items():
        assert spec["params"][k] == pytest.approx(v), (k, spec["params"][k])


def test_parser_track_expression_and_direction():
    spec = parse_prompt("Generate a track following y = 2sin(x) and place a ball at x = 0 with an initial velocity of 5 m/s to the left")
    assert spec["track"]["expr"] == "2sin(x)" and spec["track"]["start_auto"] is False and spec["options"]["dir"] == "left"
    assert parse_prompt("a bowl with a ball")["track"]["start_auto"] is True


def test_existing_scenes_not_captured_by_track_detection():
    assert parse_prompt("a 5 kg block on a 35 degree ramp with friction coefficient 0.4")["type"] == "incline"
    assert parse_prompt("a pendulum hanging from a cart between two springs of 20 N/m")["type"] == "cart_pendulum"
    assert parse_prompt("throw a ball at 10 m/s on the moon")["type"] == "projectile"


@pytest.mark.parametrize("src, ok", [
    ("2sin(x)", True), ("y = 0.1x^2 - 3", True), ("x**2/4", True), ("sqrt(abs(x))+pi", True), ("(x+1)(x-1)", True),
    ("__import__('os')", False), ("x; import os", False), ("alert(1)", False), ("constructor", False),
    ("x)(", False), ("eval(x)", False), ("window", False), ("x" * 200, False), ("", False),
])
def test_expression_whitelist(src, ok):
    assert (clean_expr(src) is not None) == ok


def test_segments_are_cleaned_and_clamped():
    assert clean_segment({"kind": "rm -rf", "length": 3}) is None
    assert clean_segment({"kind": "line", "length": "nan"}) is None
    assert clean_segment({"kind": "arc", "radius": 4, "turn": 0}) is None
    assert clean_segment({"kind": "line", "length": 1e9})["length"] == 1000
    loop = clean_segment({"kind": "arc", "radius": 3, "turn": 360, "length": 0, "height": 0, "width": 0, "expr": "", "x0": 0, "x1": 0, "points": [], "corner": False})
    assert loop == {"kind": "arc", "radius": 3, "turn": 360}
    assert clean_segment({"kind": "curve", "expr": "alert(1)", "x0": 0, "x1": 5}) is None
    assert clean_segment({"kind": "spline", "points": [{"x": 1, "y": 2}, [3, 4]]})["points"] == [{"x": 1, "y": 2}, {"x": 3, "y": 4}]


def test_validate_track_spec():
    spec = validate_spec({"type": "track", "options": {"shape": "custom"}, "track": {"segments": [{"kind": "line", "length": 5}] * 60}})
    assert len(spec["track"]["segments"]) == 40 and any("first 40" in a for a in spec["assumptions"])
    bad = validate_spec({"type": "track", "options": {"shape": "function"}, "track": {"expr": "fetch('x')"}})
    assert bad["options"]["shape"] == "sine" and "expr" not in bad["track"]
    fr = validate_spec({"type": "track", "params": {"mu_k": 0.3}})
    assert fr["params"]["mu_s"] == 0.3


def test_tutor_track_loop_and_normal_force():
    c = ctx("track", m=1, g=9.81, H=8)
    c["options"] = {"shape": "coaster", "body": "cart"}
    c["derived"] = {"loop_h_min": {"value": 10}, "loop_v_top_min": {"value": 6.26}, "loop_result": {"value": "fell"}, "detach_height": {"value": 6.6}}
    reply = local_reply([{"role": "user", "content": "Why does the cart need enough speed at the top of the loop?"}], c)
    assert "sqrt{gR}" in reply and "6.6" in reply and "[[try: H=" in reply
    c["derived"] = {"N_bottom_measured": {"value": 49.3}}
    assert "not" in local_reply([{"role": "user", "content": "why isn't the normal force mg cos theta?"}], c)


def test_interpret_with_claude_track(monkeypatch):
    seg = {"kind": "arc", "radius": 4, "turn": 360, "length": 0, "height": 0, "width": 0, "expr": "", "x0": 0, "x1": 0, "points": [], "corner": False}
    payload = {"type": "track", "title": "Loop", "summary": "A loop.", "params": [{"name": "v0", "value": 9}],
               "options": [{"name": "shape", "value": "custom"}, {"name": "body", "value": "cart"}],
               "track": {"expr": "", "segments": [{**seg, "kind": "line", "length": 6, "radius": 0, "turn": 0}, seg]},
               "assumptions": [], "supported": True, "note": ""}
    fake = FakeMessages(payload)
    monkeypatch.setattr(ai, "_client", types.SimpleNamespace(beta=types.SimpleNamespace(messages=fake), messages=fake))
    spec = ai.interpret_with_claude("cart through a loop")
    assert spec["track"]["segments"] == [{"kind": "line", "length": 6}, {"kind": "arc", "radius": 4, "turn": 360}]
    assert spec["track"]["start_auto"] is True
    schema = fake.calls[0]["output_config"]["format"]["schema"]
    assert "track" in schema["required"]

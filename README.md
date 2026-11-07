# ProofPilot — Learn by Experimenting

ProofPilot turns a plain-English physics question into an interactive, physically accurate experiment, then
helps the student reason about it with an AI tutor.

> **Student question → AI interprets → simulation generated → student predicts & experiments → AI explains and assesses**

## Quick start

```bat
run.bat
```

or manually:

```bat
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn server.app:app --port 8000
```

Open http://localhost:8000.

### Enabling Claude

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. The header pill turns green ("Claude connected").
With a key, prompts are interpreted by Claude (structured JSON output validated against the scene catalog), and the
tutor streams answers from Claude using the live simulation state. Requests opt into server-side refusal fallbacks
(`fallbacks: "default"`).

**Without a key, everything still works.** A built-in natural-language interpreter and a rule-based tutor
(grounded in the same live numbers) take over automatically, and any API failure mid-demo falls back to them
transparently. Set `PROOFPILOT_OFFLINE=1` to force offline mode as a demo safety net.

## What students can do

- Type an experiment ("A 2 kg cart between two 15 N/m springs with a 1.2 m pendulum hanging from it") or click an example.
- Play / pause / restart / single-step; run at 0.1×–2× speed.
- Change every parameter with sliders; the simulation rebuilds instantly.
- Toggle force arrows, velocity vectors, components, labels and motion trails.
- Read live measurements and graphs (speed, v_x, v_y, v along the track, acceleration, normal force, energy…).
  Hover a graph to inspect values, scroll to zoom, drag to pan, double-click to go live, compare with the previous run,
  and switch between speed |v| and its components.
- See the governing equations with their own numbers substituted (KaTeX).
- **Predict first**: commit to a number (range, period, time, velocity…) and the simulation measures the real value;
  or answer a concept check that targets a classic misconception. The tutor then gives feedback.
- Ask the tutor anything; it can reply with one-click **Try it** buttons that change the experiment.

## Simulations

| Scene | Physics | Notable details |
|---|---|---|
| Projectile | RK4, optional quadratic drag | launch from a cliff, vacuum-path comparison, stroboscopic trail, range/height dimensions |
| Simple pendulum | full non-linear ODE | string **goes slack** when tension < 0 (rod doesn’t); exact elliptic-integral period |
| Horizontal spring | Hooke + viscous damping + Coulomb friction | stick–slip with static friction |
| Hanging spring | about equilibrium | natural-length / equilibrium lines, `mg/k` dimension |
| Inclined plane | static & kinetic friction | full free-body diagram with components |
| 1-D collision | exact event-driven, restitution `e` | live momentum and kinetic-energy bars |
| Atwood machine | ideal pulley | rope wraps the rotating pulley, tension vs weights |
| Spring cart + pendulum | coupled Lagrangian | styled after the reference diagram; normal-mode frequencies |
| Double pendulum | Lagrangian, chaotic | ghost copy 0.001° apart shows sensitivity to initial conditions |
| **Tracks & curved motion** | constrained motion along any curve (RK4, h = 1/2000 s) | bowls, parabolas, sine waves, ramps, roller coasters with loops, `y = f(x)`, AI-built custom segments; ball (rolling or sliding), cart (free or rail-locked), block, point mass |

### Track engine

The AI (or the offline parser) only describes the **geometry and initial conditions**; the motion is computed.

- **Geometry** (`static/js/physics/track.js`): chains of `line / arc / curve / hill / drop / spline` segments joined tangent-continuously,
  presets, or a function `y = f(x)`. Equations go through a whitelisted parser (`static/js/physics/expr.js`, mirrored by
  `server/track_spec.py`) — nothing is ever `eval`'d. Tracks are validated (length, extent, curvature, finite values) and warn on self-crossing.
- **Dynamics** (`static/js/scenes/track.js`): gravity resolved along/normal to the track, normal force
  `N = m(v²κ + g·n_y)` including curvature (not just `mg cos θ`), static/kinetic friction, rolling with a static-friction check
  and slipping, rolling resistance for carts, loss of contact (`N < 0` → free flight), landing impacts with restitution,
  end walls, and a push (impulse `v0`) kept separate from a continuous applied force `F` for a time `tF`.
- Concept checks (does it complete the loop? where does it stop?) are answered by a hidden forecast run of the same engine.
- Force arrows `mg, N, f, F` are solid; `v` and `a` are dashed because they are not forces.

## Visual language

All rendering uses reusable primitives in `static/js/render/primitives.js`, so every component is distinguishable:

- **Springs**: helical coils with front/back strands, lead wires and anchors; they stretch and compress while keeping their coil count.
- **Ropes/strings**: thin warm-coloured lines that sag when slack and never push.
- **Rigid rods**: thick shaded bars with joints; constant length.
- **Masses**: shaded blocks, carts with wheels, or spherical bobs, labelled `m`, `M`, `m₁`, `m₂`.
- **Supports**: hatched ceilings, floors and walls in engineering style; fixed pivots.
- **Annotations**: dimension lines (`D`, `x_M`, `L`, `R`, `H`), angle arcs (`θ`, `α`), and colour-coded force arrows
  (gravity amber, normal green, friction red, tension violet, spring pink, velocity cyan).

## Tests

```bat
.venv\Scripts\python -m pytest                # server: parser, validation, tutor, API, Claude path (mocked)
```

Physics accuracy tests run in the browser at http://localhost:8000/tests.html. They check against analytic results:
range/flight time, small- and large-amplitude periods, spring periods, friction stick/slip, incline times, collision
momentum and restitution, Atwood acceleration, and energy conservation (drift ≈ 1e-11 or better). Track tests cover the
rolling factor 5/7 g sin θ, bowl periods (sliding and rolling), N at the bottom = m(v²/R + g), the loop detach angle,
v_top and h_min = 2.5R, friction stopping distance v²/(2μg), static hold, sine-crest take-off, and energy drift ~1e-7.

`tests/e2e_flow.py` drives the real UI in headless Chrome: prompt → prediction → tutor feedback → Try-it button → equations → sliders → bowl prompt → speed prediction → graph hover/compare/toggle → loop coaster → equation editor (and rejection of unsafe input) → every example.
Set `PROOFPILOT_URL` to point it at another server.

## Project layout

```
server/            FastAPI app, Claude integration, offline parser + tutor, catalog validation
static/catalog.json  single source of truth for scenes, parameters, units and ranges
static/js/scenes/  one file per simulation (physics + drawing + equations + predictions)
static/js/render/  view transform, drawing primitives, canvas maths labels
static/js/ui/      graph, tutor chat, prediction cards
tests/             pytest suite and the end-to-end UI driver
```

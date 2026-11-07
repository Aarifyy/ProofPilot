"""Offline tutor: rule-based but grounded in the live simulation numbers.

Keeps ProofPilot useful (and demo-safe) without an API key. The browser sends
the same context object it sends to Claude: parameters, derived quantities,
measurements and the latest prediction.
"""
from __future__ import annotations

import math
import re


def _p(ctx: dict, key: str, default: float = 0.0) -> float:
    v = ctx.get("params", {}).get(key)
    if isinstance(v, dict):
        v = v.get("value")
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _d(ctx: dict, key: str):
    v = ctx.get("derived", {}).get(key)
    if isinstance(v, dict):
        v = v.get("value")
    return v


def _f(x, digits: int = 3) -> str:
    if x is None:
        return "—"
    if isinstance(x, bool):
        return "yes" if x else "no"
    try:
        x = float(x)
    except (TypeError, ValueError):
        return str(x)
    return f"{x:.{digits}g}"


def _clamp_try(ctx: dict, key: str, value: float) -> float:
    meta = ctx.get("params", {}).get(key)
    if isinstance(meta, dict) and "min" in meta and "max" in meta:
        value = min(max(value, meta["min"]), meta["max"])
    return round(value, 3)


def _try(ctx: dict, label: str, **changes: float) -> str:
    parts = ", ".join(f"{k}={_clamp_try(ctx, k, v):g}" for k, v in changes.items())
    return f"\n[[try: {parts} | {label}]]"


def _has(q: str, *words: str) -> bool:
    return any(re.search(rf"\b{re.escape(w)}", q) for w in words)


# ---------------------------------------------------------------- per scene

def projectile(q: str, c: dict) -> str:
    v0, ang, h0, g, k, m = (_p(c, x) for x in ("v0", "angle", "h0", "g", "drag", "m"))
    R, T, H = _d(c, "range_theory"), _d(c, "tof_theory"), _d(c, "hmax_theory")
    drag = k > 0
    if _has(q, "mass", "heav", "light", "weigh"):
        if drag:
            return (f"With air drag on, mass **does** matter: the drag deceleration is $\\frac{{k}}{{m}}v^2$, so a heavier "
                    f"ball (same size) is slowed less. Right now $k/m = {_f(k / m)}\\,\\text{{m}}^{{-1}}$."
                    + _try(c, "Make it 5× heavier", m=m * 5))
        return ("In a vacuum the mass cancels out: $F = mg$ gives $a = g$ for every object, so the trajectory "
                f"is identical for any mass. That's why the equations for range ($R = {_f(R)}$ m) contain no $m$ at all. "
                "Try it — change the mass and watch the path not move."
                + _try(c, "Make it 10× heavier", m=m * 10))
    if _has(q, "angle", "45", "maxim", "best", "furthest", "farthest", "optimal"):
        extra = "" if h0 == 0 and not drag else (
            " But you're launching from a height" + (" with drag" if drag else "") +
            ", so the best angle is actually **less than 45°** — the ball already has extra fall time.")
        return ("On level ground without drag, $R = \\dfrac{v_0^2 \\sin 2\\theta}{g}$, which peaks when $\\sin 2\\theta = 1$, "
                f"i.e. $\\theta = 45°$.{extra} Complementary angles (like 30° and 60°) give the same range on flat ground — "
                "test it:" + _try(c, "Launch at 30°", angle=30) + _try(c, "Launch at 60°", angle=60))
    if _has(q, "drag", "air", "resist"):
        if drag:
            return ("Drag acts opposite the velocity with magnitude $kv^2$, so it removes energy all the time. The path "
                    "becomes asymmetric — steeper on the way down — and the range falls short of the vacuum value "
                    f"${_f(R)}$ m. Compare the measured range with that number." + _try(c, "Turn drag off", drag=0))
        return ("Air resistance is currently off, so only gravity acts and the path is a perfect parabola. "
                "Switch drag on to see a lopsided trajectory and a shorter range." + _try(c, "Add air drag", drag=0.01))
    if _has(q, "gravity", "moon", "mars", "planet", "g "):
        return (f"Range and flight time both scale as $1/g$. With $g = {_f(g)}$ m/s² the ball flies {_f(T)} s. "
                "On the Moon ($g = 1.62$ m/s²) the same throw goes about six times further." + _try(c, "Throw on the Moon", g=1.62))
    if _has(q, "speed", "faster", "velocity", "double"):
        return ("Range on flat ground goes as $v_0^2$: double the speed and the ball lands **four** times further, "
                "because both the flight time and the horizontal speed double." + _try(c, "Double the speed", v0=v0 * 2))
    if _has(q, "height", "top", "peak", "highest"):
        return (f"At the peak the vertical velocity is zero but the horizontal velocity $v_0\\cos\\theta = {_f(v0 * math.cos(math.radians(ang)))}$ m/s "
                f"is unchanged — the ball is never at rest. Theory: $H = h_0 + \\dfrac{{(v_0\\sin\\theta)^2}}{{2g}} = {_f(H)}$ m.")
    return ("The ball's motion splits into two independent parts: constant horizontal velocity "
            "$v_x = v_0\\cos\\theta$, and vertical motion with constant acceleration $-g$. Watch the velocity arrow: its "
            "horizontal part never changes" + (" (except for drag)" if drag else "") +
            f", while the vertical part shrinks, flips and grows. Predicted range: **{_f(R)} m**, flight time **{_f(T)} s**.")


def pendulum(q: str, c: dict) -> str:

    L, th, m, g, b = (_p(c, x) for x in ("L", "theta0", "m", "g", "b"))
    Ts, Tm = _d(c, "T_small"), _d(c, "T_measured")
    if _has(q, "mass", "heav", "light", "weigh"):
        return ("The period doesn't depend on the bob's mass: gravity's pull ($mg$) and the bob's inertia ($m$) both scale "
                "with mass, so it cancels in $\\ddot\\theta = -\\frac{g}{L}\\sin\\theta$. Double it and check the period."
                + _try(c, "Double the mass", m=m * 2))
    if _has(q, "angle", "amplitude", "small", "approx", "large", "big", "formula", "measured", "longer than", "exact"):
        diff = "" if Tm is None or Ts is None else f" Here the measured period is {_f(Tm)} s vs {_f(Ts)} s from the small-angle formula."
        return ("The formula $T = 2\\pi\\sqrt{L/g}$ uses $\\sin\\theta \\approx \\theta$, valid for small angles. This simulation "
                "solves the full non-linear equation, so large swings take noticeably **longer**." + diff
                + _try(c, "Release at 10°", theta0=10) + _try(c, "Release at 80°", theta0=80))
    if _has(q, "length", "longer", "shorter", "string length"):
        return (f"$T \\approx 2\\pi\\sqrt{{L/g}}$, so period grows with the **square root** of length: 4× the length "
                f"gives 2× the period. Right now $T_{{small}} = {_f(Ts)}$ s." + _try(c, "Make it 4× longer", L=L * 4))
    if _has(q, "slack", "string", "rod", "tension"):
        return ("Tension in the string is $T = m(L\\dot\\theta^2 + g\\cos\\theta)$. A string can only pull, so if that "
                "becomes negative (bob above the pivot moving too slowly) the string goes **slack** and the bob falls "
                "as a projectile. A rigid rod can push as well as pull, so it never goes slack."
                + _try(c, "Release at 150°", theta0=150))
    if _has(q, "energy", "speed", "fastest", "bottom"):
        v = math.sqrt(max(0.0, 2 * g * L * (1 - math.cos(math.radians(th)))))
        return (f"Energy is exchanged between $mgh$ and $\\tfrac12 mv^2$. Dropping from {_f(th)}° the bob falls "
                f"$h = L(1-\\cos\\theta_0) = {_f(L * (1 - math.cos(math.radians(th))))}$ m, so at the bottom "
                f"$v = \\sqrt{{2gh}} = {_f(v)}$ m/s. Watch the energy graph — the total stays flat"
                + (" except for the damping losses." if b > 0 else "."))
    if _has(q, "damp", "stop", "friction", "air"):
        return ("Damping adds $-b\\dot\\theta$ to the equation of motion, so the amplitude decays exponentially "
                "($\\propto e^{-bt/2}$) while the period barely changes." + _try(c, "Add damping", b=0.15))
    return (f"The bob is pulled back toward the bottom by the tangential component of gravity, $mg\\sin\\theta$. "
            f"With $L = {_f(L)}$ m and $g = {_f(g)}$ m/s², the small-angle period is **{_f(Ts)} s**"
            + (f"; the simulation measures **{_f(Tm)} s**." if Tm else ". Let it swing to measure the real one."))


def spring(q: str, c: dict) -> str:
    m, k, b, mu = (_p(c, x) for x in ("m", "k", "b", "mu"))
    T = _d(c, "T")
    vertical = c.get("scene") == "spring_vertical"
    if _has(q, "amplitude", "stretch", "further", "pull"):
        key = "y0" if vertical else "x0"
        x = _p(c, key)
        return ("For an ideal spring the period $T = 2\\pi\\sqrt{m/k}$ has no amplitude in it: pull it twice as far "
                "and it moves twice as fast, arriving back at the same time." + _try(c, "Double the amplitude", **{key: x * 2}))
    if _has(q, "mass", "heav", "light"):
        return (f"More mass means more inertia, so it oscillates more slowly: $T \\propto \\sqrt{{m}}$. "
                f"Currently $T = {_f(T)}$ s; 4× the mass would make it {_f((T or 0) * 2)} s." + _try(c, "Quadruple the mass", m=m * 4))
    if _has(q, "stiff", "k ", "spring constant", "constant"):
        return ("A stiffer spring (bigger $k$) gives a larger restoring force $F = -kx$ per metre, so it oscillates faster: "
                "$\\omega = \\sqrt{k/m}$." + _try(c, "Make it 4× stiffer", k=k * 4))
    if vertical and _has(q, "gravity", "weight", "equilibrium", "hang"):
        return (f"Gravity only shifts the equilibrium: the spring stretches $mg/k = {_f(_d(c, 'static_stretch'))}$ m to hold "
                "the weight. Measured from that new equilibrium the motion is identical to a horizontal spring, with the "
                "same $T = 2\\pi\\sqrt{m/k}$ — $g$ doesn't appear." + _try(c, "Try Moon gravity", g=1.62))
    if _has(q, "energy"):
        return ("Energy sloshes between the spring's potential energy $\\tfrac12 kx^2$ and kinetic energy $\\tfrac12 mv^2$. "
                "Kinetic energy peaks as the block passes equilibrium; potential peaks at the turning points."
                + (" Friction/damping drains the total — see the energy graph." if (b > 0 or mu > 0) else " The total line stays flat."))
    if _has(q, "friction", "damp", "stop", "decay"):
        return ("Viscous damping ($-bv$) makes the amplitude decay **exponentially**; sliding friction ($\\mu mg$, constant "
                "size) makes it shrink by the same amount every half-cycle — a **linear** decay — and the block can get "
                "stuck before reaching equilibrium. Compare them:"
                + _try(c, "Viscous damping", b=0.6, mu=0) + _try(c, "Sliding friction", b=0, mu=0.08))
    return (f"Hooke's law, $F = -kx$, always points back toward equilibrium, giving simple harmonic motion "
            f"$x(t) = A\\cos(\\omega t + \\phi)$ with $\\omega = \\sqrt{{k/m}}$ and period **{_f(T)} s**. "
            "Watch the coils: compressed coils push, stretched coils pull.")


def incline(q: str, c: dict) -> str:

    a_deg, mus, muk, g = (_p(c, x) for x in ("angle", "mu_s", "mu_k", "g"))
    slides, acc, tb = _d(c, "slides"), _d(c, "a"), _d(c, "t_bottom")
    crit = math.degrees(math.atan(mus))
    if _has(q, "mass", "heav", "light"):
        return ("Both the driving force ($mg\\sin\\alpha$) and friction ($\\mu mg\\cos\\alpha$) are proportional to $m$, "
                "so the acceleration $a = g(\\sin\\alpha - \\mu_k\\cos\\alpha)$ is independent of mass." + _try(c, "Make it 5× heavier", m=_p(c, "m") * 5))
    if _has(q, "slide", "move", "stuck", "static", "why not", "doesn't", "stay"):
        return (f"It slides only if $\\tan\\alpha > \\mu_s$. Here $\\tan {a_deg:g}° = {_f(math.tan(math.radians(a_deg)))}$ and "
                f"$\\mu_s = {_f(mus)}$, so the critical angle is $\\arctan\\mu_s = {_f(crit)}°$ — it "
                + ("**slides**." if slides else "**stays put**: static friction exactly matches $mg\\sin\\alpha$.")
                + _try(c, f"Tilt to {min(75, round(crit) + 3)}°", angle=min(75, round(crit) + 3)))
    if _has(q, "normal", "force", "free body", "fbd", "diagram"):
        return ("Three forces act: weight $mg$ (straight down), the normal force $N = mg\\cos\\alpha$ (perpendicular to the "
                "ramp) and friction (along the ramp, opposing motion). Resolve weight along the ramp: $mg\\sin\\alpha$ drives "
                "it down. The normal force is **less** than the weight on a slope — a common misconception.")
    if _has(q, "friction", "frictionless", "rough"):
        return (f"Kinetic friction $\\mu_k N$ opposes sliding and reduces the acceleration from $g\\sin\\alpha$ to "
                f"$g(\\sin\\alpha - \\mu_k\\cos\\alpha) = {_f(acc)}$ m/s²." + _try(c, "Make it frictionless", mu_s=0, mu_k=0))
    return (f"Along the ramp the net force is $mg\\sin\\alpha - \\mu_k mg\\cos\\alpha$. "
            + (f"The block accelerates at **{_f(acc)} m/s²** and reaches the bottom in **{_f(tb)} s**."
               if slides else f"Static friction holds it: you'd need more than {_f(crit)}° to make it slide."))


def collision(q: str, c: dict) -> str:
    m1, m2, u1, u2, e = (_p(c, x) for x in ("m1", "m2", "u1", "u2", "e"))
    v1, v2, ke_lost = _d(c, "v1"), _d(c, "v2"), _d(c, "KE_lost")
    if _has(q, "energy", "kinetic", "lost", "heat"):
        return (f"Momentum is conserved in every collision, but kinetic energy only when $e = 1$. With $e = {_f(e)}$ "
                f"the collision converts **{_f(ke_lost)} J** into heat, sound and deformation."
                + _try(c, "Perfectly elastic", e=1) + _try(c, "Stick together", e=0))
    if _has(q, "momentum", "conserv"):
        p = m1 * u1 + m2 * u2
        return (f"Total momentum $p = m_1u_1 + m_2u_2 = {_f(p)}$ kg·m/s before **and** after, because the forces the carts "
                "exert on each other are equal and opposite (Newton's 3rd law) and no external horizontal force acts.")
    if _has(q, "equal", "same mass", "swap", "stop"):
        return ("For equal masses in an elastic collision the carts simply **swap velocities** — a moving cart hitting a "
                "stationary one stops dead." + _try(c, "Equal masses, one at rest", m1=1, m2=1, u1=3, u2=0, e=1))
    if _has(q, "heavy", "heavier", "mass", "bigger"):
        return ("A heavy cart hitting a light one barely slows down, and the light cart flies off at up to twice the "
                "heavy cart's speed (elastic limit)." + _try(c, "Heavy hits light", m1=10, m2=1, u1=3, u2=0, e=1))
    return (f"The collision obeys $m_1u_1 + m_2u_2 = m_1v_1 + m_2v_2$ and $v_2 - v_1 = e(u_1 - u_2)$. Solving gives "
            f"$v_1 = {_f(v1)}$ m/s and $v_2 = {_f(v2)}$ m/s. Check the momentum bars below the track stay equal.")


def atwood(q: str, c: dict) -> str:
    m1, m2, g = (_p(c, x) for x in ("m1", "m2", "g"))
    a, T = _d(c, "a"), _d(c, "T")
    if _has(q, "tension"):
        return (f"Tension is $T = \\dfrac{{2m_1m_2 g}}{{m_1+m_2}} = {_f(T)}$ N. It's **less** than the heavier weight "
                f"(${_f(max(m1, m2) * g)}$ N) — otherwise that mass couldn't accelerate down — and **more** than the "
                "lighter weight.")
    if _has(q, "equal", "same"):
        return ("With equal masses the net force is zero, so the system stays at rest (or keeps moving at constant "
                "speed if pushed)." + _try(c, "Equal masses", m1=m1, m2=m1))
    return (f"Treat both masses and the rope as one system: the net driving force is $(m_1 - m_2)g$ and the total mass "
            f"being accelerated is $m_1 + m_2$, so $a = \\dfrac{{(m_1-m_2)g}}{{m_1+m_2}} = {_f(a)}$ m/s². "
            "Notice that's much less than $g$ — the lighter mass holds the heavier back."
            + _try(c, "Make m₁ much heavier", m1=m2 * 10))


def cart_pendulum(q: str, c: dict) -> str:
    w1, w2 = _d(c, "omega_mode1"), _d(c, "omega_mode2")
    if _has(q, "energy"):
        return ("Energy moves between the springs, the cart's motion and the pendulum, but with a frictionless rail the "
                "total $\\tfrac12(M+m)\\dot x^2 + mL\\dot x\\dot\\theta\\cos\\theta + \\tfrac12 mL^2\\dot\\theta^2 + kx^2 - mgL\\cos\\theta$ "
                "stays constant — check the energy graph.")
    if _has(q, "mode", "normal", "frequenc", "pattern", "beat"):
        return (f"For small swings the motion is a mix of two **normal modes** with $\\omega_1 = {_f(w1)}$ and "
                f"$\\omega_2 = {_f(w2)}$ rad/s. When both are excited you see energy 'beat' back and forth between the "
                "cart and the pendulum." + _try(c, "Excite only the pendulum", x0=0, theta0=15))
    if _has(q, "momentum"):
        return ("Horizontal momentum is **not** conserved here: the springs push on the cart from outside the system. "
                "Without the springs ($k\\to 0$) it would be.")
    return ("The cart and pendulum push on each other: when the bob swings right it drags the cart left, and the springs "
            "pull the cart back to centre. The equations come from the Lagrangian with coordinates $x_M$ and $\\theta$:\n"
            "$$ (M+m)\\ddot x + mL\\ddot\\theta\\cos\\theta - mL\\dot\\theta^2\\sin\\theta + 2kx = 0 $$\n"
            "$$ L\\ddot\\theta + \\ddot x\\cos\\theta + g\\sin\\theta = 0 $$")


def double_pendulum(q: str, c: dict) -> str:
    sep = _d(c, "ghost_separation")
    if _has(q, "chaos", "chaotic", "ghost", "predict", "random", "butterfly", "different"):
        return ("The double pendulum is **deterministic but chaotic**: the ghost started just 0.001° away, yet the gap "
                f"grows roughly exponentially" + (f" (now {_f(sep)} m)" if sep is not None else "") +
                ". Tiny measurement errors make long-term prediction impossible, even though every step follows Newton's laws exactly.")
    if _has(q, "energy"):
        return ("There's no friction, so total energy is conserved even though the motion looks wild — the energy graph's "
                "total line stays flat. This is also a good check that the numerical integrator is accurate.")
    return ("Each rod is a rigid constraint, so the system has two degrees of freedom, $\\theta_1$ and $\\theta_2$. "
            "The coupled equations from the Lagrangian are non-linear; for large angles they produce chaos. "
            "For small angles it behaves regularly:" + _try(c, "Small angles", theta1=10, theta2=5))


def track(q: str, c: dict) -> str:
    o = c.get("options", {}) or {}
    shape, body = o.get("shape", "bowl"), o.get("body", "ball")
    m, g = _p(c, "m", 1), _p(c, "g", 9.81)
    name = {"ball": "ball", "cart": "cart", "block": "block", "point": "point mass"}.get(body, "body")
    state = (c.get("track_geometry") or {}).get("motion_state")
    if _has(q, "loop", "top", "upside", "fall off", "falls off", "stay on", "enough speed"):
        hmin, vmin, res = _d(c, "loop_h_min"), _d(c, "loop_v_top_min"), _d(c, "loop_result")
        if hmin is None:
            return ("This track has no loop, but the same idea applies on any crest: at a point where the track curves away "
                    "below the body, gravity must supply the centripetal force $mv^2/\\rho$. If $v^2/\\rho > g\\cos\\varphi$ "
                    "the track would have to *pull*, which it can't, so the body takes off. Watch the N graph drop to zero.")
        ans = ("At the top of the loop both gravity and the track push **down, towards the centre**: "
               "$$\\frac{mv_{top}^2}{R} = mg + N.$$ The track can only push ($N \\ge 0$), so the "
               f"{name} needs $v_{{top}} \\ge \\sqrt{{gR}} \\approx {_f(vmin)}$ m/s. By energy conservation that means "
               f"starting at least **{_f(hmin)} m** above the lowest point (2.5R for a sliding point mass; more for a "
               "rolling ball, because some energy goes into spin).")
        if res == "fell":
            ans += f" In this run it lost contact at a height of {_f(_d(c, 'detach_height'))} m: watch N hit zero just before."
        elif res == "completed":
            ans += f" This run made it round with $v_{{top}}$ = {_f(_d(c, 'v_top_measured'))} m/s."
        return ans + _try(c, "Start higher", H=(hmin or 10) + 2) if shape == "coaster" else ans
    if _has(q, "normal", "cos", "reaction", "heavier at the bottom", "feel heavy", "weight at the bottom"):
        nb, nbt = _d(c, "N_bottom_measured"), _d(c, "N_bottom_theory")
        return ("On a curved track N is **not** just $mg\\cos\\varphi$. Perpendicular to the track, Newton's 2nd law needs the "
                "net force to supply the centripetal acceleration: $$N - mg\\cos\\varphi = \\frac{mv^2}{\\rho}.$$ "
                f"So in a dip N is bigger than $mg\\cos\\varphi$, and over a crest it is smaller. Here mg = {_f(m * g)} N"
                + (f", but at the bottom N = {_f(nb or nbt)} N." if (nb or nbt) else ".")
                + " Plot **Normal reaction N** on the graph to watch it change with speed and curvature.")
    if _has(q, "roll", "spin", "slid", "skid", "rotat"):
        return ("A ball that **rolls without slipping** must also gain rotational energy ½Iω², so it gets less forward speed from "
                "the same drop: $$v^2 = \\frac{2g\\Delta h}{1+\\beta},\\quad \\beta = \\frac{I}{mr^2} = \\tfrac25 \\text{ (solid ball)}.$$ "
                "Rolling needs **static friction** (it does no work, so energy is still conserved). With no friction the ball can't "
                "be made to spin, so it just slides. If the slope is steep and μs is small, it skids."
                + (_try(c, "Make it slide (no friction)", mu_s=0, mu_k=0) if body == "ball" else ""))
    if _has(q, "period", "oscillat", "shm", "back and forth", "how long"):
        ts, tm = _d(c, "T_small"), _d(c, "T_measured")
        if ts:
            return ("For small oscillations a bowl acts like a pendulum whose length is the radius of the centre path (R − r): "
                    f"$$T \\approx 2\\pi\\sqrt{{\\frac{{(1+\\beta)(R-r)}}{{g}}}} = {_f(ts)}\\text{{ s}}.$$"
                    + (f" The simulation measured T = {_f(tm)} s." if tm else "")
                    + " Big releases take a little longer, because the restoring force grows more slowly than the displacement, so the motion isn't exactly SHM.")
        return "Time one full back-and-forth and compare: the period depends on the track's curvature at the bottom and on g, not on the mass."
    if _has(q, "fast", "speed", "energy", "where"):
        vb = _d(c, "v_bottom_theory")
        return ("Speed comes from energy: as the body goes down, potential energy $mgh$ turns into kinetic energy, so it is "
                "fastest at the **lowest point** and slowest at the highest. The track's shape decides *when* it gets there, "
                "but not the speed at a given height (without friction)."
                + (f" From this start, $v_{{bottom}} = {_f(vb)}$ m/s." if vb else "")
                + " Plot **Kinetic** and **Potential energy** to watch them trade off; friction and impacts make the total fall.")
    if _has(q, "friction", "stop", "slow"):
        d = _d(c, "stop_distance")
        return ("Kinetic friction $f = \\mu_k N$ acts along the track against the motion and turns kinetic energy into heat. "
                "Because N changes on curves, so does the friction force: it is largest in the dips."
                + (f" This run stopped after {_f(d)} m." if d else ""))
    return (f"The {name} is constrained to the track, so only its speed along the track, $v$, is free. Gravity's component "
            "along the slope speeds it up or slows it down, and the normal force bends its path. "
            + (f"Right now it is **{state}**. " if state else "")
            + "Turn on the **Acceleration** overlay to see the net acceleration point inwards on curves.")


HANDLERS = {
    "projectile": projectile, "pendulum": pendulum, "spring": spring, "spring_vertical": spring,
    "incline": incline, "collision": collision, "atwood": atwood,
    "cart_pendulum": cart_pendulum, "double_pendulum": double_pendulum, "track": track,
}


def prediction_feedback(c: dict) -> str | None:
    pred = c.get("prediction")
    if not pred:
        return None
    if pred.get("kind") == "choice":
        if pred.get("correct"):
            return f"✅ Correct — {pred.get('explanation', '')}"
        return (f"Not quite. You chose **{pred.get('student')}**, but the answer is **{pred.get('answer')}**. "
                f"{pred.get('explanation', '')} Run the experiment to see it for yourself.")
    student, actual, unit = pred.get("student"), pred.get("actual"), pred.get("unit", "")
    try:
        err = abs(float(student) - float(actual)) / max(abs(float(actual)), 1e-9) * 100
    except (TypeError, ValueError):
        return None
    if err < 5:
        verdict = f"Excellent — your prediction of {_f(student)} {unit} is within {err:.1f}% of the measured {_f(actual)} {unit}."
    elif err < 20:
        verdict = f"Close! You predicted {_f(student)} {unit}; the simulation measured {_f(actual)} {unit} ({err:.0f}% off)."
    else:
        verdict = f"You predicted {_f(student)} {unit}, but the simulation measured {_f(actual)} {unit} — {err:.0f}% off."
    hint = pred.get("hint")
    return verdict + (f" {hint}" if hint and err >= 5 else "")


def local_reply(messages: list[dict], context: dict) -> str:
    q = (messages[-1].get("content") or "").lower() if messages else ""
    fb = prediction_feedback(context) if context.get("prediction") and _has(q, "predict") else None
    handler = HANDLERS.get(context.get("scene"), projectile)
    body = handler(q, context)
    return f"{fb}\n\n{body}" if fb else body

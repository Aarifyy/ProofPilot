"""End-to-end UI check driven through the Chrome DevTools Protocol.

Requires the server on localhost:8000 and Google Chrome installed.
Run:  .venv\\Scripts\\python tests\\e2e_flow.py [screenshot_dir]
Exercises: prompt → simulation, numeric prediction → measured result → tutor
feedback, a tutor "try" button changing parameters, and the Equations tab.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333
BASE = os.environ.get("PROOFPILOT_URL", "http://localhost:8000")
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.gettempdir()


class CDP:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def send(self, method, **params):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    async def js(self, expr):
        r = await self.send("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"])
        return r["result"].get("value")

    async def wait(self, expr, timeout=20):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if await self.js(f"!!({expr})"):
                return True
            await asyncio.sleep(0.2)
        state = await self.js("JSON.stringify({t: proofpilot.scene.t, playing: proofpilot.playing, speed: proofpilot.speed, "
                              "measured: proofpilot.scene.measured, pending: !!proofpilot.predict.pending, errs: window.__errors, "
                              "cards: [...document.querySelectorAll('.pred')].map(c => c.dataset.id + ':' + c.querySelector('.pred-out').innerText.slice(0, 40))})")
        raise TimeoutError(f"{expr}\nstate: {state}")

    async def shot(self, name):
        r = await self.send("Page.captureScreenshot", format="png")
        path = os.path.join(OUT, f"{name}.png")
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        return path


async def main():
    prof = tempfile.mkdtemp()
    proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={prof}",
                             "--window-size=1600,1100", "--disable-gpu", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                page = next(t for t in tabs if t["type"] == "page")
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=50_000_000) as ws:
            c = CDP(ws)
            await c.send("Page.enable")
            await c.send("Runtime.enable")
            await c.send("Page.navigate", url=BASE + "/")
            await c.wait("window.proofpilot && window.proofpilot.scene")
            errors = []

            # 1. prompt → simulation
            await c.js("""(() => { const i = document.querySelector('#prompt-input');
                i.value = 'A 3 m pendulum released from 20 degrees with a 2 kg bob';
                document.querySelector('#prompt-form').requestSubmit(); })()""")
            await c.wait("proofpilot.spec.type === 'pendulum' && proofpilot.spec.params.L === 3")
            print("OK  prompt interpreted:", await c.js("JSON.stringify(proofpilot.spec.params)"))

            # 2. numeric prediction: period
            await c.js("document.querySelector('[data-tab=predict]').click()")
            await c.js("""(() => { const card = document.querySelector('.pred[data-id=period]');
                card.querySelector('input').value = '3.5';
                card.querySelector('form').requestSubmit(); })()""")
            await c.js("proofpilot.speed = 2")
            await c.wait("document.querySelector('.pred[data-id=period] .pred-result')", timeout=30)
            result = await c.js("document.querySelector('.pred[data-id=period] .pred-result').innerText")
            print("OK  prediction result:", " | ".join(result.split("\n")))
            await c.wait("document.querySelectorAll('.msg.bot').length >= 2 && !document.querySelector('.msg.streaming')", timeout=30)
            fb = await c.js("[...document.querySelectorAll('.msg.bot')].pop().innerText")
            print("OK  tutor feedback:", fb[:160].replace("\n", " "), "...")
            await c.shot("e2e_prediction")

            # 3. concept check (wrong answer) → tutor explanation + try button
            await c.js("""(() => { const card = document.querySelector('.pred[data-id=mass]');
                [...card.querySelectorAll('.pred-choice')].find(b => b.textContent === 'double').click(); })()""")
            await c.wait("document.querySelector('.pred[data-id=mass] .pred-result.bad')")
            await c.wait("!document.querySelector('.msg.streaming') && document.querySelector('.msg.bot .try-btn')", timeout=30)
            m_before = await c.js("proofpilot.spec.params.m")
            await c.js("[...document.querySelectorAll('.msg.bot .try-btn')].pop().click()")
            m_after = await c.js("proofpilot.spec.params.m")
            assert m_after != m_before, "try button did not change parameters"
            print(f"OK  tutor try-button changed m: {m_before} -> {m_after}")

            # 4. ask a free-form question
            await c.js("""(() => { document.querySelector('#tutor-input').value = 'why is the measured period longer than the formula?';
                document.querySelector('#tutor-form').requestSubmit(); })()""")
            await c.wait("!document.querySelector('.msg.streaming') && document.querySelectorAll('.msg.user').length >= 3", timeout=30)
            print("OK  free question answered:", (await c.js("[...document.querySelectorAll('.msg.bot')].pop().innerText"))[:140].replace("\n", " "))

            # 5. equations tab renders KaTeX
            await c.js("document.querySelector('[data-tab=equations]').click()")
            n = await c.js("document.querySelectorAll('#panel-equations .katex').length")
            assert n >= 3, n
            print(f"OK  equations panel: {n} KaTeX blocks")
            await c.shot("e2e_equations")

            # 6. slider changes parameter live
            await c.js("document.querySelector('[data-tab=experiment]').click()")
            await c.js("""(() => { const r = document.querySelector('.param[data-key=L] input[type=range]');
                r.value = 1; r.dispatchEvent(new Event('input')); })()""")
            assert await c.js("proofpilot.scene.p.L") == 1
            print("OK  slider rebuilt the scene with L = 1")

            # 7. general track: prompt → bowl, numeric prediction of the speed at the bottom
            await c.js("""(() => { const i = document.querySelector('#prompt-input');
                i.value = 'Drop a ball into a semicircular dish with a radius of 5 metres, with no friction';
                document.querySelector('#prompt-form').requestSubmit(); })()""")
            await c.wait("proofpilot.spec.type === 'track' && proofpilot.spec.options.shape === 'bowl'", timeout=60)
            print("OK  track prompt:", await c.js("proofpilot.spec.summary"))
            await c.js("document.querySelector('[data-tab=predict]').click()")
            theory = await c.js("proofpilot.scene.theory().vBottom")
            await c.js(f"""(() => {{ const card = document.querySelector('.pred[data-id=vbottom]');
                card.querySelector('input').value = '{theory:.2f}'; card.querySelector('form').requestSubmit(); }})()""")
            await c.wait("document.querySelector('.pred[data-id=vbottom] .pred-result')", timeout=30)
            print("OK  bowl prediction:", " | ".join((await c.js("document.querySelector('.pred[data-id=vbottom] .pred-result').innerText")).split("\n")[:3]))

            # 8. graph: hover inspector, speed ⇄ components, compare with previous run
            await c.js("document.querySelector('#graph-canvas').scrollIntoView({block: 'center'})")
            await asyncio.sleep(0.2)
            box = await c.js("JSON.stringify(document.querySelector('#graph-canvas').getBoundingClientRect())")
            b = json.loads(box)
            await c.send("Input.dispatchMouseEvent", type="mouseMoved", x=b["x"] + b["width"] * 0.5, y=b["y"] + b["height"] * 0.5)
            assert await c.js("proofpilot.graph.hoverX !== null"), "hover not registered"
            await c.send("Input.dispatchMouseEvent", type="mouseMoved", x=5, y=5)
            await c.js("document.querySelector('[data-g=vtoggle]').click()")
            assert await c.js("proofpilot.graph.selected.includes('vx') && proofpilot.graph.selected.includes('vy')"), "component toggle failed"
            await c.js("document.querySelector('[data-tab=experiment]').click()")
            await c.js("""(() => { const r = document.querySelector('.param[data-key=R] input[type=range]');
                r.value = 8; r.dispatchEvent(new Event('input')); })()""")
            assert await c.js("proofpilot.scene.info.R === 8 && !!proofpilot.graph.ghost"), "R slider / ghost failed"
            assert await c.js("!document.querySelector('[data-g=compare]').disabled"), "compare not enabled"
            print("OK  graph hover, |v|⇄components, previous-run comparison; R slider rebuilt the bowl")
            await c.shot("e2e_track_graph")

            # 9. switch shape to a loop coaster, check the loop concept check exists
            await c.js("""(() => { const s = document.querySelector('.param[data-option=shape] select'); s.value = 'coaster'; s.dispatchEvent(new Event('change')); })()""")
            await c.wait("proofpilot.scene.shape === 'coaster' && !!proofpilot.scene.loopRange")
            await c.js("document.querySelector('[data-tab=predict]').click()")
            await c.wait("document.querySelector('.pred[data-id=loop]')")
            print("OK  coaster with loop; loop prediction answer:", await c.js("proofpilot.scene.predictions().find(p => p.id === 'loop').answer"))

            # 10. function track from the equation editor
            await c.js("document.querySelector('[data-tab=experiment]').click()")
            await c.js("""(() => { const s = document.querySelector('.param[data-option=shape] select'); s.value = 'function'; s.dispatchEvent(new Event('change')); })()""")
            await c.wait("document.querySelector('.expr-input')")
            await c.js("""(() => { document.querySelector('.expr-input').value = '0.15x^2 + sin(2x)'; document.querySelector('.expr-form').requestSubmit(); })()""")
            await c.wait("proofpilot.spec.track.expr === '0.15x^2 + sin(2x)' && proofpilot.scene.shape === 'function'")
            print("OK  equation editor built y = 0.15x^2 + sin(2x); warnings:", await c.js("JSON.stringify(proofpilot.scene.warnings)"))
            await c.js("""(() => { document.querySelector('.expr-input').value = 'alert(1)'; document.querySelector('.expr-form').requestSubmit(); })()""")
            await c.wait("proofpilot.scene.shape === 'sine' && proofpilot.scene.warnings.length > 0")
            print("OK  unsafe equation rejected:", (await c.js("proofpilot.scene.warnings[0]"))[:90])

            # 11. every example chip produces a working scene
            chips = await c.js("document.querySelectorAll('#examples .chip').length")
            for i in range(chips):
                await c.js(f"document.querySelectorAll('#examples .chip')[{i}].click()")
                await c.wait("!document.querySelector('#prompt-submit').disabled && document.querySelector('#loading').hidden")
                t = await c.js("proofpilot.spec.type + ' ' + JSON.stringify(proofpilot.spec.params)")
                print(f"OK  example {i + 1}: {t}")
            errs = await c.js("window.__errors || []")
            errors.extend(errs)
            print("JS errors:", errors or "none")
    finally:
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())

"""ProofPilot web server.

Run:  python -m uvicorn server.app:app --port 8000
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from . import ai  # noqa: E402
from .catalog import load_catalog, validate_spec  # noqa: E402
from .parser import parse_prompt  # noqa: E402
from .tutor_local import local_reply  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("proofpilot")

app = FastAPI(title="ProofPilot")
STATIC = ROOT / "static"


class InterpretRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)


class ChatMessage(BaseModel):
    role: str
    content: str


class TutorRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=60)
    context: dict = Field(default_factory=dict)


def ai_enabled() -> bool:
    return ai.has_credentials() and os.environ.get("PROOFPILOT_OFFLINE") != "1"


@app.middleware("http")
async def no_cache(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/vendor/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/status")
def status():
    return {"ai": ai_enabled(), "model": ai.MODEL if ai_enabled() else None}


@app.get("/api/catalog")
def catalog():
    return load_catalog()


@app.post("/api/interpret")
def interpret(req: InterpretRequest):
    prompt = req.prompt.strip()
    if ai_enabled():
        try:
            return ai.interpret_with_claude(prompt)
        except Exception as e:  # noqa: BLE001 — any failure falls back to the offline parser
            log.warning("Claude interpretation failed, using offline parser: %s", e)
            spec = parse_prompt(prompt)
            spec["note"] = (spec.get("note") or "") + " (AI unavailable — used the offline interpreter.)"
            return spec
    return parse_prompt(prompt)


@app.post("/api/spec")
def spec(body: dict):
    """Validate a spec edited client-side (e.g. from a tutor 'try' button)."""
    return validate_spec(body)


@app.post("/api/tutor")
def tutor(req: TutorRequest):
    messages = [m.model_dump() for m in req.messages]
    context = req.context

    def offline():
        yield local_reply(messages, context)

    if not ai_enabled():
        return StreamingResponse(offline(), media_type="text/plain; charset=utf-8",
                                 headers={"X-Tutor-Source": "local"})

    def online():
        sent_any = False
        try:
            for chunk in ai.tutor_stream(messages, context):
                sent_any = True
                yield chunk
        except Exception as e:  # noqa: BLE001
            log.warning("Claude tutor failed: %s", e)
            if not sent_any:
                yield local_reply(messages, context)
                yield "\n\n*(Offline tutor — the AI service is unreachable right now.)*"
            else:
                yield "\n\n*(Connection to the tutor was interrupted.)*"

    return StreamingResponse(online(), media_type="text/plain; charset=utf-8",
                             headers={"X-Tutor-Source": "claude", "Cache-Control": "no-cache"})


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/", StaticFiles(directory=STATIC), name="static")

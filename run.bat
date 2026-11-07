@echo off
cd /d "%~dp0"
if not exist .venv (
  python -m venv .venv
  .venv\Scripts\python -m pip install -r requirements.txt
)
start "" http://localhost:8000
.venv\Scripts\python -m uvicorn server.app:app --port 8000

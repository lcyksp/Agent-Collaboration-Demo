# Tech R&D Copilot

## 1) Start Backend

```powershell
cd "D:\AI agent\Agent Collaboration Demo\backend"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Health check: `http://127.0.0.1:8000/healthz`

## 2) Start Frontend

```powershell
cd "D:\AI agent\Agent Collaboration Demo\frontend"
Copy-Item .env.local.example .env.local
npm install
npm run dev
```

Open: `http://127.0.0.1:3000`

## 3) Optional Services

- Ollama (local model): `ollama serve`
- Ensure model exists: `ollama list` (should include `gemma3:4b` and `nomic-embed-text` for RAG embedding)
- PostgreSQL + pgvector for persistent memory and RAG storage

If PostgreSQL is down, chat stream still works in degraded no-memory mode.

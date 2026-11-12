#!/bin/sh
# Starts Ollama and the search/OCR service in one container (Render private service).
# Models live on the mounted disk (/data), so they are downloaded once, not on every wake-up.
set -e
export OLLAMA_HOST=0.0.0.0:11434
export OLLAMA_MODELS="${OLLAMA_MODELS:-/data/ollama}"
export RAG_DATA="${RAG_DATA:-/data/index}"
export OLLAMA_URL=http://127.0.0.1:11434
mkdir -p "$OLLAMA_MODELS" "$RAG_DATA"

ollama serve &
for i in $(seq 1 60); do ollama list >/dev/null 2>&1 && break; sleep 1; done

# Fetch any model that isn't on the disk yet, in the background so the search service is up straight away.
(
  for m in "${EMBED_MODEL:-nomic-embed-text}" "${COPILOT_MODEL:-llama3.1:8b}"; do
    ollama list | grep -q "^$m" || ollama pull "$m"
  done
  # Load the chat model into memory now so the first question isn't slow.
  ollama run "${COPILOT_MODEL:-llama3.1:8b}" "" >/dev/null 2>&1 || true
) &

exec /opt/venv/bin/python /app/server.py

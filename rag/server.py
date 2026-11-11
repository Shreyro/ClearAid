"""
ClearAid retrieval service: FAISS vector indexes over everything recorded in
ClearAid, embedded locally with Ollama (nomic-embed-text by default).

It only stores and searches. It never decides who may see what: the ClearAid
backend builds one index per fund and audience ("f:<fund>:staff",
"f:<fund>:public") and, for every question, searches only the indexes the
signed-in person is allowed to read. Bind it to localhost.

Endpoints (JSON):
  GET  /health                         -> model, index sizes
  POST /sync    {indexes: {name: [{id, text, meta}]}, prune: bool}
  POST /search  {indexes: [name], query, k}
  POST /ocr     {data: base64, mime}  -> {text, engine}   (receipts/invoices, see ocr.py)

Run:  python rag/server.py        (env: RAG_PORT, RAG_DATA, OLLAMA_URL, EMBED_MODEL, RAG_TOKEN)
"""

import hashlib
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import faiss
import numpy as np

import ocr

PORT = int(os.environ.get("RAG_PORT", "8790"))
HOST = os.environ.get("RAG_HOST", "127.0.0.1")
DATA = os.path.abspath(os.environ.get("RAG_DATA", os.path.join(os.path.dirname(__file__), ".index")))
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
TOKEN = os.environ.get("RAG_TOKEN", "")
BATCH = 64

lock = threading.Lock()
# text hash -> unit vector. Re-syncing unchanged text costs nothing.
cache: dict[str, np.ndarray] = {}
# index name -> {"docs": [...], "index": faiss.IndexFlatIP}
indexes: dict[str, dict] = {}


def h(text: str) -> str:
    return hashlib.sha1(f"{EMBED_MODEL}\n{text}".encode("utf-8")).hexdigest()


def ollama_embed(texts: list[str]) -> np.ndarray:
    body = json.dumps({"model": EMBED_MODEL, "input": texts}).encode("utf-8")
    req = urllib.request.Request(f"{OLLAMA}/api/embed", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            out = json.loads(r.read())
    except urllib.error.URLError as e:
        raise RuntimeError(f"Ollama is not reachable at {OLLAMA} ({e}). Start Ollama and run: ollama pull {EMBED_MODEL}")
    vecs = np.asarray(out["embeddings"], dtype="float32")
    faiss.normalize_L2(vecs)  # cosine similarity via inner product
    return vecs


def embed_docs(texts: list[str]) -> list[np.ndarray]:
    """Embed only texts not seen before (nomic wants a task prefix)."""
    keys = [h(t) for t in texts]
    missing = [i for i, k in enumerate(keys) if k not in cache]
    for start in range(0, len(missing), BATCH):
        chunk = missing[start : start + BATCH]
        vecs = ollama_embed([f"search_document: {texts[i]}" for i in chunk])
        for i, v in zip(chunk, vecs):
            cache[keys[i]] = v
    return [cache[k] for k in keys], len(missing)


def build(docs: list[dict]) -> dict:
    vecs, _ = embed_docs([d["text"] for d in docs]) if docs else ([], 0)
    index = None
    if vecs:
        mat = np.vstack(vecs).astype("float32")
        index = faiss.IndexFlatIP(mat.shape[1])
        index.add(mat)
    return {"docs": docs, "index": index}


# ------------------------------------------------------------- persistence --


def save():
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "docs.json.tmp"), "w", encoding="utf-8") as f:
        json.dump({name: ix["docs"] for name, ix in indexes.items()}, f)
    os.replace(os.path.join(DATA, "docs.json.tmp"), os.path.join(DATA, "docs.json"))
    # Keep only vectors still in use.
    live = {h(d["text"]) for ix in indexes.values() for d in ix["docs"]}
    keys = [k for k in cache if k in live]
    if keys:
        np.save(os.path.join(DATA, "vectors.npy"), np.vstack([cache[k] for k in keys]))
    with open(os.path.join(DATA, "vector_keys.json"), "w", encoding="utf-8") as f:
        json.dump(keys, f)


def load():
    try:
        with open(os.path.join(DATA, "vector_keys.json"), encoding="utf-8") as f:
            keys = json.load(f)
        if keys:
            mat = np.load(os.path.join(DATA, "vectors.npy"))
            for k, v in zip(keys, mat):
                cache[k] = v.astype("float32")
        with open(os.path.join(DATA, "docs.json"), encoding="utf-8") as f:
            saved = json.load(f)
        for name, docs in saved.items():
            indexes[name] = build(docs)  # from cached vectors; no Ollama call
    except FileNotFoundError:
        pass
    except Exception as e:  # a damaged cache is rebuilt by the next sync
        print(f"[rag] could not load saved index: {e}", file=sys.stderr)


# --------------------------------------------------------------------- http --


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the caller gave up waiting (e.g. a health check timing out); nothing to do

    def _authorised(self) -> bool:
        if TOKEN and self.headers.get("X-Rag-Token") != TOKEN:
            self._send(401, {"error": "bad token"})
            return False
        return True

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def log_message(self, fmt, *args):  # quiet
        pass

    def do_GET(self):
        if not self._authorised():
            return
        if self.path == "/health":
            # No lock: a sync can hold it for minutes while it embeds, and health must still answer.
            sizes = {name: len(ix["docs"]) for name, ix in list(indexes.items())}
            return self._send(200, {"ok": True, "embedModel": EMBED_MODEL, "indexes": sizes, "vectors": len(cache), "ocr": ocr.available()})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorised():
            return
        try:
            b = self._body()
            if self.path == "/sync":
                return self._send(200, self.sync(b))
            if self.path == "/search":
                return self._send(200, self.search(b))
            if self.path == "/ocr":
                # Not under the index lock: OCR can take a few seconds and has its own.
                return self._send(200, ocr.read(str(b.get("data") or ""), str(b.get("mime") or "")))
            self._send(404, {"error": "not found"})
        except RuntimeError as e:
            self._send(503, {"error": str(e)})
        except Exception as e:
            self._send(400, {"error": f"{type(e).__name__}: {e}"})

    def sync(self, b: dict) -> dict:
        incoming: dict = b.get("indexes") or {}
        with lock:
            embedded = 0
            for name, docs in incoming.items():
                docs = [{"id": str(d["id"]), "text": str(d["text"])[:4000], "meta": d.get("meta") or {}} for d in docs]
                old = indexes.get(name)
                if old and [(d["id"], d["text"]) for d in old["docs"]] == [(d["id"], d["text"]) for d in docs]:
                    old["docs"] = docs  # same text; metadata may have changed
                    continue
                _, n = embed_docs([d["text"] for d in docs]) if docs else ([], 0)
                embedded += n
                indexes[name] = build(docs)
            removed = 0
            if b.get("prune"):
                for name in [n for n in indexes if n not in incoming]:
                    del indexes[name]
                    removed += 1
            save()
            return {"ok": True, "indexes": len(indexes), "embedded": embedded, "removed": removed}

    def search(self, b: dict) -> dict:
        names = [n for n in (b.get("indexes") or []) if isinstance(n, str)]
        query = str(b.get("query") or "").strip()
        k = max(1, min(int(b.get("k") or 10), 50))
        if not query or not names:
            return {"hits": []}
        qv = ollama_embed([f"search_query: {query}"])
        hits = []
        with lock:
            for name in names:
                ix = indexes.get(name)
                if not ix or ix["index"] is None:
                    continue
                scores, ids = ix["index"].search(qv, min(k, len(ix["docs"])))
                for s, i in zip(scores[0], ids[0]):
                    if i < 0:
                        continue
                    d = ix["docs"][i]
                    hits.append({"index": name, "id": d["id"], "text": d["text"], "meta": d["meta"], "score": float(s)})
        hits.sort(key=lambda x: x["score"], reverse=True)
        return {"hits": hits[:k]}


def main():
    load()
    print(f"[rag] FAISS {faiss.__version__} · {EMBED_MODEL} via {OLLAMA} · {len(indexes)} indexes loaded from {DATA}")
    print(f"[rag] listening on http://{HOST}:{PORT}")
    class Server(ThreadingHTTPServer):
        # Windows lets two programs bind the same port unless this is set; fail loudly instead.
        allow_reuse_address = False

        def server_bind(self):
            import socket

            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    Server((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

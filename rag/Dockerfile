# syntax=docker/dockerfile:1

# ClearAid retrieval service: FAISS indexes, embeddings from Ollama, and OCR
# for receipts and invoices (EasyOCR, PyMuPDF).
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    RAG_HOST=0.0.0.0 \
    RAG_PORT=8790 \
    RAG_DATA=/index \
    EASYOCR_MODULE_PATH=/index/easyocr
# OpenCV (pulled in by EasyOCR) needs these shared libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
# EasyOCR runs on the CPU in the container, so the much smaller CPU build of PyTorch is enough.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision \
 && pip install --no-cache-dir -r requirements.txt
COPY server.py ocr.py ./
# The embedding cache, indexes and EasyOCR's models live in /index; mount a volume to keep them
# (rebuilding them means re-embedding every record through Ollama).
RUN useradd --system --uid 10001 rag && mkdir -p /index && chown rag /index
VOLUME ["/index"]
USER rag
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request as u; r=u.Request('http://127.0.0.1:%s/health' % os.environ['RAG_PORT'], headers={'X-Rag-Token': os.environ.get('RAG_TOKEN','')}); u.urlopen(r, timeout=2)"
CMD ["python", "server.py"]

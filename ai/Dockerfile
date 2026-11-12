# syntax=docker/dockerfile:1

# ClearAid AI for Render: Ollama (the chat and embedding models) and the
# search/OCR service (rag/) in one private service, so one instance can be
# suspended when nobody is using it. Build context: the repository root.
FROM ollama/ollama:0.40.16
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    RAG_HOST=0.0.0.0 \
    RAG_PORT=8790 \
    PORT=8790 \
    EASYOCR_MODULE_PATH=/opt/easyocr \
    OCR_GPU=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY rag/requirements.txt ./
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchvision \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
# Bake EasyOCR's models into the image so receipts can be read as soon as it wakes.
RUN /opt/venv/bin/python -c "import easyocr; easyocr.Reader(['en'], gpu=False, verbose=False)"
COPY rag/server.py rag/ocr.py ./
COPY ai/start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 8790 11434
ENTRYPOINT ["/start.sh"]

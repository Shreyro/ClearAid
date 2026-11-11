"""
Local OCR for receipts and invoices, the same approach as FairShare: EasyOCR
reads the text boxes, which are put back into receipt lines (top to bottom,
left to right, corrected for a tilted photo), then cleaned of the usual OCR
slips. The ClearAid backend hands that text to the local LLM to pull out the
supplier, invoice number, date, total and line items.

PDFs with a text layer are read directly (exact, no OCR); scanned PDF pages
are rendered and OCR'd.

Optional: if EasyOCR or PyMuPDF isn't installed, `available()` says so and the
backend falls back to the vision model or manual entry.
"""

import base64
import math
import os
import re
import threading

MAX_PDF_PAGES = 5
_reader = None
_reader_lock = threading.Lock()


def available() -> dict:
    """What this machine can do, without loading any model."""
    import importlib.util

    return {
        "images": importlib.util.find_spec("easyocr") is not None,
        "pdf": importlib.util.find_spec("fitz") is not None,
    }


def _use_gpu() -> bool:
    want = os.environ.get("OCR_GPU", "auto").lower()
    if want in ("0", "false", "no", "off"):
        return False
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _get_reader():
    global _reader
    if _reader is None:
        import easyocr

        _reader = easyocr.Reader(["en"], gpu=_use_gpu(), verbose=False)
    return _reader


# ------------------------------------------------------------------ images --


def ocr_image(data: bytes) -> str:
    # EasyOCR isn't safe to run on several threads at once.
    with _reader_lock:
        results = _get_reader().readtext(data, detail=1, paragraph=False)
    if not results:
        return ""
    lines = _group_into_lines(results)
    lines = _strip_line_numbers(lines)
    lines = _strip_rupee_prefix(lines)
    return "\n".join(l for l in lines if l.strip())


def _detect_skew_angle(results: list) -> float:
    """Document rotation in radians, from the top edges of the text boxes (median; 0 if under 1° or over 30°)."""
    angles = []
    for bbox, _, _ in results:
        dx = bbox[1][0] - bbox[0][0]
        dy = bbox[1][1] - bbox[0][1]
        if abs(dx) > 20:
            angles.append(math.atan2(dy, dx))
    if len(angles) < 5:
        return 0.0
    median = sorted(angles)[len(angles) // 2]
    if abs(median) < math.radians(1.0) or abs(median) > math.radians(30.0):
        return 0.0
    return median


def _group_into_lines(results: list) -> list[str]:
    """Text boxes -> receipt lines, top to bottom, left to right, undoing a tilt so prices stay on their item's row."""
    skew = _detect_skew_angle(results)
    sin_s, cos_s = math.sin(skew), math.cos(skew)

    def y_center(r):
        bbox = r[0]
        cx = (bbox[0][0] + bbox[2][0]) / 2
        cy = (bbox[0][1] + bbox[2][1]) / 2
        return -cx * sin_s + cy * cos_s

    ordered = sorted(results, key=y_center)
    heights = [r[0][2][1] - r[0][0][1] for r in ordered]
    tolerance = (sorted(heights)[len(heights) // 2] if heights else 20) * 0.75

    groups: list[list] = []
    current = [ordered[0]]
    current_y = y_center(ordered[0])
    for item in ordered[1:]:
        y = y_center(item)
        if abs(y - current_y) <= tolerance:
            current.append(item)
            current_y = sum(y_center(r) for r in current) / len(current)
        else:
            groups.append(current)
            current, current_y = [item], y
    groups.append(current)

    lines = []
    for group in groups:
        group.sort(key=lambda r: r[0][0][0])
        lines.append(" ".join(text for _, text, _ in group))
    return lines


def _strip_line_numbers(lines: list[str]) -> list[str]:
    """Drop a leading item serial number ("12 Tarpaulin…") so it isn't read as a quantity."""
    return [re.sub(r"^\d{1,3}\s+(?=[A-Za-z])", "", line) for line in lines]


def _strip_rupee_prefix(lines: list[str]) -> list[str]:
    """EasyOCR reads "₹" as "2" (₹130 -> 2130). If most prices >= 100 start with 2, strip it."""
    num = re.compile(r"^\d+(?:\.\d+)?$")
    prices = [t for line in lines for t in (tok.replace(",", "") for tok in line.split()) if num.match(t) and float(t) >= 100]
    if len(prices) < 3 or sum(1 for t in prices if t.startswith("2")) / len(prices) < 0.70:
        return lines

    def strip(tok: str) -> str:
        t = tok.replace(",", "")
        if num.match(t) and float(t) >= 100 and t.startswith("2") and len(t) > 1:
            return t[1:]
        return tok

    return [" ".join(strip(tok) for tok in line.split()) for line in lines]


# -------------------------------------------------------------------- PDFs --


def ocr_pdf(data: bytes) -> tuple[str, str]:
    """Text of up to MAX_PDF_PAGES pages: the text layer where there is one, OCR where the page is a scan."""
    import fitz

    pages, used_ocr, used_text = [], False, False
    with fitz.open(stream=data, filetype="pdf") as doc:
        for page in list(doc)[:MAX_PDF_PAGES]:
            text = page.get_text("text").strip()
            if len(text) >= 20:
                pages.append(text)
                used_text = True
            elif available()["images"]:
                pix = page.get_pixmap(dpi=200)
                pages.append(ocr_image(pix.tobytes("png")))
                used_ocr = True
    engine = "pdf-text+ocr" if used_ocr and used_text else "ocr" if used_ocr else "pdf-text"
    return "\n\n--- PAGE BREAK ---\n\n".join(p for p in pages if p), engine


def read(b64: str, mime: str) -> dict:
    data = base64.b64decode(b64)
    caps = available()
    if mime == "application/pdf":
        if not caps["pdf"]:
            raise RuntimeError("PDF reading needs PyMuPDF (pip install pymupdf)")
        text, engine = ocr_pdf(data)
        return {"text": text, "engine": engine}
    if mime in ("image/jpeg", "image/png", "image/webp"):
        if not caps["images"]:
            raise RuntimeError("OCR needs EasyOCR (pip install easyocr)")
        return {"text": ocr_image(data), "engine": "ocr"}
    raise ValueError(f"Can't read {mime}")

"""Etapa 2 — Ler: texto por página (nativo ou OCR) e nota de qualidade.

Estados: native | ocr_good | ocr_poor | unreadable | link_only
OCR quando uma página tem menos de 50 caracteres de texto nativo (Tesseract, português).
"""
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from .common import DATA, connect, log, now

VERSION = "read-2.1"
MIN_NATIVE = 50
MAX_OCR_PAGES = int(os.environ.get("JANELA_OCR_MAX", "80"))
WORD = re.compile(r"[a-záéíóúâêôãõçà]{2,}", re.I)
COMMON = set("de da do das dos e a o que em para com por uma um na no nas nos ao aos foi pela pelo se sua seu".split())


def quality(text):
    toks = re.findall(r"\S+", text)
    if not toks:
        return 0.0
    words = [t for t in toks if WORD.fullmatch(t.strip(".,;:()«»\"'"))]
    common = sum(1 for t in toks if t.lower() in COMMON)
    return round(min(1.0, len(words) / len(toks) * 0.8 + min(0.2, common / max(1, len(toks)) * 2)), 3)


def ocr_lang():
    try:
        langs = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True).stdout.split()
    except FileNotFoundError:
        return None
    return "por" if "por" in langs else ("eng" if "eng" in langs else None)


def _tess(png, lang, psm="3"):
    env = dict(os.environ, OMP_THREAD_LIMIT="1")
    return subprocess.run(["tesseract", png, "-", "-l", lang, "--psm", psm], capture_output=True, text=True, env=env).stdout


def _ocr_image(args):
    """OCR de uma imagem. Se o texto sair mau, deteta a orientação (páginas digitalizadas ao contrário ou de lado),
    roda a imagem e tenta outra vez; fica o melhor resultado."""
    png, lang = args
    text = _tess(png, lang)
    if quality(text) >= 0.75 and len(text.strip()) > 200:
        return text
    try:
        osd = subprocess.run(["tesseract", png, "-", "--psm", "0"], capture_output=True, text=True,
                             env=dict(os.environ, OMP_THREAD_LIMIT="1")).stdout
        m = re.search(r"Rotate:\s*(\d+)", osd)
        angles = [int(m.group(1))] if m and int(m.group(1)) else []
    except (FileNotFoundError, OSError):
        angles = []
    angles += [a for a in (180, 90, 270) if a not in angles]   # se a deteção falhar, experimenta as três
    best = text
    from PIL import Image
    for a in angles:
        with Image.open(png) as im:
            rot = im.rotate(-a, expand=True)   # "Rotate: N" = rodar N graus no sentido dos ponteiros
            out = png + f".r{a}.png"
            rot.save(out)
        t = _tess(out, lang)
        try:
            os.remove(out)
        except OSError:
            pass
        if quality(t) * min(1, len(t.strip()) / 300 + .3) > quality(best) * min(1, len(best.strip()) / 300 + .3):
            best = t
        if quality(best) >= 0.8:
            break
    return best


def _render_pages(path, pages, td):
    """Página PDF -> PNG em tons de cinzento a 200 dpi (pypdfium2; não precisa do poppler)."""
    import pypdfium2 as pdfium
    jobs = []
    pdf = pdfium.PdfDocument(str(path))
    try:
        for n in pages:
            try:
                img = pdf[n - 1].render(scale=200 / 72, grayscale=True).to_pil()
                png = str(Path(td) / f"p{n}.png")
                img.save(png)
                jobs.append((n, png))
            except Exception:
                pass
    finally:
        pdf.close()
    return jobs


def ocr_pdf_pages(path, pages, lang, workers):
    """OCR das páginas pedidas (1-based). Devolve {n: texto}."""
    out = {}
    with tempfile.TemporaryDirectory() as td:
        jobs = _render_pages(path, pages, td)
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for (n, _), text in zip(jobs, ex.map(_ocr_image, [(p, lang) for _, p in jobs])):
                out[n] = text
    return out


def read_pdf(path, lang, workers):
    import pypdfium2 as pdfium
    pages = []
    try:
        pdf = pdfium.PdfDocument(str(path))
    except Exception:
        return [], "unreadable", 0
    for i in range(len(pdf)):
        try:
            t = pdf[i].get_textpage().get_text_range() or ""
        except Exception:
            t = ""
        pages.append([t.replace("\r", ""), "nativo"])
    pdf.close()
    need = [i + 1 for i, (t, _) in enumerate(pages) if len(t.strip()) < MIN_NATIVE]
    n_ocr = 0
    if need and lang:
        todo = need[:MAX_OCR_PAGES]
        for n, t in ocr_pdf_pages(path, todo, lang, workers).items():
            if len(t.strip()) > len(pages[n - 1][0].strip()):
                pages[n - 1] = [t, "ocr"]
                n_ocr += 1
    return pages, None, n_ocr


def read_html(path):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(path.read_bytes(), "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    body = soup.get_text("\n", strip=True)
    return [[f"{title}\n{body}", "nativo"]]


def read_json(path):
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return [[path.read_text(errors="ignore"), "nativo"]]
    return [[json.dumps(d, ensure_ascii=False, indent=1), "nativo"]]


def read_xlsx(path):
    try:
        import openpyxl
    except ImportError:
        return []
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    pages = []
    for ws in wb.worksheets:
        rows = ["\t".join("" if c is None else str(c) for c in row) for row in ws.iter_rows(values_only=True)]
        pages.append([f"[{ws.title}]\n" + "\n".join(r for r in rows if r.strip()), "nativo"])
    return pages


def read_docx(path):
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf8", "ignore")
    except (zipfile.BadZipFile, KeyError):
        return []
    xml = re.sub(r"</w:p>", "\n", xml)
    return [[re.sub(r"<[^>]+>", "", xml), "nativo"]]


def read_image(path, lang):
    if not lang:
        return []
    return [[_ocr_image((str(path), lang)), "ocr"]]


def read_one(con, doc, lang, workers):
    path = DATA / doc["path"] if doc["path"] else None
    ext = (doc["ext"] or "").lower()
    if doc["link_only"] or not path or not path.exists():
        return "link_only", [], 0
    if ext == ".pdf":
        pages, err, n_ocr = read_pdf(path, lang, workers)
        if err:
            return err, [], 0
    elif ext in (".html", ".htm"):
        pages, n_ocr = read_html(path), 0
    elif ext == ".json":
        pages, n_ocr = read_json(path), 0
    elif ext in (".xlsx", ".xlsm"):
        pages, n_ocr = read_xlsx(path), 0
    elif ext == ".docx":
        pages, n_ocr = read_docx(path), 0
    elif ext in (".csv", ".txt"):
        pages, n_ocr = [[path.read_text(errors="ignore"), "nativo"]], 0
    elif ext in (".jpg", ".jpeg", ".png"):
        pages = read_image(path, lang)
        n_ocr = len(pages)
    else:
        return "unreadable", [], 0
    chars = sum(len(t.strip()) for t, _ in pages)
    q = quality(" ".join(t for t, _ in pages)) if chars else 0
    if chars < (1 if ext in (".txt", ".csv", ".html", ".htm", ".json") else 40):
        state = "unreadable"
    elif n_ocr == 0:
        state = "native"
    else:
        state = "ocr_good" if q >= 0.6 else "ocr_poor"
    return state, pages, n_ocr


def run(force=False, limit=None, workers=None):
    con = connect()
    lang = ocr_lang()
    if lang != "por":
        log("AVISO: o Tesseract não tem português (por). Instale: brew install tesseract tesseract-lang (Mac)"
            if lang else "AVISO: Tesseract não instalado; páginas digitalizadas ficam sem texto.")
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    q = """SELECT d.id, d.link_only, f.path, f.ext FROM documento d LEFT JOIN ficheiro f ON f.sha256=d.sha256
           LEFT JOIN leitura l ON l.documento_id=d.id
           WHERE l.documento_id IS NULL OR l.versao != ? OR (? AND 1)"""
    docs = con.execute(q, (VERSION, int(force))).fetchall()
    if limit:
        docs = docs[:limit]
    log(f"Ler: {len(docs)} documentos (OCR: {lang or 'não disponível'}, {workers} processos)")
    for i, doc in enumerate(docs, 1):
        state, pages, n_ocr = read_one(con, doc, lang, workers)
        con.execute("DELETE FROM pagina WHERE documento_id=?", (doc["id"],))
        con.execute("DELETE FROM pagina_fts WHERE documento_id=?", (doc["id"],))
        for n, (t, method) in enumerate(pages, 1):
            con.execute("INSERT INTO pagina VALUES (?,?,?,?,?,?)", (doc["id"], n, t, method, len(t.strip()), quality(t)))
            con.execute("INSERT INTO pagina_fts VALUES (?,?,?)", (doc["id"], n, t))
        chars = sum(len(t.strip()) for t, _ in pages)
        con.execute("INSERT OR REPLACE INTO leitura VALUES (?,?,?,?,?,?,?,?)",
                    (doc["id"], state, len(pages), chars, quality(" ".join(t for t, _ in pages)) if pages else 0,
                     n_ocr, VERSION, now()))
        if i % 10 == 0:
            con.commit()
            log(f"  {i}/{len(docs)}")
    con.commit()
    stats = dict(con.execute("SELECT estado, COUNT(*) FROM leitura GROUP BY estado").fetchall())
    log(f"Ler terminado: {stats}")

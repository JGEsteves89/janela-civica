"""Coisas partilhadas: caminhos, configuração, base de dados, texto."""
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import unicodedata
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DATA = Path(os.environ.get("JANELA_DATA", ROOT / "data"))
RAW = DATA / "raw"
INBOX = DATA / "inbox"
REVIEW = DATA / "revisao"
PUBLIC = ROOT / "public"
DB_PATH = Path(os.environ.get("JANELA_DB", DATA / "janela.db"))
UA = "JanelaCivica/2.0 (projeto civico sem fins lucrativos)"  # só ASCII: firewalls bloqueiam acentos nos cabeçalhos


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def today():
    return dt.date.today()


def load_yaml(path):
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def taxonomy():
    return load_yaml(CONFIG / "taxonomia.yaml")


def autarquias():
    """Todas as receitas em config/autarquias/*.yaml, por id."""
    return {p.stem: load_yaml(p) for p in sorted((CONFIG / "autarquias").glob("*.yaml"))}


def unidades():
    """Cada 'vida' administrativa (ex.: União 2013-2025) com a autarquia a que pertence."""
    out = {}
    for aid, a in autarquias().items():
        for h in a.get("historia") or [{"id": aid, "nome": a["nome"]}]:
            out[h["id"]] = dict(h, autarquia=aid, tipo=a["tipo"])
    return out


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def short_id(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def norm(text):
    """minúsculas, sem acentos, espaços simples (para regras e comparações)."""
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", t).strip()


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", norm(text)).strip("-")[:80]


MESES = {m: i + 1 for i, m in enumerate(
    "janeiro fevereiro marco abril maio junho julho agosto setembro outubro novembro dezembro".split())}
MESES_ABR = {m[:3]: i for m, i in MESES.items()}


def parse_date(text, year_hint=None):
    """Encontra a primeira data num texto português (a que aparece mais à esquerda). Devolve date ou None."""
    t = norm(text).replace("_", " ")
    found = []
    for m in re.finditer(r"(\d{1,2})\s*(?:de\s+|\.|-|/)?\s*(%s)[a-z]*\.?\s*(?:de\s+|\.|-|/)?\s*(\d{4})" % "|".join(MESES_ABR), t):
        found.append((m.start(), int(m[3]), MESES_ABR[m[2][:3]], int(m[1])))
    for m in re.finditer(r"\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b", t):
        found.append((m.start(), int(m[1]), int(m[2]), int(m[3])))
    for m in re.finditer(r"\b(\d{1,2})[-./_ ](\d{1,2})[-./_ ](\d{4})\b", t):
        found.append((m.start(), int(m[3]), int(m[2]), int(m[1])))
    for m in re.finditer(r"(?<!\d)(\d{2})(\d{2})(20\d{2})(?!\d)", t):
        found.append((m.start(), int(m[3]), int(m[2]), int(m[1])))
    for _, y, mo, d in sorted(found):
        try:
            if 1990 <= y <= 2100:
                return dt.date(y, mo, d)
        except ValueError:
            continue
    return None


def parse_eur(s):
    """'1.234,56 €' / '1 234,56' / '1234.56' -> centimos (int) ou None."""
    if s is None:
        return None
    t = str(s).replace("€", "").replace("EUR", "").replace(" ", " ").strip()
    m = re.search(r"-?\d[\d .]*(,\d{1,2})?", t)
    if not m:
        return None
    x = m.group(0).strip()
    if "," in x:
        x = x.replace(".", "").replace(" ", "").replace(",", ".")
    else:
        parts = x.replace(" ", "").split(".")
        x = "".join(parts) if len(parts) > 1 and len(parts[-1]) == 3 else x.replace(" ", "")
    try:
        return round(float(x) * 100)
    except ValueError:
        return None


def eur(cents):
    if cents is None:
        return "?"
    return f"{cents / 100:,.2f} €".replace(",", " ").replace(".", ",")


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=None, separators=(",", ":"), default=str), encoding="utf-8")
    tmp.replace(path)


def connect():
    from .db import ensure_schema
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=60)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    ensure_schema(con)
    return con


def log(*a):
    print(dt.datetime.now().strftime("%H:%M:%S"), *a, flush=True)

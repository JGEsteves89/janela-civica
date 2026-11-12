"""Etapa 1 — Recolha. Corre todas as fontes de todas as receitas (ou só as pedidas)."""
import json
import mimetypes
import re
from pathlib import Path

from ..common import INBOX, autarquias, connect, log, now, parse_date
from .apis import run_base, run_ine, run_sgmai
from . import base_abertos
from .web import Fetcher, end_crawl, register, run_crawl, run_files_page, run_sitemap, start_crawl


def run_inbox(con, src, aut):
    """Ficheiros postos à mão em data/inbox/<pasta>/ (ex.: capturas do Facebook, documentos pedidos por LADA).
    Uma pasta dentro = uma publicação com vários ficheiros. Nomes começados por '_' ou '.' são ignorados."""
    crawl_id, t0 = start_crawl(con, src, aut)
    root = Path(src.get("pasta") and (INBOX.parent.parent / src["pasta"]) or INBOX)
    if not root.exists():
        log(f"  {src['id']}: pasta {root} não existe"); end_crawl(con, crawl_id); return
    new = 0
    for channel in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(("_", "."))):
        items = sorted(p for p in channel.iterdir() if not p.name.startswith(("_", ".")))
        for item in items:
            files = [item] if item.is_file() else sorted(x for x in item.rglob("*") if x.is_file() and not x.name.startswith(("_", ".")))
            # _fonte.json (opcional): de onde veio a cópia — {"url", "unidade", "data", "titulo", "tipo_fonte", "eleicao", "orgao"}
            info = {}
            if item.is_dir() and (item / "_fonte.json").exists():
                info = json.loads((item / "_fonte.json").read_text(encoding="utf-8"))
            d = parse_date(info.get("data") or item.name.replace("_", " "))
            for fp in files:
                mime = mimetypes.guess_type(fp.name)[0] or "application/octet-stream"
                url = info.get("url") or f"inbox://{channel.name}/{fp.relative_to(channel)}"
                meta = {"canal": channel.name, "publicacao": item.name, "tipo_fonte": info.get("tipo_fonte", "caixa")}
                meta.update({k: v for k, v in info.items() if k in ("eleicao", "orgao", "copiado_em")})
                _, n = register(con, url=url, fonte=f"caixa-{channel.name}", autarquia=aut, unidade=info.get("unidade") or src.get("unidade"),
                                content=fp.read_bytes(), mime=mime, titulo=info.get("titulo") or item.stem.replace("_", " "),
                                found_on=info.get("url") or f"inbox://{channel.name}", link_text=item.name,
                                date_hint=d.isoformat() if d else None, meta=meta, ext=fp.suffix.lower() or None)
                new += n
    end_crawl(con, crawl_id, novos=new)
    log(f"  {src['id']}: {new} ficheiros novos da caixa")


def run(only_aut=None, only_src=None, delay=1.0):
    con = connect()
    f = Fetcher(delay=delay)
    for aid, rec in autarquias().items():
        if only_aut and aid != only_aut:
            continue
        log(f"Recolha: {rec['nome']}")
        for src in rec.get("fontes", []):
            if only_src and src["id"] != only_src:
                continue
            log(f" fonte {src['id']} ({src['tipo']})")
            try:
                {"sitemap": lambda: run_sitemap(con, f, src, aid),
                 "crawl": lambda: run_crawl(con, f, src, aid),
                 "pagina_ficheiros": lambda: run_files_page(con, f, src, aid),
                 "base": lambda: run_base(con, f, src, aid),
                 "base_abertos": lambda: base_abertos.run(con, f, src, aid),
                 "sgmai": lambda: run_sgmai(con, f, src, aid),
                 "ine": lambda: run_ine(con, f, src, aid, rec),
                 "inbox": lambda: run_inbox(con, src, aid)}[src["tipo"]]()
            except KeyboardInterrupt:
                con.commit()
                raise
            except Exception as e:   # uma fonte com problemas não pára as outras
                log(f"  ERRO na fonte {src['id']}: {type(e).__name__}: {e}")
            con.commit()
    total = con.execute("SELECT COUNT(*), SUM(link_only) FROM documento").fetchone()
    log(f"Recolha terminada: {total[0]} documentos ({total[1] or 0} só com link).")

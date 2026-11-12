"""Recolha da web: descarregar com cuidado, guardar por hash, registar URL, data e texto do link."""
import email.utils
import json
import mimetypes
import re
import time
import urllib.robotparser
from collections import deque
from pathlib import Path
from urllib.parse import urljoin, urlparse, urldefrag

import requests
from bs4 import BeautifulSoup

from ..common import RAW, UA, log, norm, now, parse_date, sha256_bytes, short_id

FILE_EXT = re.compile(r"\.(pdf|docx?|xlsx?|odt|ods|csv|pptx?|jpe?g|png|zip)(\?|$)", re.I)
DOC_EXT = re.compile(r"\.(pdf|docx?|xlsx?|odt|ods|csv|pptx?|zip)(\?|$)", re.I)
UPLOAD_HINT = re.compile(r"/uploads?/|/imagens/|/document/file/|/files?/", re.I)
EXT_BY_MIME = {"application/pdf": ".pdf", "text/html": ".html", "application/json": ".json",
               "image/jpeg": ".jpg", "image/png": ".png", "text/csv": ".csv",
               "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
               "application/vnd.ms-excel": ".xls", "application/msword": ".doc",
               "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"}


class Fetcher:
    """HTTP com robots.txt, pausa por servidor e novas tentativas."""

    def __init__(self, delay=1.0, timeout=60):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "pt-PT,pt;q=0.9"})
        self.delay, self.timeout = delay, timeout
        self.robots, self.last = {}, {}
        self.exceptions = []   # exceções ao robots.txt decididas na configuração (documentos públicos obrigatórios)

    def allowed(self, url):
        if any(p.search(url) for p in self.exceptions):
            return True
        host = "{0.scheme}://{0.netloc}".format(urlparse(url))
        if host not in self.robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self.s.get(host + "/robots.txt", timeout=20)
                rp.parse(r.text.splitlines() if r.status_code == 200 else [])
            except requests.RequestException:
                rp.parse([])
            self.robots[host] = rp
        return self.robots[host].can_fetch(UA, url)

    def _wait(self, url):
        host = urlparse(url).netloc
        dt = time.time() - self.last.get(host, 0)
        if dt < self.delay:
            time.sleep(self.delay - dt)
        self.last[host] = time.time()

    def get(self, url, method="GET", **kw):
        for attempt in range(3):
            self._wait(url)
            try:
                r = self.s.request(method, url, timeout=self.timeout, **kw)
                if r.status_code in (429, 502, 503, 504):
                    time.sleep(5 * (attempt + 1))
                    continue
                return r
            except requests.RequestException as e:
                log("  erro de rede", url, type(e).__name__)
                time.sleep(3 * (attempt + 1))
        return None


def guess_ext(url, mime):
    m = FILE_EXT.search(urlparse(url).path)
    if m:
        return "." + m.group(1).lower().replace("jpeg", "jpg")
    return EXT_BY_MIME.get((mime or "").split(";")[0].strip(), mimetypes.guess_extension((mime or "").split(";")[0]) or ".bin")


def store_bytes(con, content, mime, ext):
    sha = sha256_bytes(content)
    if not con.execute("SELECT 1 FROM ficheiro WHERE sha256=?", (sha,)).fetchone():
        path = RAW / sha[:2] / (sha + ext)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        con.execute("INSERT INTO ficheiro VALUES (?,?,?,?,?,?)",
                    (sha, mime, ext, len(content), str(path.relative_to(RAW.parent)), now()))
    return sha


def register(con, *, url, fonte, autarquia, unidade, content=None, mime=None, titulo=None, found_on=None,
             link_text=None, date_hint=None, http_date=None, link_only=False, nota=None, meta=None, ext=None):
    """Regista um documento. Mesmo conteúdo (hash) = mesmo documento, mesmo com URL novo.
    Devolve (documento_id, novo?)."""
    t = now()
    if content is not None:
        sha = store_bytes(con, content, mime, ext or guess_ext(url, mime))   # ext: a extensão real do ficheiro (ex.: transcrição .txt de um PDF)
        doc_id = sha[:16]
    else:
        sha, doc_id = None, "L" + short_id(url)
    row = con.execute("SELECT id FROM documento WHERE id=?", (doc_id,)).fetchone()
    new = row is None
    if new:
        con.execute("""INSERT INTO documento (id, sha256, autarquia, unidade, fonte, titulo, url, found_on, link_text,
                       date_hint, http_date, mime, first_seen, last_seen, link_only, nota, meta)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (doc_id, sha, autarquia, unidade, fonte, (titulo or link_text or "")[:500], url, found_on,
                     (link_text or "")[:500], date_hint, http_date, mime, t, t, int(link_only), nota,
                     json.dumps(meta, ensure_ascii=False) if meta else None))
    else:
        con.execute("UPDATE documento SET last_seen=?, removed_at=NULL WHERE id=?", (t, doc_id))
        if date_hint:
            con.execute("UPDATE documento SET date_hint=COALESCE(date_hint, ?) WHERE id=?", (date_hint, doc_id))
    con.execute("""INSERT INTO url (url, documento_id, fonte, found_on, link_text, first_seen, last_seen)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(url) DO UPDATE SET documento_id=excluded.documento_id, last_seen=excluded.last_seen,
                   removed_at=NULL, link_text=COALESCE(url.link_text, excluded.link_text)""",
                (url, doc_id, fonte, found_on, (link_text or "")[:500], t, t))
    return doc_id, new


def http_date(r):
    lm = r.headers.get("Last-Modified")
    if lm:
        try:
            return email.utils.parsedate_to_datetime(lm).date().isoformat()
        except (TypeError, ValueError):
            return None
    return None


def link_context(a):
    """Texto do link + texto da linha onde está (tabela/lista), para tipo e data."""
    text = " ".join(a.get_text(" ", strip=True).split())
    row = a.find_parent(["tr", "li", "article", "p", "div"])
    ctx = " ".join(row.get_text(" ", strip=True).split())[:400] if row else ""
    return text or a.get("title") or "", ctx


def page_links(base_url, html):
    soup = BeautifulSoup(html, "html.parser")
    for bad in soup.select("script, style, nav.navbar"):
        bad.decompose()
    out = []
    for a in soup.find_all("a", href=True):
        href = urldefrag(urljoin(base_url, a["href"].strip()))[0]
        if href.startswith("http"):
            text, ctx = link_context(a)
            out.append((href, text, ctx))
    return soup, out


def download_file(con, f, *, url, fonte, autarquia, unidade, found_on, link_text, ctx):
    """Descarrega um ficheiro (ou guarda só o link se o robots.txt não deixar)."""
    known = con.execute("SELECT documento_id FROM url WHERE url=?", (url,)).fetchone()
    date_hint = parse_date(ctx) or parse_date(link_text) or parse_date(url)
    date_hint = date_hint.isoformat() if date_hint else None
    if known and f.allowed(url):   # tínhamos só o link (robots.txt) e agora há exceção: apagar o registo e descarregar
        lo = con.execute("SELECT link_only FROM documento WHERE id=?", (known[0],)).fetchone()
        if lo and lo[0]:
            for t, col in (("pagina", "documento_id"), ("pagina_fts", "documento_id"), ("leitura", "documento_id"),
                           ("classificacao", "documento_id"), ("url", "documento_id"), ("documento", "id")):
                con.execute(f"DELETE FROM {t} WHERE {col}=?", (known[0],))
            known = None
    if known:   # já temos: só marcar que continua no site
        con.execute("UPDATE url SET last_seen=?, removed_at=NULL WHERE url=?", (now(), url))
        con.execute("UPDATE documento SET last_seen=?, removed_at=NULL WHERE id=?", (now(), known[0]))
        return known[0], False
    title = link_text if len(link_text) > 3 else ctx[:200]
    if not f.allowed(url):
        return register(con, url=url, fonte=fonte, autarquia=autarquia, unidade=unidade, titulo=title,
                        found_on=found_on, link_text=link_text, date_hint=date_hint, link_only=True,
                        nota="robots.txt não permite descarregar; guardado só o título, a data e o link",
                        meta={"contexto": ctx})
    r = f.get(url)
    if r is None or r.status_code != 200 or not r.content:
        return register(con, url=url, fonte=fonte, autarquia=autarquia, unidade=unidade, titulo=title,
                        found_on=found_on, link_text=link_text, date_hint=date_hint, link_only=True,
                        nota=f"não foi possível descarregar (HTTP {getattr(r, 'status_code', 'erro')})",
                        meta={"contexto": ctx})
    return register(con, url=url, fonte=fonte, autarquia=autarquia, unidade=unidade,
                    content=r.content, mime=r.headers.get("Content-Type", ""), titulo=title,
                    found_on=found_on, link_text=link_text, date_hint=date_hint, http_date=http_date(r),
                    meta={"contexto": ctx})


def mark_removed(con, fonte, crawl_start):
    """URLs desta fonte que não foram vistos nesta recolha = desapareceram do site."""
    n = con.execute("""UPDATE url SET removed_at=? WHERE fonte=? AND removed_at IS NULL AND last_seen < ?""",
                    (now(), fonte, crawl_start)).rowcount
    con.execute("""UPDATE documento SET removed_at=? WHERE removed_at IS NULL AND id IN
                   (SELECT documento_id FROM url GROUP BY documento_id HAVING SUM(removed_at IS NULL)=0)""", (now(),))
    return n


def start_crawl(con, src, aut):
    cur = con.execute("INSERT INTO crawl (fonte, autarquia, unidade, inicio) VALUES (?,?,?,?)",
                      (src["id"], aut, src.get("unidade"), now()))
    return cur.lastrowid, now()


def end_crawl(con, crawl_id, **kw):
    sets = ", ".join(f"{k}=?" for k in kw)
    con.execute(f"UPDATE crawl SET fim=?, {sets} WHERE id=?", (now(), *kw.values(), crawl_id))
    con.commit()


def run_crawl(con, f, src, aut):
    """Percorre páginas a partir de 'inicio', segue só links permitidos e guarda todos os ficheiros."""
    crawl_id, t0 = start_crawl(con, src, aut)
    follow = [re.compile(p) for p in src.get("seguir", [])]
    f.exceptions = [re.compile(p) for p in src.get("ignorar_robots", [])]
    old_delay = f.delay
    if f.exceptions:
        f.delay = max(f.delay, float(src.get("pausa", 3)))   # devagar: cada ficheiro é lido uma só vez e guardado
        log(f"  {src['id']}: exceção ao robots.txt para {', '.join(src['ignorar_robots'])} — {src.get('motivo_excecao', '')}")
    save_pages = [re.compile(p) for p in src.get("guardar_paginas", [])]   # páginas cujo texto também é um documento
    skip_files = [re.compile(p) for p in src.get("excluir_ficheiros", [])]
    stay = src.get("ficar_em") or src["inicio"]
    hosts = {urlparse(u).netloc for u in stay + src["inicio"]}
    queue, seen = deque(src["inicio"]), set(src["inicio"])
    pages = new = errors = 0
    while queue and pages < src.get("max_paginas", 500):
        url = queue.popleft()
        if not f.allowed(url):
            continue
        r = f.get(url)
        pages += 1
        if r is None or r.status_code != 200 or "html" not in r.headers.get("Content-Type", "html"):
            errors += 1
            continue
        r.encoding = r.encoding if "charset" in r.headers.get("Content-Type", "").lower() else r.apparent_encoding
        soup, links = page_links(url, r.text)
        if any(p.search(url) for p in save_pages):
            title = soup.title.get_text(" ", strip=True) if soup.title else url
            _, is_new = register(con, url=url, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"), content=r.text.encode("utf-8"),
                                 mime="text/html", titulo=title, found_on=url, link_text=title, date_hint=None, http_date=http_date(r),
                                 meta={"pagina": True})
            new += is_new
        for href, text, ctx in links:
            con.execute("INSERT OR IGNORE INTO link_visto VALUES (?,?,?,?)", (crawl_id, href, url, text[:300]))
            if any(p.search(href) for p in skip_files):
                continue
            if urlparse(href).netloc in hosts and (DOC_EXT.search(href) or (UPLOAD_HINT.search(href) and FILE_EXT.search(href))):
                _, is_new = download_file(con, f, url=href, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"),
                                          found_on=url, link_text=text, ctx=ctx)
                new += is_new
            elif href not in seen and any(href.startswith(s) for s in stay) and (
                    not follow or any(p.search(href) for p in follow)):
                seen.add(href)
                queue.append(href)
        if pages % 20 == 0:
            con.commit()
            log(f"  {src['id']}: {pages} páginas, {new} documentos novos, {len(queue)} por ver")
    f.exceptions, f.delay = [], old_delay
    removed = mark_removed(con, src["id"], t0) if errors < max(5, pages // 5) else 0
    end_crawl(con, crawl_id, paginas=pages, novos=new, erros=errors, nota=f"{removed} links desapareceram")
    log(f"  {src['id']}: fim. {pages} páginas, {new} novos, {errors} erros, {removed} desapareceram")


def main_text(soup):
    """Texto principal de uma página WordPress/CMS (sem menus nem rodapé)."""
    for sel in ["header", "footer", "nav", "aside", "script", "style", "form", ".sidebar", ".widget", ".menu",
                ".cookie", "#cookie-notice"]:
        for el in soup.select(sel):
            el.decompose()
    main = soup.select_one("article, main, .entry-content, .post, #content, .content") or soup.body or soup
    return main


def run_sitemap(con, f, src, aut):
    """Sitemap (ex.: WordPress/Yoast): cada página é um documento; ficheiros ligados também."""
    crawl_id, t0 = start_crawl(con, src, aut)
    excl = src.get("excluir", [])
    r = f.get(src["url"])
    if r is None or r.status_code != 200:
        end_crawl(con, crawl_id, erros=1, nota="sitemap inacessível")
        log("  sitemap inacessível:", src["url"])
        return
    maps = re.findall(r"<loc>\s*([^<]+?)\s*</loc>", r.text)
    entries = []
    if "<sitemapindex" in r.text:
        for sm in maps:
            rr = f.get(sm)
            if rr is not None and rr.status_code == 200:
                for block in re.findall(r"<url>(.*?)</url>", rr.text, re.S):
                    loc = re.search(r"<loc>\s*([^<]+?)\s*</loc>", block)
                    lm = re.search(r"<lastmod>\s*([^<]+?)\s*</lastmod>", block)
                    if loc:
                        entries.append((loc.group(1), lm.group(1)[:10] if lm else None))
    else:
        entries = [(u, None) for u in maps]
    pages = new = errors = 0
    for url, lastmod in entries:
        if any(x in url for x in excl):
            continue
        con.execute("INSERT OR IGNORE INTO link_visto VALUES (?,?,?,?)", (crawl_id, url, src["url"], ""))
        known = con.execute("SELECT documento_id, last_modified FROM url WHERE url=?", (url,)).fetchone()
        if known and lastmod and known["last_modified"] == lastmod:
            con.execute("UPDATE url SET last_seen=?, removed_at=NULL WHERE url=?", (now(), url))
            con.execute("UPDATE documento SET last_seen=? WHERE id=?", (now(), known["documento_id"]))
            for (fu,) in con.execute("SELECT url FROM url WHERE found_on=?", (url,)).fetchall():
                con.execute("UPDATE url SET last_seen=?, removed_at=NULL WHERE url=?", (now(), fu))
            continue
        if not f.allowed(url):
            continue
        rr = f.get(url)
        pages += 1
        if rr is None or rr.status_code != 200:
            errors += 1
            continue
        if "html" in rr.headers.get("Content-Type", "") or rr.text.lstrip().startswith("<"):
            rr.encoding = rr.encoding if "charset" in rr.headers.get("Content-Type", "").lower() else rr.apparent_encoding
            soup, links = page_links(url, rr.text)
            title = (soup.find("meta", property="og:title") or {}).get("content") or (soup.title.string if soup.title else url)
            pub = (soup.find("meta", property="article:published_time") or {}).get("content")
            body = main_text(soup)
            html = f"<html><head><meta charset='utf-8'><title>{title}</title></head><body>{body}</body></html>".encode()
            doc_id, is_new = register(con, url=url, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"),
                                      content=html, mime="text/html", titulo=title, found_on=src["url"],
                                      link_text=title, date_hint=(pub or lastmod or "")[:10] or None,
                                      http_date=http_date(rr), meta={"lastmod": lastmod})
            new += is_new
            con.execute("UPDATE url SET last_modified=? WHERE url=?", (lastmod, url))
            host = urlparse(url).netloc
            files = [(h, t, c) for h, t, c in links if urlparse(h).netloc == host and DOC_EXT.search(h)]
            if not files:   # cartaz da atividade (imagem principal)
                og = soup.find("meta", property="og:image")
                if og and og.get("content") and "uploads" in og["content"]:
                    files = [(og["content"], f"Imagem: {title}", title)]
            for h, t, c in files:
                _, n2 = download_file(con, f, url=h, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"),
                                      found_on=url, link_text=t or title, ctx=f"{c} | {title} {pub or lastmod or ''}")
                new += n2
        if pages % 20 == 0:
            con.commit()
            log(f"  {src['id']}: {pages} páginas lidas, {new} documentos novos")
    f.exceptions, f.delay = [], old_delay
    removed = mark_removed(con, src["id"], t0) if errors < max(5, pages // 5) else 0
    end_crawl(con, crawl_id, paginas=pages, novos=new, erros=errors, nota=f"{removed} links desapareceram")
    log(f"  {src['id']}: fim. {pages} páginas, {new} novos, {errors} erros, {removed} desapareceram")


def run_files_page(con, f, src, aut):
    """Uma página com ficheiros para descarregar (ex.: DGAL, mapas do FFF)."""
    crawl_id, t0 = start_crawl(con, src, aut)
    r = f.get(src["url"])
    if r is None or r.status_code != 200:
        end_crawl(con, crawl_id, erros=1, nota="página inacessível")
        return
    _, links = page_links(src["url"], r.text)
    pats = [re.compile(p, re.I) for p in src.get("ficheiros", [r"\.pdf$"])]
    new = 0
    for href, text, ctx in links:
        con.execute("INSERT OR IGNORE INTO link_visto VALUES (?,?,?,?)", (crawl_id, href, src["url"], text[:300]))
        if any(p.search(urlparse(href).path) for p in pats):
            _, n = download_file(con, f, url=href, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"),
                                 found_on=src["url"], link_text=text, ctx=ctx)
            new += n
    end_crawl(con, crawl_id, paginas=1, novos=new)
    log(f"  {src['id']}: {new} ficheiros novos")

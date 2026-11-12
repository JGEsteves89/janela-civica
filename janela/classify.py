"""Etapa 3 — Classificar: tipo (taxonomia), período coberto, órgão, datas, número.

Regras primeiro (título, texto do link, nome do ficheiro, 1.ª página). Confiança < 0,8 vai para a fila de revisão.
PDFs com vários documentos (ex.: orçamento + GOP + mapa de pessoal) ficam com várias "partes" (intervalos de páginas).
"""
import datetime as dt
import json
import re
from urllib.parse import unquote, urlparse

from .common import autarquias, connect, log, norm, now, parse_date, taxonomy, unidades

VERSION = "classify-2.0"
NUM = re.compile(r"\b(?:acta|ata)s?\s*(?:ufaf\s*)?(?:n\.?\s*[ºo°.]?\s*|numero\s*|nr\.?\s*)?(\d{1,3})(?!\d)\s*(?:[/-]\s*(\d{4}))?", re.I)
YEAR = re.compile(r"\b(19[89]\d|20[0-4]\d)\b")
SPLIT_TYPES = ["orcamento", "gop", "mapa_pessoal", "plano_atividades", "relatorio_atividades", "prestacao_contas", "inventario"]


def compile_patterns(tax):
    return {t: [re.compile(p) for p in v.get("padroes", [])] for t, v in tax["tipos"].items()}


def match_type(text, pats, order):
    for t in order:
        for p in pats[t]:
            if p.search(text):
                return t
    return None


# Ordem: tipos mais específicos primeiro (uma "ata da assembleia" também tem a palavra "ata")
ORDER = ["resultado_eleitoral", "lista_apoios", "prestacao_contas", "informacao_escrita", "revisao_orcamental",
         "alteracao_orcamental", "gop", "orcamento", "mapa_pessoal", "procedimento_concursal", "contrato_interadministrativo",
         "protocolo", "tabela_taxas", "controlo_interno", "inventario", "relatorio_atividades", "plano_atividades",
         "pagamentos_atraso", "ata_assembleia", "edital_deliberacoes", "edital_convocatoria", "ata_junta",
         "regulamento", "aviso"]


def period_for(tipo, rule, year, ddoc):
    """Período coberto pelo documento, segundo a regra da taxonomia."""
    if rule in ("ano", "ano_seguinte", "ano_anterior") and year:
        return f"{year}-01-01", f"{year}-12-31"
    if rule in ("reuniao", "sessao", "data") and ddoc:
        return ddoc, ddoc
    if rule == "mes" and ddoc:
        d = dt.date.fromisoformat(ddoc)
        end = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
        return d.replace(day=1).isoformat(), end.isoformat()
    return (f"{year}-01-01", f"{year}-12-31") if year else (ddoc, ddoc)


def orgao_for(tipo, text, unit_type, found_on):
    t = text + " " + norm(found_on or "")
    if tipo in ("ata_assembleia", "edital_convocatoria", "informacao_escrita") or "assembleia" in t:
        return "assembleia_municipal" if unit_type == "municipio" else "assembleia_freguesia"
    if tipo in ("ata_junta", "edital_deliberacoes"):
        return "camara" if unit_type == "municipio" else "junta"
    return "camara" if unit_type == "municipio" else "junta"


def run(force=False):
    con = connect()
    tax = taxonomy()
    pats = compile_patterns(tax)
    units = unidades()
    hist_of = {aid: rec.get("historia") or [] for aid, rec in autarquias().items()}
    local_names = {u: re.compile(r"\b" + re.escape(norm(v["nome"]).replace("uniao das freguesias de ", "")) + r"\b")
                   for u, v in units.items() if v["tipo"] == "freguesia"}
    docs = con.execute("""SELECT d.*, l.estado AS leitura FROM documento d LEFT JOIN leitura l ON l.documento_id=d.id
                          WHERE ? OR d.id NOT IN (SELECT documento_id FROM classificacao WHERE versao=?)
                             OR l.quando > (SELECT MAX(c.quando) FROM classificacao c WHERE c.documento_id=d.id)""",
                       (int(force), VERSION)).fetchall()   # também quando o texto foi lido de novo (ex.: OCR)
    log(f"Classificar: {len(docs)} documentos")
    stats = {}
    for d in docs:
        meta = json.loads(d["meta"] or "{}")
        fname = unquote(urlparse(d["url"] or "").path.rsplit("/", 1)[-1])
        head = norm(f"{d['titulo']} | {d['link_text']} | {fname} | {meta.get('contexto', '')}")
        pages = con.execute("SELECT n, texto FROM pagina WHERE documento_id=? ORDER BY n", (d["id"],)).fetchall()
        first = norm(pages[0]["texto"][:1500]) if pages else ""
        full = norm(" ".join(p["texto"] for p in pages))[:200000]
        unit = units.get(d["unidade"], {})
        src = meta.get("tipo_fonte") or ""

        # 1) tipo
        conf, metodo = 0.0, "regra"
        if src == "base":
            tipo, conf = "contrato_publico", 1.0
        elif src == "sgmai":
            tipo, conf = "resultado_eleitoral", 1.0
        elif src == "ine":
            tipo, conf = "outro", 1.0
        elif (d["mime"] or "").startswith("text/html") and con.execute(
                "SELECT 1 FROM url WHERE found_on=? AND documento_id != ? LIMIT 1", (d["url"], d["id"])).fetchone():
            tipo, conf = "noticia", 0.85   # página do site que só aponta para ficheiros (o ficheiro é que conta)
        else:
            tipo = match_type(head, pats, ORDER)
            conf = 0.9 if tipo else 0
            if not tipo and first:
                tipo = match_type(first, pats, ORDER)
                conf = 0.75 if tipo else 0
            if not tipo:
                if src == "caixa":
                    tipo, conf = "publicacao_redes", 0.8
                elif (d["mime"] or "").startswith("text/html"):
                    tipo, conf = "noticia", 0.8
                elif (d["mime"] or "").startswith("image/"):
                    tipo, conf = "noticia", 0.7
                else:
                    tipo, conf = "outro", 0.3
        info = tax["tipos"][tipo]

        # 2) datas, número, período
        ddoc = parse_date(d["titulo"] or "") or parse_date(d["link_text"] or "") or parse_date(fname) or \
            (parse_date(first[:600]) if first else None)
        ddoc = ddoc.isoformat() if ddoc else (d["date_hint"] or None)
        dpub = d["http_date"] or d["date_hint"]
        m = NUM.search(head) if tipo.startswith("ata") else None
        numero = (f"{m.group(1)}/{m.group(2)}" if m and m.group(2) else (m.group(1) if m else None))
        years = [int(y) for y in YEAR.findall(head)]
        rule = info.get("periodo", "data")
        if years:
            year = max(years) if rule != "ano_anterior" else max(years)
        elif ddoc:
            y = int(ddoc[:4])
            year = y + 1 if rule == "ano_seguinte" else (y - 1 if rule == "ano_anterior" else y)
        else:
            year = None
        if rule == "ano_anterior" and not years and ddoc:
            year = int(ddoc[:4]) - 1
        p0, p1 = period_for(tipo, rule, year, ddoc)

        # 3) que freguesias o documento refere (para a ponte Câmara <-> Junta)
        refere = sorted({u for u, rx in local_names.items() if rx.search(full)}) if full else []

        reasons = []
        if conf < 0.8:
            reasons.append("tipo incerto")
        if tipo not in ("noticia", "publicacao_redes", "outro") and not (p0 or ddoc):
            reasons.append("sem data")
        if d["leitura"] in ("unreadable", "ocr_poor") and info["importancia"] >= 2:
            reasons.append("texto ilegível")
        # 4) unidade certa pela data (ex.: documento da União publicado na página da Fão antiga)
        hist = hist_of.get(d["autarquia"]) or []
        when = ddoc or dpub
        if when and str(d["fonte"]).startswith("freguesias-") and d["unidade"] in {h["id"] for h in hist}:   # só o portal partilhado
            right = next((h["id"] for h in hist if (not h.get("de") or str(h["de"]) <= when) and (not h.get("ate") or when < str(h["ate"]))), None)
            if right and right != d["unidade"]:
                con.execute("UPDATE documento SET unidade=? WHERE id=?", (right, d["id"]))
                d = dict(d); d["unidade"] = right
                unit = units.get(right, unit)
        con.execute("DELETE FROM classificacao WHERE documento_id=?", (d["id"],))
        con.execute("""INSERT INTO classificacao (documento_id, parte, pag_de, pag_ate, tipo, grupo, orgao, unidade,
                       periodo_inicio, periodo_fim, data_doc, data_publicacao, numero, confianca, metodo, versao, quando,
                       rever, motivo, refere) VALUES (?,0,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (d["id"], len(pages) or None, tipo, info["grupo"], orgao_for(tipo, head + " " + first, unit.get("tipo"), d["found_on"]),
                     d["unidade"], p0, p1, ddoc, dpub, numero, conf, metodo, VERSION, now(),
                     int(conf < 0.8 or bool(reasons and "texto ilegível" in reasons)), "; ".join(reasons) or None,
                     json.dumps(refere) if refere else None))

        # 4) partes extra (documentos previsionais num só PDF)
        if tipo in SPLIT_TYPES and len(pages) > 3:
            starts = []
            for p in pages:
                t2 = match_type(norm(p["texto"][:250]), pats, [x for x in ORDER if x in SPLIT_TYPES])
                if t2 and (not starts or starts[-1][1] != t2):
                    starts.append((p["n"], t2))
            parts = [(n, t2) for n, t2 in starts if t2 != tipo]
            for i, (n, t2) in enumerate(parts, 1):
                end = next((n2 - 1 for n2, _ in starts if n2 > n), len(pages))
                con.execute("""INSERT INTO classificacao (documento_id, parte, pag_de, pag_ate, tipo, grupo, orgao, unidade,
                               periodo_inicio, periodo_fim, data_doc, data_publicacao, confianca, metodo, versao, quando)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0.8,'regra-paginas',?,?)""",
                            (d["id"], i, n, end, t2, tax["tipos"][t2]["grupo"], "junta" if unit.get("tipo") == "freguesia" else "camara",
                             d["unidade"], p0, p1, ddoc, dpub, VERSION, now()))
        stats[tipo] = stats.get(tipo, 0) + 1
    con.commit()
    rev = con.execute("SELECT COUNT(*) FROM classificacao WHERE rever=1").fetchone()[0]
    log("Classificar terminado:", dict(sorted(stats.items(), key=lambda x: -x[1])), f"| {rev} para rever")

"""Etapa 8 — Publicar: JSON pré-calculado por autarquia + site estático em public/ + espelho dos documentos + RSS.

Regra: só se publica um facto que tenha fonte (doc_id). Alertas graves que precisam de revisão e achados da IA
só aparecem depois de aprovados.
"""
import datetime as dt
import json
import re
import shutil
from collections import defaultdict
from xml.sax.saxutils import escape

from .common import DATA, PUBLIC, ROOT, autarquias, connect, log, norm, now, taxonomy, today, unidades, write_json
from .compute import findings as findings_mod
from .compute import money as money_mod

PARTY_RX = [(r"mudan[cç]a|^m$|\(m\)", "M"), (r"fazer com alma|\bfao\b", "FAO"), (r"psd", "PSD"), (r"\bcds", "CDS"),
            (r"\bps\b|socialista", "PS"), (r"cdu|pcp", "CDU"), (r"chega|^ch$", "CH"), (r"b\.?e\.?$|bloco", "BE"),
            (r"iniciativa liberal|^il$", "IL")]


def party_key(s):
    s = (s or "").strip()
    for rx, k in PARTY_RX:
        if s and re.search(rx, s, re.I):
            return k
    return s or None


def rows(con, q, *a):
    return [dict(r) for r in con.execute(q, a)]


def mandates(con, aid, rec, tax):
    """Mandatos por unidade: datas de eleição + presidente (cargos) + resultado (eleições)."""
    elections = [e if isinstance(e, dt.date) else dt.date.fromisoformat(e) for e in tax["eleicoes"]]
    out = []
    for h in rec.get("historia") or [{"id": aid, "de": None, "ate": None}]:
        a = dt.date.fromisoformat(str(h["de"])) if h.get("de") else dt.date(2005, 10, 9)
        b = dt.date.fromisoformat(str(h["ate"])) if h.get("ate") else None
        starts = sorted({a} | {e for e in elections if a < e < (b or dt.date(2100, 1, 1))})
        for i, s in enumerate(starts):
            e = starts[i + 1] if i + 1 < len(starts) else b
            if e and e <= dt.date(2009, 1, 1):
                continue
            exec_org = "camara" if rec["tipo"] == "municipio" else "junta"
            cargos = rows(con, """SELECT c.*, p.nome FROM cargo c JOIN pessoa p ON p.id=c.pessoa_id
                                  WHERE c.autarquia=? AND c.unidade=? AND c.superseded=0
                                  AND COALESCE(c.inicio,'0000') < ? AND COALESCE(c.fim,'9999') > ?""",
                          aid, h["id"], (e or dt.date(2100, 1, 1)).isoformat(), s.isoformat())
            # cargos sem data de fim duram "para sempre": fica o que começou mais tarde dentro deste mandato
            win = (s - dt.timedelta(days=30)).isoformat()
            inside = [c for c in cargos if (c["inicio"] or "0000") >= win]
            if inside:
                cargos = inside
            cands = [c for c in cargos if re.search(r"presidente", c["funcao"] or "", re.I)
                     and (c["orgao"] or exec_org) in (exec_org, None) and not re.search(r"vice|assembleia|mesa", c["funcao"] or "", re.I)]
            pres = max(cands, key=lambda c: c["inicio"] or "0000") if cands else None
            el = rows(con, """SELECT * FROM eleicao WHERE autarquia=? AND unidade=? AND data BETWEEN ? AND ? AND superseded=0""",
                      aid, h["id"], (s - dt.timedelta(days=5)).isoformat(), (s + dt.timedelta(days=60)).isoformat())
            for x in el:
                x["listas"] = rows(con, "SELECT * FROM eleicao_lista WHERE eleicao_id=? ORDER BY votos DESC", x["id"])
                for l in x["listas"]:
                    l["partido"] = party_key(l["lista"])
            assembly = next((x for x in el if x["orgao"] in ("assembleia_freguesia", "assembleia_municipal")), None)
            exec_el = next((x for x in el if x["orgao"] == "camara"), None) or assembly
            lista = party_key(pres["lista"]) if pres and pres.get("lista") else (
                exec_el["listas"][0]["partido"] if exec_el and exec_el["listas"] else None)
            out.append({"id": f"{h['id']}:{s.isoformat()}", "unidade": h["id"], "nome_unidade": h.get("nome"),
                        "inicio": s.isoformat(), "fim": e.isoformat() if e else None,
                        "presidente": pres["nome"] if pres else None, "presidente_id": pres["pessoa_id"] if pres else None,
                        "presidente_fonte": {"doc_id": pres["doc_id"], "pagina": pres["pagina"], "excerto": pres["excerto"]} if pres else None,
                        "lista": lista, "membros": [{"pessoa_id": c["pessoa_id"], "nome": c["nome"], "funcao": c["funcao"], "orgao": c["orgao"],
                                                     "lista": party_key(c["lista"]), "inicio": c["inicio"], "fim": c["fim"],
                                                     "fonte": {"doc_id": c["doc_id"], "pagina": c["pagina"], "excerto": c["excerto"]}} for c in cargos],
                        "eleicoes": el, "assembleia": assembly})
    return out


def mirror(con, aid, docs):
    """Cópia pública dos documentos (fica disponível mesmo que a autarquia os retire)."""
    dest = PUBLIC / "arquivo"
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for d in docs:
        if not d.get("path") or not d.get("espelhar"):
            continue
        src = DATA / d["path"]
        out = dest / src.name
        if src.exists() and not out.exists():
            try:
                out.hardlink_to(src)
            except (OSError, AttributeError):
                shutil.copy2(src, out)
            n += 1
        d["espelho"] = f"arquivo/{src.name}"
    return n


def rss(aid, rec, docs, flags):
    items = sorted([("Documento: " + (d["titulo"] or ""), d["first_seen"], f"#/{'f' if rec['tipo'] == 'freguesia' else 'm'}/{aid}/doc/{d['id']}") for d in docs] +
                   [("Precisa de explicação: " + f["titulo"], f["primeira_vez"], f"#/{'f' if rec['tipo'] == 'freguesia' else 'm'}/{aid}/alerta/{f['id']}") for f in flags],
                   key=lambda x: x[1] or "", reverse=True)[:100]
    body = "".join(f"<item><title>{escape(t)}</title><link>{escape(l)}</link><pubDate>{escape(p or '')}</pubDate></item>" for t, p, l in items)
    (PUBLIC / "data" / aid / "feed.xml").write_text(
        f'<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Janela Cívica — {escape(rec["nome"])}</title>'
        f"<link>index.html</link><description>Novos documentos e alertas</description>{body}</channel></rss>", encoding="utf-8")


def run():
    con = connect()
    tax = taxonomy()
    units = unidades()
    PUBLIC.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "web", PUBLIC, dirs_exist_ok=True)
    flows_all = money_mod.run(con)
    themes_all = {aid: findings_mod.themes(con, aid) for aid in autarquias()}
    index = []
    for aid, rec in autarquias().items():
        out = PUBLIC / "data" / aid
        out.mkdir(parents=True, exist_ok=True)
        refs = set()   # documentos citados por factos (para a Câmara: espelhar só estes)

        # documentos
        docs = rows(con, """SELECT d.id, d.titulo, d.url, d.unidade, d.fonte, d.first_seen, d.last_seen, d.removed_at, d.link_only, d.nota,
                            d.date_hint, d.mime, c.tipo, c.grupo, c.orgao, c.periodo_inicio, c.periodo_fim, c.data_doc, c.data_publicacao,
                            c.numero, c.confianca, c.refere, l.estado AS leitura, l.paginas, f.path
                            FROM documento d LEFT JOIN classificacao c ON c.documento_id=d.id AND c.parte=0
                            LEFT JOIN leitura l ON l.documento_id=d.id LEFT JOIN ficheiro f ON f.sha256=d.sha256
                            WHERE d.autarquia=? OR (c.refere LIKE '%fao%' AND ?='fao')""", aid, aid)
        esperado = rows(con, "SELECT * FROM esperado WHERE autarquia=? ORDER BY ano, tipo, slot", aid)

        # factos
        reunioes = rows(con, "SELECT * FROM reuniao WHERE autarquia=? AND superseded=0 ORDER BY data", aid)
        decisoes = rows(con, """SELECT d.*, p.processo_id, p.papel, COALESCE(p.direcao, (SELECT f.direcao FROM fluxo f WHERE f.decisao_id=d.id AND f.superseded=0 ORDER BY f.direcao='saida' DESC LIMIT 1),
                                          CASE WHEN d.tipo='informacao' THEN 'estado' END) direcao
                                 FROM decisao d LEFT JOIN processo p ON p.decisao_id=d.id
                                 WHERE d.autarquia=? AND d.superseded=0 ORDER BY d.data, d.ordem""", aid)
        eventos = rows(con, "SELECT * FROM evento WHERE autarquia=? AND superseded=0 ORDER BY data", aid)
        dividas = rows(con, "SELECT * FROM divida WHERE autarquia=? AND superseded=0 ORDER BY data", aid)
        try:
            livro = [json.loads(r["json"]) for r in con.execute("""SELECT l.json FROM livro_ano l WHERE l.unidade IN
                     (SELECT DISTINCT unidade FROM documento WHERE autarquia=?) ORDER BY l.unidade, l.ano""", (aid,))]
        except Exception:
            livro = []
        presencas = rows(con, """SELECT p.*, pe.nome FROM presenca p JOIN pessoa pe ON pe.id=p.pessoa_id
                                 JOIN reuniao r ON r.id=p.reuniao_id WHERE r.autarquia=? AND p.superseded=0""", aid)
        votacoes = rows(con, """SELECT v.*, pe.nome FROM votacao v JOIN pessoa pe ON pe.id=v.pessoa_id
                                JOIN decisao d ON d.id=v.decisao_id WHERE d.autarquia=? AND v.superseded=0""", aid)
        cargos = rows(con, """SELECT c.*, p.nome FROM cargo c JOIN pessoa p ON p.id=c.pessoa_id WHERE c.autarquia=? AND c.superseded=0""", aid)
        pessoas_ids = {c["pessoa_id"] for c in cargos} | {p["pessoa_id"] for p in presencas} | {v["pessoa_id"] for v in votacoes}
        pessoas = [dict(r, aliases=json.loads(r["aliases"] or "[]")) for r in rows(con, "SELECT * FROM pessoa") if r["id"] in pessoas_ids]
        flows = [f for f in flows_all[aid]]
        contratos = rows(con, "SELECT * FROM contrato WHERE autarquia=?", aid)
        apoios = rows(con, "SELECT * FROM apoio WHERE autarquia=? AND superseded=0", aid)
        beneficios = rows(con, "SELECT * FROM beneficio WHERE autarquia=? AND superseded=0", aid)
        saldos = rows(con, "SELECT * FROM saldo WHERE autarquia=? AND superseded=0 ORDER BY data", aid)
        linhas = rows(con, "SELECT * FROM linha_orcamental WHERE autarquia=? AND superseded=0", aid)
        mencoes = rows(con, "SELECT * FROM mencao WHERE autarquia=? AND superseded=0", aid)
        instrumentos = rows(con, """SELECT * FROM instrumento WHERE superseded=0 AND (unidade IN (SELECT ?) OR municipio=? OR
                                    lower(freguesia) LIKE '%fão%' OR lower(freguesia) LIKE '%fao%')""", aid, aid)
        obras = rows(con, "SELECT * FROM obra WHERE autarquia=? AND superseded=0", aid)
        estimativas = rows(con, "SELECT * FROM estimativa WHERE autarquia=?", aid)
        ent_ids = {x.get("entidade_id") for x in flows + apoios + beneficios + mencoes} | {c["fornecedor_id"] for c in contratos}
        entidades = [dict(r, aliases=json.loads(r["aliases"] or "[]")) for r in rows(con, "SELECT * FROM entidade") if r["id"] in ent_ids]
        flags = rows(con, """SELECT * FROM flag WHERE autarquia=? AND ativo=1 AND estado NOT IN ('descartado','por_rever')
                             ORDER BY severidade DESC, periodo_inicio DESC""", aid)
        for f in flags:
            f["alvo"], f["evidencia"] = json.loads(f["alvo"] or "{}"), json.loads(f["evidencia"] or "[]")
        achados = rows(con, "SELECT * FROM finding WHERE autarquia=? AND estado='publicado' ORDER BY importancia DESC", aid)
        for a in achados:
            a["flags"], a["documentos"] = json.loads(a["flags"] or "[]"), json.loads(a["documentos"] or "[]")
        pedidos = rows(con, "SELECT * FROM pedido_lada WHERE autarquia=? AND estado != 'rascunho'", aid)
        score = defaultdict(dict)
        for s in rows(con, "SELECT * FROM score WHERE autarquia=?", aid):
            score[s["ano"]][s["dimensao"]] = s["valor"]

        for coll in (reunioes, decisoes, presencas, votacoes, cargos, flows, apoios, beneficios, saldos, linhas, mencoes, instrumentos, obras, dividas):
            for x in coll:
                if x.get("doc_id"):
                    refs.add(x["doc_id"])
        for d in docs:
            d["espelhar"] = d["unidade"] in {u for u, v in units.items() if v["autarquia"] == "fao"} or d["id"] in refs or aid == "fao"
            d["refere"] = json.loads(d["refere"] or "[]")
        n_mirror = mirror(con, aid, docs)
        tdir = out / "texto"
        tdir.mkdir(exist_ok=True)
        for d in docs:   # texto das páginas (para realçar a frase de onde veio cada valor)
            if d.get("espelhar") and not (tdir / f"{d['id']}.json").exists():
                pages = rows(con, "SELECT n, texto FROM pagina WHERE documento_id=? ORDER BY n", d["id"])
                if pages:
                    write_json(tdir / f"{d['id']}.json", {"id": d["id"], "paginas": pages})
        for d in docs:
            d.pop("path", None)
            d.pop("espelhar", None)

        mand = mandates(con, aid, rec, tax)
        base = {"id": aid, "tipo": rec["tipo"], "nome": rec["nome"], "municipio": rec.get("municipio"), "freguesias": rec.get("freguesias", []),
                "nif": rec.get("nif"), "dicofre": rec.get("dicofre"), "geo": rec.get("geo"), "historia": rec.get("historia"),
                "partidos": rec.get("partidos", {}), "populacao": rec.get("populacao") or {},
                "mandatos": mand, "score": score, "taxonomia": {"grupos": tax["grupos"], "tipos": {k: {x: v[x] for x in ("nome", "grupo", "importancia", "cadencia")}
                                                                                                for k, v in tax["tipos"].items()}},
                "gerado": now(), "contagens": {"documentos": len(docs), "esperados": len(esperado), "reunioes": len(reunioes),
                                               "decisoes": len(decisoes), "alertas": len(flags), "contratos": len(contratos)},
                "temas": themes_all[aid]}
        write_json(out / "base.json", base)
        write_json(out / "documentos.json", {"documentos": docs, "esperado": esperado})
        write_json(out / "reunioes.json", {"reunioes": reunioes, "decisoes": decisoes, "presencas": presencas, "votacoes": votacoes, "eventos": eventos})
        write_json(out / "pessoas.json", {"pessoas": pessoas, "cargos": cargos})
        write_json(out / "entidades.json", {"entidades": entidades})
        write_json(out / "dinheiro.json", {"fluxos": flows, "contratos": contratos, "apoios": apoios, "beneficios": beneficios,
                                           "saldos": saldos, "linhas": linhas, "mencoes": mencoes, "instrumentos": instrumentos,
                                           "estimativas": estimativas, "dividas": dividas, "livro": livro})
        write_json(out / "obras.json", {"obras": obras})
        write_json(out / "alertas.json", {"alertas": flags, "achados": achados, "pedidos": pedidos})
        rss(aid, rec, docs, flags)
        last = max([y for y in score if score[y].get("total") is not None] or [None]) if score else None
        index.append({"id": aid, "tipo": rec["tipo"], "nome": rec["nome"], "municipio": rec.get("municipio"),
                      "score": score.get(last, {}).get("total") if last else None, "ano_score": last,
                      "documentos": len(docs), "alertas": len(flags)})
        log(f"Publicar {aid}: {len(docs)} documentos ({n_mirror} copiados para o arquivo), {len(flows)} fluxos, {len(flags)} alertas")
    write_json(PUBLIC / "data" / "index.json", {"autarquias": index, "gerado": now()})
    con.execute("INSERT INTO changelog VALUES (?,?,?,?)", ("*", now(), "publicacao", f"{len(index)} autarquias publicadas"))
    con.commit()
    log(f"Site em {PUBLIC}. Para ver: python3 -m http.server -d public 8000")

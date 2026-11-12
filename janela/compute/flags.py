"""Alertas por regras (requisitos 03 §7). Na interface chamam-se "precisa de explicação".

O id de um alerta é estável (regra + alvo + período), por isso o estado e a resposta da autarquia sobrevivem a novos cálculos.
"""
import datetime as dt
import json
import re
from collections import defaultdict

from ..common import autarquias, eur, log, norm, now, short_id, taxonomy

THRESH_AJUSTE = {"obras": 30000_00, "outros": 20000_00}   # limites do ajuste direto (CCP)
SEV3_NEED_REVIEW = {"F07", "F13", "F18", "F21"}            # só publicados depois de revistos por uma pessoa


MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]


def dpt(d):
    """2026-10-07 → 7 out 2026"""
    try:
        return f"{int(d[8:10])} {MES[int(d[5:7]) - 1]} {d[:4]}"
    except (TypeError, ValueError, IndexError):
        return d or "data desconhecida"


def sc(t):
    """MAIÚSCULAS → frase normal ("LOCAÇÃO DE TENDAS" → "Locação de tendas")."""
    t = str(t or "").strip()
    letters = [ch for ch in t if ch.isalpha()]
    if letters and sum(ch.isupper() for ch in letters) / len(letters) > 0.7:
        t = t.lower()
        t = t[:1].upper() + t[1:]
    return t


class Flags:
    def __init__(self, con, aid):
        self.con, self.aid, self.seen = con, aid, set()

    def add(self, regra, sev, titulo, texto, alvo, p0=None, p1=None, evid=None, unidade=None):
        key = {k: v for k, v in alvo.items() if k != "estado"}   # o estado muda; o id não pode mudar
        fid = "fl-" + short_id(regra, self.aid, json.dumps(key, sort_keys=True), p0, p1)
        self.seen.add(fid)
        row = self.con.execute("SELECT id FROM flag WHERE id=?", (fid,)).fetchone()
        if row:
            self.con.execute("""UPDATE flag SET severidade=?, titulo=?, texto=?, alvo=?, evidencia=?, ultima_vez=?, ativo=1 WHERE id=?""",
                             (sev, titulo, texto, json.dumps(alvo, ensure_ascii=False), json.dumps(evid or [], ensure_ascii=False), now(), fid))
        else:
            self.con.execute("""INSERT INTO flag (id, regra, severidade, autarquia, unidade, alvo, periodo_inicio, periodo_fim, titulo,
                                texto, evidencia, estado, primeira_vez, ultima_vez, ativo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                             (fid, regra, sev, self.aid, unidade, json.dumps(alvo, ensure_ascii=False), p0, p1, titulo, texto,
                              json.dumps(evid or [], ensure_ascii=False),
                              "por_rever" if (regra in SEV3_NEED_REVIEW) else "aberto", now(), now()))
            if regra in SEV3_NEED_REVIEW:
                self.con.execute("INSERT OR IGNORE INTO revisao (id, item_tipo, item_id, prioridade, motivo) VALUES (?,?,?,?,?)",
                                 ("rv-" + fid, "alerta", fid, 1, f"{regra}: {titulo}"))


def run(con):
    tax = taxonomy()
    names = {k: v["nome"] for k, v in tax["tipos"].items()}
    imp = {k: v["importancia"] for k, v in tax["tipos"].items()}
    for aid in autarquias():
        F = Flags(con, aid)
        # F01/F02/F03/F04 — documentos esperados (agrupados por unidade, ano e tipo)
        groups = defaultdict(list)
        for r in con.execute("SELECT * FROM esperado WHERE autarquia=?", (aid,)):
            groups[(r["unidade"], r["ano"], r["tipo"], r["estado"])].append(r)
        for (unit, y, tipo, state), items in groups.items():
            slots = ", ".join(i["slot"] for i in items)
            nome = names.get(tipo, tipo)
            if state in ("not_found_yet", "missing"):
                rule, sev = ("F01", 3) if imp.get(tipo, 1) >= 3 else ("F02", 2)
                n = len(items)
                if state == "missing":
                    texto = (f"«{nome}» de {y}: não existe ou não foi entregue, depois de um pedido formal." if n == 1 else
                             f"«{nome}» de {y}: faltam {n} ({slots}), depois de um pedido formal.")
                else:
                    texto = (f"Não encontrámos «{nome}» de {y}." if n == 1 else f"Não encontrámos {n} documentos «{nome}» de {y} ({slots}).")
                motivo = (items[0]["motivo"] or "").strip()
                F.add(rule, sev, f"{nome} {y} — " + ("em falta" if n == 1 else f"{n} em falta"),
                      f"{texto} {motivo[:1].upper() + motivo[1:]}".strip(),
                      {"tipo": tipo, "ano": y, "esperados": [i["id"] for i in items], "estado": state}, f"{y}-01-01", f"{y}-12-31",
                      [{"esperado": i["id"]} for i in items], unit)
            elif state in ("present_unreadable", "present_no_numbers"):
                docs = sum((json.loads(i["documentos"] or "[]") for i in items), [])
                what = "ilegível (digitalizado sem texto)" if state == "present_unreadable" else "sem os valores que devia ter"
                F.add("F03", 2, f"{nome} {y}: publicado mas {what}", f"O documento existe, mas está {what}.",
                      {"tipo": tipo, "ano": y}, f"{y}-01-01", f"{y}-12-31", [{"doc_id": d} for d in docs], unit)
            elif state == "late":
                docs = sum((json.loads(i["documentos"] or "[]") for i in items), [])
                F.add("F04", 1, f"{nome} {y}: publicado fora do prazo", f"Publicado depois da data esperada ({items[0]['devido_ate'] or 'prazo legal'}).",
                      {"tipo": tipo, "ano": y}, f"{y}-01-01", f"{y}-12-31", [{"doc_id": d} for d in docs], unit)

        # Documento retirado do site
        for d in con.execute("SELECT id, titulo, removed_at, unidade FROM documento WHERE autarquia=? AND removed_at IS NOT NULL", (aid,)):
            F.add("F00", 1, f"Documento retirado do site: {d['titulo'][:80]}",
                  "Este documento estava no site da autarquia e deixou de estar. Guardámos uma cópia.",
                  {"doc": d["id"]}, d["removed_at"][:10], d["removed_at"][:10], [{"doc_id": d["id"]}], d["unidade"])

        # F05 — executado vs previsto (> 25%) por categoria/linha
        lines = con.execute("""SELECT ano, lado, codigo, rotulo, SUM(previsto) p, SUM(executado) e, MIN(doc_id) doc FROM linha_orcamental
                               WHERE autarquia=? AND superseded=0 GROUP BY ano, lado, codigo""", (aid,)).fetchall()
        for l in lines:
            if l["p"] and l["e"] is not None and l["p"] > 5000_00 and abs(l["e"] - l["p"]) / l["p"] > 0.25:
                F.add("F05", 2, f"{l['ano']}: {l['rotulo'][:60]} — executado longe do previsto",
                      f"Previsto {eur(l['p'])}, executado {eur(l['e'])} ({(l['e'] - l['p']) / l['p']:+.0%}).",
                      {"linha": l["codigo"], "lado": l["lado"]}, f"{l['ano']}-01-01", f"{l['ano']}-12-31", [{"doc_id": l["doc"]}])

        # F08 — decisão com dinheiro mas sem valor escrito
        for d in con.execute("""SELECT id, data, assunto, doc_id, pagina, excerto, unidade FROM decisao WHERE autarquia=? AND superseded=0
                                AND tem_dinheiro=1 AND valor_cent IS NULL""", (aid,)):
            F.add("F08", 2, f"Decisão sem valor: {d['assunto'][:70]}", "A decisão envolve dinheiro, mas a ata não diz quanto.",
                  {"decisao": d["id"]}, d["data"], d["data"], [{"doc_id": d["doc_id"], "pagina": d["pagina"], "excerto": d["excerto"]}], d["unidade"])

        # F09 — contrato sem decisão numa ata (só onde há atas desse mês)
        months_with_atas = {r[0] for r in con.execute("SELECT DISTINCT substr(data,1,7) FROM reuniao WHERE autarquia=? AND superseded=0 AND ata_doc IS NOT NULL", (aid,))}
        contracts = con.execute("""SELECT c.*, COALESCE(e.nome, c.fornecedor) fornecedor_nome FROM contrato c
                                   LEFT JOIN entidade e ON e.id=c.fornecedor_id WHERE c.autarquia=?""", (aid,)).fetchall()
        for c in contracts:
            if c["decisao_id"] is None and c["data_assinatura"] and c["data_assinatura"][:7] in months_with_atas:
                F.add("F09", 2, f"Contrato sem decisão encontrada: {sc(c['objeto'])[:70]}",
                      f"Contrato com {c['fornecedor_nome']} ({eur(c['preco_contratual'])}), assinado a {dpt(c['data_assinatura'])}, está no Portal BASE, mas não encontrámos a decisão nas atas publicadas.",
                      {"contrato": c["id"]}, c["data_assinatura"], c["data_assinatura"], [{"contrato": c["id"]}], c["unidade"])

        # F10 — apoios sem regulamento de apoios publicado
        has_reg = con.execute("""SELECT COUNT(*) FROM classificacao c JOIN documento d ON d.id=c.documento_id WHERE d.autarquia=?
                                 AND c.tipo='regulamento' AND (lower(d.titulo) LIKE '%apoio%' OR lower(d.titulo) LIKE '%subsid%')""", (aid,)).fetchone()[0]
        apoios = con.execute("SELECT * FROM apoio WHERE autarquia=? AND superseded=0", (aid,)).fetchall()
        if apoios and not has_reg:
            years = sorted({a["ano"] for a in apoios if a["ano"]})
            for y in years:
                F.add("F10", 2, f"{y}: apoios sem regulamento publicado", "Foram dados apoios, mas não encontrámos um regulamento com os critérios.",
                      {"ano": y}, f"{y}-01-01", f"{y}-12-31", [{"doc_id": a["doc_id"]} for a in apoios if a["ano"] == y][:5])

        # F11 / F20 — concentração e mudanças bruscas nos apoios
        by_year = defaultdict(lambda: defaultdict(int))
        for a in apoios:
            if a["ano"] and a["valor_cent"] and a["entidade_id"]:
                by_year[a["ano"]][a["entidade_id"]] += a["valor_cent"]
        ename = {r["id"]: r["nome"] for r in con.execute("SELECT id, nome FROM entidade")}
        for y, ents in by_year.items():
            tot = sum(ents.values())
            for e, v in ents.items():
                prev = by_year.get(y - 1, {}).get(e)
                if tot > 10000_00 and v / tot > 0.30 and len(ents) >= 3:
                    F.add("F11", 2, f"{y}: {ename.get(e, e)} recebe {v / tot:.0%} dos apoios", f"{eur(v)} de {eur(tot)} no ano.",
                          {"entidade": e, "ano": y}, f"{y}-01-01", f"{y}-12-31")
                if prev and v > 2 * prev and v - prev > 5000_00:
                    F.add("F11", 2, f"{y}: apoios a {ename.get(e, e)} mais do que duplicaram", f"{eur(prev)} em {y - 1} → {eur(v)} em {y}.",
                          {"entidade": e, "ano": y, "crescimento": True}, f"{y}-01-01", f"{y}-12-31")
        ys = sorted(by_year)
        for i, y in enumerate(ys[1:-1], 1):
            for e, v in by_year[ys[i - 1]].items():
                if e not in by_year[y] and v > 5000_00 and all(e not in by_year[z] for z in ys[i:]):
                    F.add("F20", 2, f"{ename.get(e, e)}: apoios param em {y}", f"Recebeu {eur(v)} em {ys[i - 1]} e deixa de aparecer nas listas.",
                          {"entidade": e, "ano": y}, f"{y}-01-01", f"{y}-12-31")

        # F12–F17 — contratos públicos
        cy = defaultdict(list)
        for c in contracts:
            if c["data_assinatura"]:
                cy[c["data_assinatura"][:4]].append(c)
        for y, cs in cy.items():
            tot = sum(c["preco_contratual"] or 0 for c in cs)
            sup = defaultdict(int)
            for c in cs:
                sup[c["fornecedor_nome"]] += c["preco_contratual"] or 0
            for s, v in sup.items():
                if len(cs) >= 3 and tot and v / tot > 0.40:
                    F.add("F12", 2, f"{y}: {s} ganha {v / tot:.0%} do valor dos contratos", f"{eur(v)} de {eur(tot)}.",
                          {"fornecedor": s, "ano": y}, f"{y}-01-01", f"{y}-12-31")
            non_open = sum(c["preco_contratual"] or 0 for c in cs if not re.search(r"concurso p[uú]blico", c["procedimento"] or "", re.I))
            if tot > 50000_00 and non_open / tot > 0.9:
                F.add("F17", 1, f"{y}: {non_open / tot:.0%} do valor sem concurso público", "Quase todo o valor contratado foi por ajuste direto ou consulta prévia.",
                      {"ano": y}, f"{y}-01-01", f"{y}-12-31")
        for c in contracts:
            if c["n_concorrentes"] == 1 and re.search(r"concurso|consulta", c["procedimento"] or "", re.I):
                F.add("F14", 1, f"Só um concorrente: {sc(c['objeto'])[:70]}", f"Procedimento {c['procedimento']} com um único concorrente.",
                      {"contrato": c["id"]}, c["data_assinatura"], c["data_assinatura"], [{"contrato": c["id"]}])
            if c["preco_base"] and c["preco_contratual"] and c["preco_contratual"] >= 0.98 * c["preco_base"]:
                F.add("F15", 1, f"Preço igual ao preço base: {sc(c['objeto'])[:70]}", f"{eur(c['preco_contratual'])} para um preço base de {eur(c['preco_base'])}.",
                      {"contrato": c["id"]}, c["data_assinatura"], c["data_assinatura"], [{"contrato": c["id"]}])
            if c["preco_efetivo"] and c["preco_contratual"] and c["preco_efetivo"] > 1.10 * c["preco_contratual"]:
                F.add("F16", 2, f"Contrato subiu mais de 10%: {sc(c['objeto'])[:70]}", f"{eur(c['preco_contratual'])} → {eur(c['preco_efetivo'])}.",
                      {"contrato": c["id"]}, c["data_assinatura"], c["data_assinatura"], [{"contrato": c["id"]}])
        bysup = defaultdict(list)
        for c in contracts:
            if c["data_assinatura"] and re.search(r"ajuste|consulta", c["procedimento"] or "", re.I):
                bysup[c["fornecedor_nome"]].append(c)
        for s, cs in bysup.items():
            cs.sort(key=lambda c: c["data_assinatura"])
            for i in range(len(cs)):
                group = [c for c in cs[i:] if (dt.date.fromisoformat(c["data_assinatura"]) - dt.date.fromisoformat(cs[i]["data_assinatura"])).days < 90]
                limit = THRESH_AJUSTE["obras" if (group[0]["cpv"] or "").startswith("45") else "outros"]
                if len(group) >= 3 and all((c["preco_contratual"] or 0) < limit for c in group) and sum(c["preco_contratual"] or 0 for c in group) > limit:
                    F.add("F13", 3, f"Possível divisão de contratos: {s}",
                          f"{len(group)} contratos com {s} em menos de 90 dias, cada um abaixo do limite do ajuste direto, somando {eur(sum(c['preco_contratual'] or 0 for c in group))}.",
                          {"fornecedor": s, "contratos": [c["id"] for c in group]}, group[0]["data_assinatura"], group[-1]["data_assinatura"],
                          [{"contrato": c["id"]} for c in group])
                    break

        # F19 — faltas > 30% (mínimo 5 reuniões)
        for p in con.execute("""SELECT p.pessoa_id, pe.nome, COUNT(*) n, SUM(p.estado='ausente') a, MIN(r.data) d0, MAX(r.data) d1
                                FROM presenca p JOIN reuniao r ON r.id=p.reuniao_id JOIN pessoa pe ON pe.id=p.pessoa_id
                                WHERE r.autarquia=? AND p.superseded=0 GROUP BY p.pessoa_id""", (aid,)):
            if p["n"] >= 5 and p["a"] / p["n"] > 0.30:
                F.add("F19", 1, f"{p['nome']} faltou a {p['a']} de {p['n']} reuniões", "Faltas acima de 30% das reuniões com presenças registadas.",
                      {"pessoa": p["pessoa_id"]}, p["d0"], p["d1"])

        # F21 — Câmara diz que enviou ≠ Junta diz que recebeu
        inst = con.execute("SELECT * FROM instrumento WHERE superseded=0 AND (freguesia LIKE '%Fão%' OR freguesia LIKE '%Fao%' OR unidade IN (SELECT ?))", (aid,)).fetchall()
        pair = defaultdict(lambda: {"camara": 0, "junta": 0, "docs": []})
        for i in inst:
            k = (i["ano"], norm(i["tarefa"] or i["tipo"] or "")[:20])
            pair[k][i["lado"]] += i["valor_cent"] or 0
            pair[k]["docs"].append({"doc_id": i["doc_id"], "pagina": i["pagina"], "excerto": i["excerto"]})
        if aid == "fao":
            for (y, t), v in pair.items():
                if v["camara"] and v["junta"] and abs(v["camara"] - v["junta"]) > 0.05 * max(v["camara"], v["junta"]):
                    F.add("F21", 3, f"{y}: Câmara e Junta dão valores diferentes ({t})", f"Câmara: {eur(v['camara'])}; Junta: {eur(v['junta'])}.",
                          {"ano": y, "tarefa": t}, f"{y}-01-01", f"{y}-12-31", v["docs"])

        # F24 — sessão extraordinária convocada com menos de 2 dias úteis
        for r in con.execute("""SELECT r.id, r.data, r.orgao, d.date_hint pub, r.edital_doc FROM reuniao r JOIN documento d ON d.id=r.edital_doc
                                WHERE r.autarquia=? AND r.tipo='extraordinaria' AND r.superseded=0""", (aid,)):
            if r["pub"] and r["data"] and r["pub"] < r["data"]:
                days = sum(1 for k in range((dt.date.fromisoformat(r["data"]) - dt.date.fromisoformat(r["pub"])).days)
                           if (dt.date.fromisoformat(r["pub"]) + dt.timedelta(days=k + 1)).weekday() < 5)
                if days < 2:
                    F.add("F24", 2, f"Sessão extraordinária de {r['data']} anunciada com {days} dia(s) útil(eis)",
                          "A lei pede pelo menos 2 dias úteis de antecedência.", {"reuniao": r["id"]}, r["data"], r["data"], [{"doc_id": r["edital_doc"]}])

        con.execute(f"UPDATE flag SET ativo=0 WHERE autarquia=? AND id NOT IN ({','.join('?' * len(F.seen)) or 'NULL'})", (aid, *F.seen))
        n = con.execute("SELECT severidade, COUNT(*) FROM flag WHERE autarquia=? AND ativo=1 GROUP BY severidade", (aid,)).fetchall()
        log(f"  alertas {aid}: " + ", ".join(f"gravidade {s}: {c}" for s, c in n))
    con.commit()

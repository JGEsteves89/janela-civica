"""Dinheiro: fluxos com nível de confiança, estimativas e agregados (requisitos 03 §3).

Níveis: known (lido no documento) | derived (conta feita com valores conhecidos) | estimated (método com pressupostos)
        | unknown (sabemos que houve dinheiro, não sabemos quanto) | absent (sem informação nenhuma).
Agregados guardam sempre os quatro números {known, derived, estimated, unknown} — nunca um só.
"""
import datetime as dt
import json
from collections import defaultdict

from ..common import autarquias, log, short_id

ORIGIN_OF_CAT = {"transferencias_estado": "estado", "transferencias_municipio": "municipio", "fundos_europeus": "ue",
                 "taxas": "freguesia", "vendas": "freguesia", "rendas": "freguesia", "emprestimos": "banco"}


def D(s):
    return dt.date.fromisoformat(s[:10]) if s else None


def flows(con, aid):
    """Fluxos publicáveis (com fonte) + derivados dos saldos."""
    rows = [dict(r) for r in con.execute("SELECT * FROM fluxo WHERE autarquia=? AND superseded=0 AND doc_id IS NOT NULL", (aid,))]
    for r in rows:
        r["nivel"] = r["nivel"] or ("known" if r["valor_cent"] is not None else "unknown")
    # derivado: o que saiu entre dois saldos = saldo anterior + entradas − saldo novo
    saldos = con.execute("""SELECT unidade, data, SUM(valor_cent) v, GROUP_CONCAT(doc_id) docs FROM saldo
                            WHERE autarquia=? AND superseded=0 GROUP BY unidade, data ORDER BY unidade, data""", (aid,)).fetchall()
    by_unit = defaultdict(list)
    for s in saldos:
        by_unit[s["unidade"]].append(s)
    for unit, ss in by_unit.items():
        for a, b in zip(ss, ss[1:]):
            when = lambda r: r["data"] or r["periodo_fim"]
            real = lambda r: r["nivel"] == "known" and r["tipo_valor"] in ("pago", "executado", None) and when(r) \
                and a["data"] < when(r) <= b["data"]     # só dinheiro que mexeu mesmo (nunca orçamentos)
            ins = sum(r["valor_cent"] or 0 for r in rows if r["unidade"] == unit and r["direcao"] == "entrada" and real(r))
            outs = sum(r["valor_cent"] or 0 for r in rows if r["unidade"] == unit and r["direcao"] == "saida" and real(r))
            spent = a["v"] + ins - b["v"]
            gap = spent - outs
            if gap > 0:
                rows.append(dict(id="fd-" + short_id(unit, a["data"], b["data"]), autarquia=aid, unidade=unit, direcao="saida",
                                 valor_cent=gap, data=None, periodo_inicio=a["data"], periodo_fim=b["data"], granularidade="period",
                                 origem="freguesia", destino="desconhecido", entidade_id=None, categoria="desconhecida",
                                 instrumento="diferenca_saldos", nivel="derived", tipo_valor="pago",
                                 descricao=f"Saiu do banco e não está explicado nos documentos (saldo {a['data']} → {b['data']})",
                                 doc_id=(b["docs"] or "").split(",")[0], pagina=None,
                                 excerto=f"saldo anterior + entradas conhecidas − saldo novo − saídas explicadas"))
    return rows


def estimates(con, aid, rows):
    """Regras públicas (metodologia): FFF em 12 partes iguais; contratos espalhados pela duração (na agregação)."""
    con.execute("DELETE FROM estimativa WHERE autarquia=?", (aid,))
    out = []
    fff = [r for r in rows if r["direcao"] == "entrada" and r["nivel"] == "known" and r["data"]
           and ((r["categoria"] or "") == "transferencias_estado" or "fff" in (r["descricao"] or "").lower()
                or "fff" in (r["instrumento"] or "").lower())]
    by_unit = defaultdict(list)
    for r in fff:
        by_unit[r["unidade"]].append(r)
    for unit, items in by_unit.items():
        months_known = {r["data"][:7] for r in items}
        monthly = sorted(r["valor_cent"] for r in items)[len(items) // 2]
        first = min(r["data"] for r in items)[:7]
        last = max(r["data"] for r in items)[:7]
        y, m = int(first[:4]), int(first[5:7])
        while f"{y}-{m:02d}" <= last:
            ym = f"{y}-{m:02d}"
            if ym not in months_known:
                eid = "fe-" + short_id(unit, ym)
                start = f"{ym}-01"
                end = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1)).isoformat()
                out.append(dict(id=eid, autarquia=aid, unidade=unit, direcao="entrada", valor_cent=monthly, data=None,
                                periodo_inicio=start, periodo_fim=end, granularidade="month", origem="estado", destino="freguesia",
                                entidade_id=None, categoria="transferencias_estado", instrumento="FFF", nivel="estimated",
                                tipo_valor="pago", descricao="FFF do mês (estimado: o Estado paga o FFF em 12 partes iguais)",
                                doc_id=items[0]["doc_id"], pagina=items[0]["pagina"], excerto=items[0]["excerto"]))
                con.execute("INSERT OR REPLACE INTO estimativa VALUES (?,?,?,?,?,?,?,?)",
                            (eid, aid, f"fluxo FFF {ym}", "FFF em 12 partes iguais",
                             json.dumps({"mensal_conhecido": monthly, "meses_com_valor": sorted(months_known)}),
                             "estimated", "O FFF é pago em duodécimos (DGAL). Usámos o valor mensal conhecido.", monthly))
            y, m = (y + (m == 12), m % 12 + 1)
    return out


def bucket_keys(start, end, gran):
    """Chaves de período (ano/trimestre/mês) que um intervalo cobre, com a fração de cada uma."""
    a, b = D(start), D(end) or D(start)
    if not a:
        return []
    if b < a:
        b = a
    days = (b - a).days + 1
    keys = defaultdict(int)
    d = a
    while d <= b:
        k = str(d.year) if gran == "year" else (f"{d.year}-T{(d.month - 1) // 3 + 1}" if gran == "quarter" else f"{d.year}-{d.month:02d}")
        keys[k] += 1
        d += dt.timedelta(days=1)
    return [(k, n / days) for k, n in keys.items()]


def aggregate(rows, gran, by=None):
    """{periodo: {direcao: {grupo: {known, derived, estimated, unknown_n, unknown_expected}}}}"""
    out = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: {"known": 0, "derived": 0, "estimated": 0,
                                                                       "unknown_n": 0, "planned": 0})))
    for r in rows:
        start = r["periodo_inicio"] or r["data"]
        end = r["periodo_fim"] or r["data"] or start
        if not start:
            continue
        g = r.get(by) or "?" if by else "total"
        if by == "origem" and r["direcao"] == "saida":
            g = r.get("origem") or "?"
        parts = bucket_keys(start, end, gran)
        for k, frac in parts:
            cell = out[k][r["direcao"]][g]
            if r["tipo_valor"] == "previsto":
                cell["planned"] += round((r["valor_cent"] or 0) * frac)
                continue
            if r["nivel"] == "unknown" or r["valor_cent"] is None:
                cell["unknown_n"] += 1 if frac == max(f for _, f in parts) else 0
                continue
            level = r["nivel"]
            if level == "known" and len(parts) > 1:
                level = "estimated"   # valor anual espalhado por meses/trimestres = estimativa
            cell[level] += round(r["valor_cent"] * frac)
    return {k: {d: dict(v2) for d, v2 in v.items()} for k, v in sorted(out.items())}


def run(con):
    result = {}
    for aid in autarquias():
        rows = flows(con, aid)
        rows += estimates(con, aid, rows)
        # anos com contas publicadas: o total anual manda; os movimentos das atas ficam como detalhe (não se somam outra vez)
        def annual(r):   # total de um ano inteiro (contas, ou uma ata que resume o ano)
            a, b = r.get("periodo_inicio") or "", r.get("periodo_fim") or ""
            return r.get("instrumento") == "prestacao_contas" or (
                a[5:10] == "01-01" and b[5:10] == "12-31" and a[:4] == b[:4] and r.get("tipo_valor") in ("executado", "pago") and r.get("nivel") == "known")
        covered = {}
        for r in rows:
            if annual(r) and r.get("valor_cent"):
                k = (r["unidade"], (r["periodo_inicio"] or "")[:4], r["direcao"])
                covered.setdefault(k, r["id"])
        for r in rows:
            y = (r.get("periodo_inicio") or r.get("data") or "")[:4]
            k = (r["unidade"], y, r["direcao"])
            if k in covered and r.get("tipo_valor") != "previsto" and not (annual(r) and covered[k] == r["id"]) and not (
                    r.get("instrumento") == "prestacao_contas"):
                r["coberto"] = 1
        # o mesmo valor contado duas vezes (duas atas, ou ata + contrato do BASE): fica um, o resto é detalhe
        rank = {"contrato_publico": 0, "prestacao_contas": 0}
        live = sorted((r for r in rows if not r.get("coberto") and r.get("valor_cent") and r.get("tipo_valor") != "previsto"),
                      key=lambda r: (rank.get(r.get("instrumento"), 1), r.get("data") or r.get("periodo_inicio") or ""))
        kept = []
        for r in live:
            d = dt.date.fromisoformat((r.get("data") or r.get("periodo_inicio"))[:10])
            def same(x):
                if x["unidade"] != r["unidade"] or x["direcao"] != r["direcao"] or x["valor_cent"] != r["valor_cent"] or x.get("doc_id") == r.get("doc_id"):
                    return False
                dx = dt.date.fromisoformat((x.get("data") or x.get("periodo_inicio"))[:10])
                if "contrato_publico" in (x.get("instrumento"), r.get("instrumento")):
                    return abs((dx - d).days) <= 90          # contrato do BASE e a adjudicação na ata
                return (dx.year, dx.month) == (d.year, d.month)   # duas atas a falar do mesmo pagamento (o FFF mensal repete-se, não é duplicado)
            dup = next((x for x in kept if same(x)), None)
            if dup:
                r["coberto"] = 1
            else:
                kept.append(r)
        result[aid] = rows
        log(f"  dinheiro {aid}: {len(rows)} fluxos ({sum(1 for r in rows if r['nivel'] == 'unknown')} sem valor)")
    con.commit()
    return result

"""Verificação das regras de qualidade dos dados (REGRAS.md). Corre sempre no fim de `calcular`.

Cada regra é genérica: vale para qualquer autarquia e para qualquer correção futura.
Quando a correção é segura, a regra corrige sozinha; quando não é, manda para a fila de revisão.
"""
import datetime as dt
import json

from .common import log, now, short_id
from .resolve import is_entity_name

FACT_TABLES = ("reuniao", "decisao", "fluxo", "saldo", "evento", "cargo", "divida")
MAX_VALOR = 100_000_000_00   # 100 M€: acima disto numa freguesia/município é quase de certeza um erro de leitura


def _review(con, kind, item, motivo, prio=2):
    con.execute("INSERT OR IGNORE INTO revisao (id, item_tipo, item_id, prioridade, motivo) VALUES (?,?,?,?,?)",
                ("rv-" + short_id("regra", kind, item), kind, item, prio, motivo))


def r1_campo_certo(con):
    """R1 — Cada campo só aceita o tipo certo: uma entidade é uma organização ou pessoa,
    nunca um documento, um evento, um total ou a própria autarquia. Corrige sozinha."""
    bad = [e["id"] for e in con.execute("SELECT id, nome FROM entidade").fetchall() if not is_entity_name(e["nome"])]
    for t, col in (("fluxo", "entidade_id"), ("apoio", "entidade_id"), ("beneficio", "entidade_id"),
                   ("mencao", "entidade_id"), ("contrato", "fornecedor_id")):
        for eid in bad:
            con.execute(f"UPDATE {t} SET {col}=NULL WHERE {col}=?", (eid,))
    for eid in bad:
        con.execute("DELETE FROM entidade WHERE id=?", (eid,))
    return len(bad)


def r2_emprestimo(con):
    """R2 — Previsto não é gasto; empréstimo não é receita; pagar um empréstimo não é despesa nova. Corrige sozinha."""
    import re
    n = 0
    rx = re.compile(r"(pagamento|liquida|amortiza|reembolso).*empr[eé]stimo|empr[eé]stimo.*(pago|liquidado|amortizado)", re.I)
    for f in con.execute("SELECT id, descricao FROM fluxo WHERE categoria='juros_divida' AND direcao='saida'").fetchall():
        if rx.search(f["descricao"] or "") and not re.search(r"juro", f["descricao"] or "", re.I):
            con.execute("UPDATE fluxo SET categoria='amortizacao' WHERE id=?", (f["id"],))
            n += 1
    return n


STATE = r"por (liquidar|pagar|receber)|em d[ií]vida|d[íi]vidas?\b|pendentes?|a receber|cau[cç][aã]o|valor(es)? em falta"
MOVE = r"libert|transferi|recebeu|recebid|foi pag|foram pag|pagou|devolvid|cobrad|arrecad|liquidou|liquidad|prestação no corrente"


def r8_estado_nao_e_movimento(con):
    """R8 — Estado não é movimento: "faturas por liquidar", "em dívida", "recebimentos pendentes", saldos…
    descrevem o estado das contas num dia. Não entram nem saem dinheiro: passam para a tabela `divida`
    (o que se deve ou o que falta receber) e saem dos movimentos. Corrige sozinha."""
    import re
    st, mv = re.compile(STATE, re.I), re.compile(MOVE, re.I)
    n = 0

    def to_debt(aut, unit, date, direcao, valor, credor, descr, prov):
        if valor and con.execute("SELECT 1 FROM divida WHERE autarquia=? AND valor_cent=? AND superseded=0 AND abs(julianday(data)-julianday(?))<=60",
                                 (aut, valor, date)).fetchone():
            return   # já registada (ex.: pela leitura dos empréstimos e dívidas)
        con.execute("""INSERT OR REPLACE INTO divida (id, autarquia, unidade, data, tipo, valor_cent, credor, estado, descricao, doc_id, pagina,
                       excerto, metodo, extrator, versao, confianca, superseded, criado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    ("dv-r8-" + short_id(prov["doc_id"], valor, descr), aut, unit, date, "divida" if direcao == "saida" else "a_receber", valor, credor,
                     "em_divida" if direcao == "saida" else "pendente", descr, prov["doc_id"], prov["pagina"], prov["excerto"],
                     "regra", "regra", "R8", 0.7, 0, now()))

    # 1. movimentos que afinal são estados
    for f in con.execute("""SELECT f.*, d.data dd FROM fluxo f LEFT JOIN decisao d ON d.id=f.decisao_id
                            WHERE f.superseded=0 AND f.extrator='ia'""").fetchall():
        txt = f"{f['descricao'] or ''} {f['excerto'] or ''}"
        strong = re.search(r"por (liquidar|pagar|receber)|pendente", txt, re.I)
        if st.search(txt) and not mv.search(txt) and (strong or f["tipo_valor"] in ("previsto", "comprometido")):
            to_debt(f["autarquia"], f["unidade"], f["data"] or f["dd"] or f["periodo_inicio"], f["direcao"], f["valor_cent"], None, f["descricao"], f)
            con.execute("UPDATE fluxo SET superseded=1 WHERE id=?", (f["id"],))
            n += 1
    # 2. decisões de informação cujo valor é um estado (sem movimento com esse valor)
    for d in con.execute("""SELECT * FROM decisao d WHERE superseded=0 AND tipo='informacao' AND valor_cent > 0 AND NOT EXISTS
                            (SELECT 1 FROM fluxo f WHERE f.decisao_id=d.id AND f.superseded=0 AND abs(f.valor_cent - d.valor_cent) <= d.valor_cent / 100)""").fetchall():
        txt = f"{d['assunto'] or ''} {d['excerto'] or ''}"
        if st.search(d["excerto"] or "") and not mv.search(txt):
            to_debt(d["autarquia"], d["unidade"], d["data"], "saida" if re.search(r"liquidar|pagar|d[íi]vida|cau", d["excerto"], re.I) else "entrada",
                    d["valor_cent"], None, d["assunto"], d)
            n += 1
    return n


def r4_uma_identidade(con):
    """R4 — Um nome, uma identidade: o mesmo NIF é sempre a mesma entidade; todas têm aliases. Corrige sozinha."""
    n = 0
    for nif, ids in con.execute("""SELECT nif, GROUP_CONCAT(id) FROM entidade WHERE nif IS NOT NULL
                                   AND id NOT IN (SELECT de FROM entidade_merge) GROUP BY nif HAVING COUNT(*) > 1""").fetchall():
        keep, *rest = ids.split(",")
        for r in rest:
            con.execute("INSERT OR IGNORE INTO entidade_merge VALUES (?,?,?,?,?)", (r, keep, "regra R4", now(), f"mesmo NIF {nif}"))
            n += 1
    for e in con.execute("SELECT id, nome, aliases FROM entidade").fetchall():
        al = set(json.loads(e["aliases"] or "[]")) | ({e["nome"]} if e["nome"] else set())
        con.execute("UPDATE entidade SET aliases=? WHERE id=?", (json.dumps(sorted(al), ensure_ascii=False), e["id"]))
    return n


def r5_plausivel(con):
    """R5 — Datas e valores têm de ser possíveis (data entre 1990 e daqui a 2 anos; valor ≥ 0 e < 100 M€). Vai para revisão."""
    hi = (dt.date.today() + dt.timedelta(days=730)).isoformat()
    n = 0
    for t in FACT_TABLES:
        col = {"cargo": "inicio"}.get(t, "data")
        for r in con.execute(f"SELECT id, {col} d FROM {t} WHERE {col} IS NOT NULL AND ({col} < '1990' OR {col} > ?)", (hi,)).fetchall():
            _review(con, "regra_R5", f"{t}:{r['id']}", f"Data impossível em {t}: {r['d']}")
            n += 1
    for r in con.execute("SELECT id, valor_cent FROM fluxo WHERE valor_cent < 0 OR valor_cent > ?", (MAX_VALOR,)).fetchall():
        _review(con, "regra_R5", f"fluxo:{r['id']}", f"Valor impossível: {r['valor_cent'] / 100:,.2f} €")
        n += 1
    return n


def run(con):
    res = {"R1 entidades falsas removidas": r1_campo_certo(con),
           "R2 pagamentos de empréstimo separados": r2_emprestimo(con),
           "R8 estados tirados dos movimentos": r8_estado_nao_e_movimento(con),
           "R4 entidades juntadas por NIF": r4_uma_identidade(con),
           "R5 datas/valores para rever": r5_plausivel(con)}
    con.commit()
    log("Verificação das regras:", ", ".join(f"{k}: {v}" for k, v in res.items()))
    return res

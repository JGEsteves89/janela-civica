"""Livro do ano: refazer a contabilidade de cada ano e fazê-la bater com as contas oficiais.

Três peças:
- contas do ano (âncora): saldo inicial, entradas, saídas, saldo final e totais por categoria (prestação de contas);
- menções (data/revisao/ia/mencoes/<doc>.json): cada vez que um documento fala de dinheiro, com a fase;
- transações: um movimento real de dinheiro, uma só vez, ligado a todas as menções que falam dele (muitos-para-muitos).

Regras de ligação (R3 — um facto conta uma vez):
- só "pago"/"recebido" criam dinheiro que mexeu; as outras fases (aprovado, adjudicado, faturado, pedido) são provas
  ligadas à transação, ou ficam como "compromisso sem pagamento visto";
- duas menções são o mesmo dinheiro quando: mesma direção, valor igual (±1%), mesma coisa (objeto/contraparte)
  e datas próximas (pagamentos: até 45 dias; compromissos → pagamento: até 400 dias), ou quando o texto o diz (mesmo_que);
- "previsto" e "estado" nunca são movimentos (R2, R8).
A diferença entre as contas e o que encontrámos aparece POR CATEGORIA e só depois de verificar duplicados.
"""
import json
import re
from datetime import date

from ..common import DATA, log, norm, short_id

MENCOES = DATA / "revisao" / "ia" / "mencoes"
CASH = {"pago", "recebido"}
CAT = {"transferencias_estado": "Transferências do Estado", "transferencias_municipio": "Transferências do Município", "fundos_europeus": "Fundos europeus",
       "taxas": "Taxas e licenças", "vendas": "Venda de bens e serviços", "rendas": "Rendas", "emprestimos": "Empréstimos", "outras_receitas": "Outras receitas",
       "pessoal": "Pessoal", "bens_servicos": "Bens e serviços", "apoios": "Apoios a entidades", "obras": "Obras e investimento",
       "juros_divida": "Juros e dívida", "amortizacao": "Pagamento de empréstimos", "outras_despesas": "Outras despesas"}
COMMIT = {"pedido", "aprovado", "adjudicado", "faturado"}
VAZIAS = set("""de da do das dos e a o para com sem em no na nos nas ao aos pelo pela por um uma valor total pagamento
recebimento verba apoio despesa receita parcela prestacao mensal junta freguesia uniao""".split())


def num(s):
    s = re.sub(r"[ .](?=\d{3}(\D|$))", "", s.strip())
    return round(float(s.replace(",", ".")) * 100)


NUM = r"(-?\d+(?:[ .]\d{3})*,\d{2})"
LABELS = {"saldo_inicial": r"ger[eêâa]ncia anterior", "receita_total": r"receita total(?:\s*\[\d+\]\s*\+?)*",
          "despesa_total": r"despesa total(?:\s*\[\d+\]\s*\+?)*", "saldo_final": r"ger[eêâa]ncia seguinte",
          "receita_passivos": r"receita com passivos financeiros", "despesa_passivos": r"despesa com passivos financeiros"}


def contas_ano(con, unit, year):
    """Lê os totais da Demonstração do Desempenho Orçamental (prestação de contas). Devolve None se não houver."""
    doc = con.execute("""SELECT d.id FROM documento d JOIN classificacao c ON c.documento_id=d.id AND c.parte=0
                         WHERE d.unidade=? AND c.tipo='prestacao_contas' AND EXISTS (SELECT 1 FROM pagina p WHERE p.documento_id=d.id
                         AND p.texto LIKE ?) ORDER BY d.id""", (unit, f"%{year}-01-01 a {year}-12-31%")).fetchone()
    if not doc:
        return None
    out = {"doc_id": doc["id"], "fontes": {}}
    for p in con.execute("SELECT n, texto FROM pagina WHERE documento_id=? ORDER BY n", (doc["id"],)):
        t = re.sub(r"\s+", " ", p["texto"] or "")
        if p["n"] > 15:   # a Demonstração do Desempenho Orçamental está nas primeiras páginas
            break
        for k, lab in LABELS.items():
            if k in out:
                continue
            m = re.search(lab + r"\s*(?:\[[^\]]*\]\s*)?" + NUM, t, re.I)
            if m:
                out[k] = num(m.group(1))
                out["fontes"][k] = {"pagina": p["n"], "excerto": t[m.start():m.end()][:200]}
    if not {"saldo_inicial", "receita_total", "despesa_total", "saldo_final"} <= out.keys():
        return None
    out["entradas"] = out["receita_total"] - out["saldo_inicial"]   # a receita total das contas inclui o saldo anterior
    out["saidas"] = out["despesa_total"]
    out["bate"] = abs(out["saldo_inicial"] + out["entradas"] - out["saidas"] - out["saldo_final"]) <= 100
    cats = {}
    for f in con.execute("""SELECT direcao, categoria, SUM(valor_cent) v FROM fluxo WHERE unidade=? AND instrumento='prestacao_contas'
                            AND superseded=0 AND periodo_inicio LIKE ? GROUP BY 1, 2""", (unit, f"{year}%")):
        cats[f"{f['direcao']}:{f['categoria']}"] = f["v"]
    if out.get("receita_passivos"):
        cats["entrada:emprestimos"] = cats.get("entrada:emprestimos", 0) + out["receita_passivos"]
    if out.get("despesa_passivos"):
        cats["saida:amortizacao"] = cats.get("saida:amortizacao", 0) + out["despesa_passivos"]
    out["categorias"] = cats
    return out


def words(m):
    return {w for w in re.findall(r"[a-z0-9]{3,}", norm(f"{m.get('objeto') or ''} {m.get('contraparte') or ''}")) if w not in VAZIAS}


def days(a, b):
    return abs((date.fromisoformat(a[:10]) - date.fromisoformat(b[:10])).days)


def same(a, b, window):
    if a["direcao"] != b["direcao"] or not a.get("valor") or not b.get("valor"):
        return False
    hi, lo = max(a["valor"], b["valor"]), min(a["valor"], b["valor"])
    if not (hi - lo <= 0.01 * hi or any(abs(hi - lo * f) <= 0.01 * hi for f in (1.23, 1.13, 1.06))):   # com e sem IVA
        return False
    if days(a["data"], b["data"]) > window:
        return False
    return bool(words(a) & words(b))


def load_mentions(con, unit):
    out = []
    for path in sorted(MENCOES.glob("*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        doc = con.execute("""SELECT d.unidade, c.data_doc, c.tipo FROM documento d LEFT JOIN classificacao c ON c.documento_id=d.id AND c.parte=0
                             WHERE d.id=?""", (d["doc_id"],)).fetchone()
        if not doc or doc["unidade"] != unit:
            continue
        for i, m in enumerate(d.get("mencoes") or []):
            m = dict(m, doc_id=d["doc_id"], id=f"{d['doc_id']}:{i}", doc_data=doc["data_doc"], doc_tipo=doc["tipo"])
            m["data"] = m.get("data") or doc["data_doc"]
            if m["data"]:
                out.append(m)
    # contratos do Portal BASE: prova de compromisso ("adjudicado") ligada ao pagamento, se houver
    for c in con.execute("SELECT id, fornecedor, objeto, preco_contratual, data_assinatura, raw FROM contrato WHERE unidade=? AND preco_contratual > 0", (unit,)):
        if not c["data_assinatura"]:
            continue
        out.append({"id": "base:" + c["id"], "doc_id": None, "contrato_id": c["id"], "pagina": None, "excerto": f"Contrato no Portal BASE: {c['objeto'] or ''}"[:300],
                    "fase": "adjudicado", "data": c["data_assinatura"], "valor": c["preco_contratual"] / 100, "direcao": "saida",
                    "contraparte": c["fornecedor"], "objeto": c["objeto"], "categoria": "bens_servicos"})
    return out


def ledger(con, unit, year):
    ms = load_mentions(con, unit)
    cash = sorted([m for m in ms if m.get("fase") in CASH and m.get("valor")], key=lambda m: m["data"])
    tx = []
    # 1. pagamentos/recebimentos: o mesmo dinheiro contado em vários documentos fica uma só transação
    for m in cash:
        t = next((t for t in tx if same(t["m"][0], m, 45) and m["doc_id"] not in {x["doc_id"] for x in t["m"]}), None)
        if t:
            t["m"].append(m)
        else:
            tx.append({"m": [m]})
    # 2. compromissos (aprovado, adjudicado, faturado, pedido) ligados ao pagamento que os cumpre
    loose = []
    for m in ms:   # orçamentos e planos são sempre previsão (R2), mesmo que "aprovados"
        if re.search(r"or[cç]amento|plano|gop|ppi", norm(m.get("objeto") or "")):
            m["fase"] = "previsto"
        # a mesma categoria que as contas oficiais usam: Segurança Social, descontos e salários são "pessoal"
        if m.get("direcao") == "saida" and re.search(r"seguranca social|contribuic|descontos|salari|subsidio de ferias|subsidio de natal|cga\b",
                                                      norm(f"{m.get('objeto') or ''} {m.get('contraparte') or ''}")):
            m["categoria"] = "pessoal"
    for m in [m for m in ms if m.get("fase") in COMMIT and m.get("valor")]:
        t = next((t for t in tx if same(t["m"][0], m, 400) and m["data"] <= t["m"][0]["data"]), None)
        (t["m"].append(m) if t else loose.append(m))
    # 3. transações do ano
    rows = []
    for t in tx:
        first = t["m"][0]
        if not first["data"].startswith(str(year)):
            continue
        cash_docs = [x for x in t["m"] if x.get("fase") in CASH]
        rows.append({"id": "t-" + short_id(unit, first["id"]), "data": first["data"], "direcao": first["direcao"],
                     "valor_cent": round(first["valor"] * 100), "categoria": first.get("categoria") or "desconhecida",
                     "contraparte": first.get("contraparte"), "objeto": first.get("objeto"),
                     "duplicado": len(cash_docs) > 1,
                     "mencoes": [{k: x.get(k) for k in ("doc_id", "contrato_id", "pagina", "excerto", "fase", "data", "valor", "parcela", "mesmo_que")} for x in t["m"]]})
    commits = [{k: m.get(k) for k in ("doc_id", "contrato_id", "pagina", "excerto", "fase", "data", "valor", "direcao", "objeto", "contraparte", "categoria")}
               for m in loose if m["data"].startswith(str(year))]
    return rows, commits, [m for m in ms if m.get("fase") == "estado" and m["data"].startswith(str(year))]


def reconcile(contas, rows):
    found = {}
    for r in rows:
        k = f"{r['direcao']}:{r['categoria']}"
        found[k] = found.get(k, 0) + r["valor_cent"]
    lines = []
    for k in sorted(set(contas["categorias"]) | set(found)):
        c, f = contas["categorias"].get(k), found.get(k, 0)
        lines.append({"direcao": k.split(":")[0], "categoria": k.split(":")[1], "contas": c, "encontrado": f,
                      "sem_detalhe": (c - f) if c is not None else None})
    for d, tot in (("entrada", contas["entradas"]), ("saida", contas["saidas"])):
        read = sum(v for k, v in contas["categorias"].items() if k.startswith(d))
        if abs(tot - read) > 100:   # rubricas da conta que ainda não sabemos ler por categoria
            lines.append({"direcao": d, "categoria": "rubricas_nao_lidas", "contas": tot - read, "encontrado": 0, "sem_detalhe": tot - read})
    return lines


def run(con, anos=None):
    units = [r[0] for r in con.execute("SELECT DISTINCT unidade FROM documento WHERE unidade IS NOT NULL")]
    con.execute("CREATE TABLE IF NOT EXISTS livro_ano (unidade TEXT, ano INTEGER, json TEXT, PRIMARY KEY (unidade, ano))")
    n = 0
    have = {p.stem for p in MENCOES.glob("*.json")}
    for unit in units:
        years = anos or sorted({int(r[0][:4]) for r in con.execute(
            "SELECT c.data_doc FROM documento d JOIN classificacao c ON c.documento_id=d.id AND c.parte=0 WHERE d.unidade=? AND c.data_doc IS NOT NULL",
            (unit,)) if r[0][:4].isdigit()})
        for y in years:
            docs_y = {r[0] for r in con.execute("""SELECT d.id FROM documento d JOIN classificacao c ON c.documento_id=d.id AND c.parte=0
                                                   WHERE d.unidade=? AND c.data_doc LIKE ?""", (unit, f"{y}%"))}
            if not (docs_y & have):
                continue   # ano ainda não lido no formato de menções
            contas = contas_ano(con, unit, y)
            rows, commits, estados = ledger(con, unit, y)
            problems = []
            for r in rows:
                if r["duplicado"]:
                    problems.append({"tipo": "contado_uma_vez", "texto": f"«{r['objeto']}» aparece em {len({m['doc_id'] for m in r['mencoes']})} documentos: contado uma vez.", "id": r["id"]})
            lines = reconcile(contas, rows) if contas else []
            for l in lines:
                if l["sem_detalhe"] is not None and l["sem_detalhe"] < -100:
                    problems.append({"tipo": "mais_que_contas", "texto": f"Encontrámos mais em «{CAT.get(l['categoria'], l['categoria'])}» do que as contas dizem: verificar duplicados, datas ou categoria."})
            for m in commits:
                problems.append({"tipo": "sem_pagamento", "texto": f"«{m['objeto']}» ({m['fase']}) sem pagamento visto nos documentos."})
            book = {"unidade": unit, "ano": y, "contas": contas, "linhas": lines, "transacoes": rows, "compromissos": commits,
                    "estados": [{k: m.get(k) for k in ("doc_id", "pagina", "excerto", "data", "valor", "objeto", "contraparte", "direcao")} for m in estados],
                    "problemas": problems, "docs_lidos": len(docs_y & have), "docs_ano": len(docs_y)}
            con.execute("INSERT OR REPLACE INTO livro_ano VALUES (?,?,?)", (unit, y, json.dumps(book, ensure_ascii=False)))
            n += 1
    con.commit()
    log(f"  livro do ano: {n} anos com menções lidas")

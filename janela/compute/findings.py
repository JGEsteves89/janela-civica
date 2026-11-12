"""Achados (IA, revistos por uma pessoa) e relatórios por tema.

Achados: a IA recebe só alertas abertos de gravidade ≥ 2, totais e principais decisões; escreve 3–8 achados.
Só pode citar ids que recebeu; todos os números do texto têm de existir nos dados que recebeu.
Ficam em "rascunho" até alguém aprovar na fila de revisão.
"""
import json
import re
from collections import defaultdict

from ..common import REVIEW, autarquias, log, norm, now, short_id

DIR = REVIEW / "ia" / "achados"
THEMES = {
    "festas_eventos": r"festa|concerto|espetacul|animac|evento|arraial|natal|carnaval|som e luz|palco|tenda|artista",
    "obras": r"obra|empreitada|pavimenta|requalifica|constru|reabilita|passeio|ossario|wc ",
    "limpeza": r"limpeza|residuo|varredura|desmatac|sarjeta|higiene",
    "publicidade": r"publicidade|divulgac|comunicac|outdoor|redes sociais|site|pagina web",
    "consultoria": r"consultor|assessor|apoio juridico|contabilid|auditoria|estudo",
    "combustivel": r"combustiv|gasoleo|gasolina|viatura|reparac\w+ de veiculo",
}


def export(con, aid):
    DIR.mkdir(parents=True, exist_ok=True)
    flags = [dict(r) for r in con.execute("""SELECT id, regra, severidade, titulo, texto, periodo_inicio, periodo_fim FROM flag
                                              WHERE autarquia=? AND ativo=1 AND severidade >= 2 AND estado IN ('aberto','por_rever')""", (aid,))]
    decisions = [dict(r) for r in con.execute("""SELECT id, data, assunto, valor_cent, doc_id FROM decisao WHERE autarquia=? AND superseded=0
                                                  AND valor_cent IS NOT NULL ORDER BY valor_cent DESC LIMIT 20""", (aid,))]
    task = {"autarquia": aid, "gerado": now(), "flags": flags, "decisoes": decisions,
            "instrucoes": "Escreva 3 a 8 achados em JSON: [{titulo, resumo (até 80 palavras, neutro, sem acusar, termina com a pergunta que fica), "
                          "flags: [ids], documentos: [ids], importancia: 0-1}]. Use só ids e números que estão nestes dados."}
    (DIR / f"{aid}-tarefa.json").write_text(json.dumps(task, ensure_ascii=False, indent=1), encoding="utf-8")
    return task


def import_answers(con, aid, task):
    path = DIR / f"{aid}-resposta.json"
    if not path.exists():
        return 0
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return 0
    allowed_flags = {f["id"] for f in task["flags"]}
    allowed_docs = {d["doc_id"] for d in task["decisoes"]} | {r[0] for r in con.execute("SELECT id FROM documento WHERE autarquia=?", (aid,))}
    blob = json.dumps(task, ensure_ascii=False)
    nums_in = set(re.findall(r"\d+", re.sub(r"[ .](?=\d{3}\b)", "", blob)))
    n = 0
    for it in items:
        fl = [f for f in it.get("flags") or [] if f in allowed_flags]
        docs = [d for d in it.get("documentos") or [] if d in allowed_docs]
        text = f"{it.get('titulo', '')} {it.get('resumo', '')}"
        nums = set(re.findall(r"\d+", re.sub(r"[ .](?=\d{3}\b)", "", text)))
        bad = [x for x in nums if x not in nums_in and len(x) > 1]
        fid = "ac-" + short_id(aid, it.get("titulo"))
        state = con.execute("SELECT estado FROM finding WHERE id=?", (fid,)).fetchone()
        con.execute("""INSERT OR REPLACE INTO finding (id, autarquia, titulo, resumo, flags, documentos, importancia, estado, quando)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (fid, aid, it.get("titulo"), it.get("resumo"), json.dumps(fl), json.dumps(docs), it.get("importancia", 0.5),
                     state["estado"] if state else ("invalido" if bad or not fl else "rascunho"), now()))
        if not state:
            con.execute("INSERT OR IGNORE INTO revisao (id, item_tipo, item_id, prioridade, motivo) VALUES (?,?,?,?,?)",
                        ("rv-" + fid, "achado", fid, 1, f"Achado da IA para aprovar: {it.get('titulo')}" +
                         (f" — ATENÇÃO: números que não estão nos dados: {bad}" if bad else "")))
        n += 1
    return n


def themes(con, aid):
    out = defaultdict(lambda: defaultdict(lambda: {"n": 0, "valor": 0, "itens": []}))
    rows = [("contrato", c["id"], c["data_assinatura"], c["objeto"], c["preco_contratual"]) for c in
            con.execute("SELECT * FROM contrato WHERE autarquia=?", (aid,))]
    rows += [("decisao", d["id"], d["data"], f"{d['assunto']} {d['resumo']} {d['tags']}", d["valor_cent"]) for d in
             con.execute("SELECT * FROM decisao WHERE autarquia=? AND superseded=0", (aid,))]
    for kind, iid, date, text, v in rows:
        if not date:
            continue
        for th, rx in THEMES.items():
            if re.search(rx, norm(text or "")):
                cell = out[th][date[:4]]
                cell["n"] += 1
                cell["valor"] += v or 0
                cell["itens"].append({"tipo": kind, "id": iid, "data": date, "texto": (text or "")[:120], "valor": v})
    return {k: dict(v) for k, v in out.items()}


def run(con):
    res = {}
    for aid in autarquias():
        task = export(con, aid)
        n = import_answers(con, aid, task)
        res[aid] = themes(con, aid)
        log(f"  achados {aid}: {len(task['flags'])} alertas enviados para análise; {n} achados importados")
    con.commit()
    return res

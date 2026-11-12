"""Etapa 7 — Revisão humana. A fila vai para data/revisao/fila.csv; escreva 'aprovar' ou 'rejeitar' na coluna decisao.

Prioridade 1: alertas graves (F07, F13, F18, F21) e achados da IA antes de publicar.
Prioridade 2: extrações rejeitadas pela validação, fusões de entidades duvidosas.
Prioridade 3: classificações incertas.
"""
import csv

from .common import REVIEW, connect, log, now, short_id

FILE = REVIEW / "fila.csv"
COLS = ["id", "prioridade", "item_tipo", "item_id", "motivo", "decisao", "quem"]


def export(con):
    REVIEW.mkdir(parents=True, exist_ok=True)
    for c in con.execute("SELECT documento_id, tipo, motivo FROM classificacao WHERE rever=1 AND parte=0").fetchall():
        con.execute("INSERT OR IGNORE INTO revisao (id, item_tipo, item_id, prioridade, motivo) VALUES (?,?,?,?,?)",
                    ("rv-" + short_id("cls", c["documento_id"]), "classificacao", c["documento_id"], 3,
                     f"Classificado como «{c['tipo']}»: {c['motivo'] or 'confiança baixa'}"))
    rows = con.execute("SELECT * FROM revisao WHERE estado='pendente' ORDER BY prioridade, item_tipo").fetchall()
    with open(FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(COLS)
        for r in rows:
            w.writerow([r["id"], r["prioridade"], r["item_tipo"], r["item_id"], r["motivo"], "", ""])
    return len(rows)


def import_decisions(con):
    if not FILE.exists():
        return 0
    n = 0
    for r in csv.DictReader(open(FILE, encoding="utf-8")):
        dec = (r.get("decisao") or "").strip().lower()
        if dec not in ("aprovar", "rejeitar") and not dec.startswith("tipo:"):
            continue
        con.execute("UPDATE revisao SET estado='feito', decisao=?, quem=?, quando=? WHERE id=?", (dec, r.get("quem"), now(), r["id"]))
        t, item = r["item_tipo"], r["item_id"]
        if t == "alerta":
            con.execute("UPDATE flag SET estado=? WHERE id=?", ("aberto" if dec == "aprovar" else "descartado", item))
        elif t == "achado":
            con.execute("UPDATE finding SET estado=?, revisto_por=? WHERE id=?", ("publicado" if dec == "aprovar" else "rejeitado", r.get("quem"), item))
        elif t == "fusao_entidade" and dec == "aprovar":
            a, b = item.split("|")
            con.execute("INSERT OR IGNORE INTO entidade_merge VALUES (?,?,?,?,?)", (b, a, r.get("quem"), now(), "revisão"))
        elif t == "classificacao":
            if dec.startswith("tipo:"):
                con.execute("UPDATE classificacao SET tipo=?, rever=0, metodo='manual', confianca=1 WHERE documento_id=? AND parte=0",
                            (dec.split(":", 1)[1].strip(), item))
            else:
                con.execute("UPDATE classificacao SET rever=0 WHERE documento_id=? AND parte=0", (item,))
        n += 1
    con.commit()
    return n


def run():
    con = connect()
    n = import_decisions(con)
    pending = export(con)
    log(f"Revisão: {n} decisões aplicadas; {pending} itens pendentes em {FILE}")

"""Pontuação de transparência 0–100 por ano e por mandato (requisitos 03 §6). Guarda o detalhe ("porquê 62")."""
import json
from collections import defaultdict

from ..common import autarquias, log

WEIGHTS = {"contas": 25, "planeamento": 15, "reunioes": 20, "dinheiro": 15, "pessoas": 10, "regras": 10, "acesso": 5}
DIM_OF = {"prestacao_contas": "contas", "informacao_escrita": "contas", "inventario": "contas", "relatorio_atividades": "contas",
          "orcamento": "planeamento", "gop": "planeamento",
          "ata_junta": "reunioes", "ata_assembleia": "reunioes", "edital_convocatoria": "reunioes",
          "lista_apoios": "dinheiro", "mapa_pessoal": "pessoas", "tabela_taxas": "regras", "controlo_interno": "regras"}
VALUE = {"present": 1.0, "late": 0.7, "present_no_numbers": 0.5, "present_unreadable": 0.3,
         "not_found_yet": 0.0, "missing": 0.0}
IMPORTANCE = {"prestacao_contas": 3, "orcamento": 3, "gop": 3, "lista_apoios": 3, "ata_junta": 2, "ata_assembleia": 2,
              "informacao_escrita": 2, "mapa_pessoal": 2, "tabela_taxas": 2, "edital_convocatoria": 1, "inventario": 1,
              "relatorio_atividades": 1, "controlo_interno": 1}


def run(con):
    con.execute("DELETE FROM score")
    for aid in autarquias():
        exp = con.execute("SELECT ano, tipo, estado FROM esperado WHERE autarquia=? AND estado != 'not_applicable'", (aid,)).fetchall()
        years = sorted({r["ano"] for r in exp})
        for y in years:
            dims = defaultdict(lambda: [0.0, 0.0])   # soma ponderada, peso total
            for r in exp:
                if r["ano"] != y:
                    continue
                dim = DIM_OF.get(r["tipo"])
                if not dim:
                    continue
                w = IMPORTANCE.get(r["tipo"], 1)
                dims[dim][0] += VALUE.get(r["estado"], 0) * w
                dims[dim][1] += w
            # dinheiro: contratos no BASE que têm decisão encontrada numa ata
            c = con.execute("""SELECT COUNT(*) n, SUM(decisao_id IS NOT NULL) ok FROM contrato
                               WHERE autarquia=? AND substr(data_assinatura,1,4)=?""", (aid, str(y))).fetchone()
            if c["n"]:
                dims["dinheiro"][0] += (c["ok"] or 0) / c["n"] * 2
                dims["dinheiro"][1] += 2
            # pessoas: há cargos com nome neste ano?
            p = con.execute("""SELECT COUNT(*) FROM cargo WHERE autarquia=? AND superseded=0 AND
                               substr(inicio,1,4) <= ? AND (fim IS NULL OR substr(fim,1,4) >= ?)""", (aid, str(y), str(y))).fetchone()[0]
            dims["pessoas"][0] += 1.0 if p else 0
            dims["pessoas"][1] += 1
            # regras: algum regulamento publicado?
            reg = con.execute("""SELECT COUNT(*) FROM classificacao c JOIN documento d ON d.id=c.documento_id
                                 WHERE d.autarquia=? AND c.tipo='regulamento' AND substr(COALESCE(c.data_doc,'0000'),1,4) <= ?""",
                              (aid, str(y))).fetchone()[0]
            dims["regras"][0] += 1.0 if reg else 0
            dims["regras"][1] += 1
            # acesso: documentos do ano com texto legível
            a = con.execute("""SELECT COUNT(*) n, SUM(l.estado IN ('native','ocr_good')) ok FROM documento d
                               JOIN classificacao c ON c.documento_id=d.id AND c.parte=0 JOIN leitura l ON l.documento_id=d.id
                               WHERE d.autarquia=? AND substr(c.data_doc,1,4)=? AND d.link_only=0""", (aid, str(y))).fetchone()
            dims["acesso"][0] += ((a["ok"] or 0) / a["n"]) if a["n"] else 0
            dims["acesso"][1] += 1
            total = 0.0
            for dim, wmax in WEIGHTS.items():
                got, w = dims.get(dim, [0, 0])
                share = got / w if w else 0
                total += share * wmax
                con.execute("INSERT INTO score VALUES (?,?,?,?,?)", (aid, y, dim, round(share * wmax, 1),
                                                                     json.dumps({"fracao": round(share, 3), "peso": wmax})))
            con.execute("INSERT INTO score VALUES (?,?,?,?,?)", (aid, y, "total", round(total, 1), None))
        log(f"  pontuação {aid}: {len(years)} anos")
    con.commit()

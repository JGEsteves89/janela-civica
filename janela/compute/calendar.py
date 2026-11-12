"""Calendário de documentos esperados e estado de cada um (requisitos 03 §4).

Estados: present | present_unreadable | present_no_numbers | late | not_found_yet | missing | not_applicable
"missing" só depois de um pedido LADA sem resposta no prazo (ou a autarquia confirmar que não existe).
Até lá: "not_found_yet" (laranja).
"""
import datetime as dt
import json
import re

from ..common import autarquias, log, short_id, taxonomy, today

AF_SLOTS = [("abril", (2, 3, 4, 5)), ("junho", (6, 7)), ("setembro", (8, 9, 10)), ("nov-dez", (11, 12))]
AM_SLOTS = [("fevereiro", (1, 2, 3)), ("abril", (4, 5)), ("junho", (6, 7)), ("setembro", (8, 9, 10)), ("nov-dez", (11, 12))]
NUM_RX = re.compile(r"\d{1,3}(?:[ .]\d{3})*,\d{2}")


def D(s):
    return dt.date.fromisoformat(s) if isinstance(s, str) else s


def active_units(rec, year):
    """Unidades (vidas administrativas) ativas no ano, com os meses em que estiveram ativas."""
    out = []
    for h in rec.get("historia") or [{"id": rec["id"], "de": None, "ate": None}]:
        a = D(h.get("de")) or dt.date(1900, 1, 1)
        b = D(h.get("ate")) or dt.date(2100, 1, 1)
        months = [m for m in range(1, 13) if a <= dt.date(year, m, 28) and dt.date(year, m, 1) < b]
        if months:
            out.append((h["id"], months, a, b))
    return out


def election_years(tax):
    return {D(e).year: D(e) for e in tax["eleicoes"]}


def doc_state(row, due, late_days=None):
    """Estado de um documento encontrado."""
    if row["leitura"] in ("unreadable",):
        return "present_unreadable"
    pub = row["data_publicacao"]
    if pub and row["first_seen"] and pub[:10] == row["first_seen"][:10]:
        pub = None   # a data é só o dia em que o encontrámos
    if pub and due and pub > due:
        return "late"
    if pub and late_days and row["data_doc"]:
        if (D(pub[:10]) - D(row["data_doc"][:10])).days > late_days:
            return "late"
    if row["tipo"] in ("prestacao_contas", "orcamento", "gop") and row["leitura"] not in ("link_only",) and not row["tem_numeros"]:
        return "present_no_numbers"
    return "present"


def run(con):
    tax = taxonomy()
    elections = election_years(tax)
    con.execute("DELETE FROM esperado")
    lada = {r["documentos"]: r for r in con.execute("SELECT * FROM pedido_lada").fetchall()}
    total = 0
    for aid, rec in autarquias().items():
        docs = con.execute("""SELECT c.*, d.first_seen, d.link_only, l.estado AS leitura,
                              (SELECT COUNT(*) FROM pagina p WHERE p.documento_id=d.id AND p.texto GLOB '*[0-9],[0-9][0-9]*') AS tem_numeros
                              FROM classificacao c JOIN documento d ON d.id=c.documento_id
                              LEFT JOIN leitura l ON l.documento_id=d.id WHERE d.autarquia=?""", (aid,)).fetchall()
        years = [int(r["data_doc"][:4]) for r in docs if r["data_doc"]]
        y0 = max(2009, min([2013] + years)) if years else 2013
        rules = tax["esperados"][rec["tipo"]]
        for year in range(y0, today().year + 1):
            for unit, months, ua, ub in active_units(rec, year):
                udocs = [r for r in docs if r["unidade"] == unit]
                for rule in rules:
                    tipo = rule["tipo"]
                    tdocs = [r for r in udocs if r["tipo"] == tipo]
                    slots = make_slots(rec, tipo, rule, year, months, elections, ua, ub)
                    for slot, due, match, late_days in slots:
                        if due and due > today().isoformat() and not any(match(r) for r in tdocs):
                            continue   # ainda não era devido
                        found = [r for r in tdocs if match(r)]
                        if found:
                            states = [doc_state(r, due, late_days) for r in found]
                            order = ["present", "late", "present_no_numbers", "present_unreadable"]
                            state = min(states, key=order.index)
                        else:
                            key = f"{unit}|{year}|{tipo}|{slot}"
                            req = next((v for k, v in lada.items() if k and key in k), None)
                            if req and req["resultado"] in ("nao_existe", "sem_resposta"):
                                state = "missing"
                            else:
                                state = "not_found_yet"
                        con.execute("INSERT OR REPLACE INTO esperado VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                    ("x-" + short_id(aid, unit, year, tipo, slot), aid, unit, year, tipo, slot, due, state,
                                     json.dumps([r["documento_id"] for r in found]) if found else None,
                                     rule_reason(tipo, rec["tipo"]), None))
                        total += 1
    con.commit()
    log(f"  calendário: {total} documentos esperados")


def make_slots(rec, tipo, rule, year, months, elections, ua, ub):
    """Lista de (slot, devido_até, função que diz se um documento serve, dias de atraso aceites)."""
    in_month = lambda m: (lambda r: r["data_doc"] and r["data_doc"][:7] == f"{year}-{m:02d}")
    in_year = lambda y: (lambda r: (r["periodo_inicio"] or r["data_doc"] or "")[:4] == str(y))
    slots = []
    # uma ata só pode faltar depois de o mês acabar e de passarem os 60 dias para a publicar
    t = today()
    gone = lambda m: dt.date(year, m, 28) + dt.timedelta(days=63) <= t
    if tipo == "ata_junta":
        n = rule["por_ano"]
        step = 12 // n if n <= 12 else 1
        if n <= 12:
            for m in months:
                if (m - 1) % step == 0 and gone(m):
                    slots.append((f"{year}-{m:02d}", None, in_month(m), 60))
        else:   # Câmara: 2 por mês, conta-se o mês
            for m in months:
                if gone(m):
                    slots.append((f"{year}-{m:02d}", None, in_month(m), 60))
    elif tipo in ("ata_assembleia", "edital_convocatoria", "informacao_escrita"):
        table = AM_SLOTS if rec["tipo"] == "municipio" else AF_SLOTS
        for name, ms in table:
            if any(m in months for m in ms) and gone(max(ms)):
                ok = (lambda ms_: lambda r: r["data_doc"] and r["data_doc"][:4] == str(year) and int(r["data_doc"][5:7]) in ms_)(ms)
                slots.append((f"{year} {name}", None, ok, 60 if tipo == "ata_assembleia" else None))
    elif tipo in ("orcamento", "gop", "mapa_pessoal"):
        # orçamento do ano Y: aprovado até 31/12 de Y-1; em ano de eleições (out.), até 31/3 de Y
        prev_election = elections.get(year - 1)
        due = f"{year}-03-31" if prev_election and prev_election.month >= 9 else f"{year - 1}-12-31"
        if ua.year == year and ua.month >= 9:    # autarquia criada no fim do ano anterior/este ano
            due = f"{year}-03-31" if ua.year < year else (ua + dt.timedelta(days=90)).isoformat()
        slots.append((str(year), due, in_year(year), None))
    elif tipo in ("prestacao_contas", "relatorio_atividades", "inventario"):
        if ub.year == year and ub.month < 12:
            return []   # unidade extinta durante o ano: contas finais tratadas pela sucessora
        slots.append((str(year), f"{year + 1}-04-30", in_year(year), None))
    elif tipo == "lista_apoios":
        slots.append((str(year), f"{year + 1}-06-30", in_year(year), None))
    elif tipo in ("tabela_taxas", "controlo_interno"):
        if year in elections or year == ua.year:   # uma vez por mandato: conta-se no ano de início
            slots.append((f"mandato {year}", None, lambda r: True, None))
    return slots


def rule_reason(tipo, kind):
    reasons = {
        "ata_junta": "A Junta/Câmara reúne pelo menos uma vez por mês e as deliberações são publicadas (Lei 75/2013, art. 20.º e 56.º).",
        "ata_assembleia": "A Assembleia tem 4 sessões ordinárias por ano (5 no município) e as atas são públicas (Lei 75/2013, art. 11.º, 27.º e 57.º).",
        "edital_convocatoria": "Cada sessão é anunciada por edital com antecedência (Lei 75/2013, art. 49.º).",
        "informacao_escrita": "Em cada sessão ordinária o presidente apresenta informação escrita sobre a atividade e a situação financeira.",
        "orcamento": "O orçamento é aprovado antes do início do ano e publicado no site (Lei 73/2013, art. 79.º).",
        "gop": "As Grandes Opções do Plano acompanham o orçamento (Lei 73/2013).",
        "prestacao_contas": "A prestação de contas é votada até 30 de abril e publicada no site (Lei 73/2013, art. 79.º).",
        "lista_apoios": "Os apoios e subvenções concedidos são publicados todos os anos (Lei 64/2013).",
        "mapa_pessoal": "O mapa de pessoal acompanha o orçamento (Lei 35/2014, art. 29.º).",
        "relatorio_atividades": "O relatório de atividades faz parte da prestação de contas.",
        "inventario": "O inventário de bens é atualizado todos os anos (SNC-AP).",
        "tabela_taxas": "O regulamento e a tabela de taxas são públicos (Lei 53-E/2006).",
        "controlo_interno": "A norma de controlo interno é obrigatória (SNC-AP).",
    }
    return reasons.get(tipo, "")

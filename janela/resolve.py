"""Etapa 5 — Resolver: entidades (NIF primeiro, nome normalizado depois), pessoas, ligações.

Também tem as funções usadas pela extração para criar/encontrar entidades e pessoas.
"""
import difflib
import json
import re

from .common import connect, log, norm, now, short_id

STOP = {"associacao", "de", "da", "do", "das", "dos", "e", "a", "o", "lda", "sa", "s", "unipessoal", "crl", "c", "r", "l",
        "beneficiente", "benemerita", "humanitaria", "direcao", "freguesia", "junta"}
TYPES = [(r"bombeiros", "bombeiros"), (r"santa casa|misericordia|ipss|centro social|lar |apoio social", "ipss"),
         (r"\bclube\b|desportiv|futebol|hoquei|nautico|atletismo|patinagem", "clube"),
         (r"associac|grupo|confraria|cooperativa cultural|rancho|banda|teatro|fabrica da igreja|paroquia", "associacao"),
         (r"escola|agrupamento|jardim de infancia", "escola"),
         (r"junta de freguesia|uniao das freguesias|freguesia de|municipio|camara municipal", "autarquia"),
         (r"\blda\b|\bs\.?\s?a\.?\b|unipessoal|limitada|sociedade|construc|engenharia|\bltd", "empresa")]


GENERIC = {"construcoes", "construcao", "comercio", "aluguer", "fabricacao", "carrocarias", "servicos", "industria", "sociedade",
           "limitada", "ltd", "unip", "filhos", "filho", "companhia", "cia", "empresa", "grupo", "comercial", "transportes",
           "tendas", "renovacoes", "engenharia", "portugal", "portuguesa", "nacional", "seguros", "corretor",
           "mediacao", "solucoes", "web", "irmaos"}


def core(name):
    """Só as palavras que distinguem a entidade (sem forma jurídica nem palavras genéricas)."""
    toks = [t for t in key(name).split() if t not in GENERIC and len(t) > 1]
    return " ".join(toks)


# palavras comuns a muitas instituições: sozinhas não identificam ninguém
COMMON = {"bombeiros", "voluntarios", "clube", "centro", "social", "desportivo", "cultural", "recreativo", "santa", "casa",
          "misericordia", "paroquia", "igreja", "fabrica", "escola", "agrupamento", "municipio", "camara", "municipal",
          "uniao", "freguesias", "nautico", "futebol", "banda", "musica", "rancho", "folclorico", "conferencia", "grupo"}


def same_entity(a, b):
    """Regra única para dizer se dois nomes são a mesma entidade. Devolve (sim?, motivo)."""
    ka, kb = core(a), core(b)
    if not ka or not kb:
        return False, ""
    if ka == kb or ka.replace(" ", "") == kb.replace(" ", ""):
        return True, "mesmas palavras distintivas"
    ta, tb = ka.split(), kb.split()
    small, big = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    extra = set(big) - set(small)
    # contém: as palavras a mais só podem ser genéricas (ex.: "Trinorte" e "Escola de Música Trinorte").
    # Um apelido igual ("Martins") ou um lugar a mais ("das Marinhas") NÃO chega -> revisão.
    if set(small) <= set(big) and extra <= COMMON and any(len(t) >= 4 and t not in COMMON for t in small):
        return True, "um nome contém o outro (só palavras genéricas a mais)"
    r = difflib.SequenceMatcher(None, ka, kb).ratio()
    # quase iguais: mesmo número de palavras e cada palavra só com erro de escrita ("Guia" ≠ "Amparo")
    if r >= 0.85 and len(ta) == len(tb) and all(difflib.SequenceMatcher(None, x, y).ratio() >= 0.75 for x, y in zip(ta, tb)):
        return True, f"nomes quase iguais ({r:.2f})"
    return False, f"{r:.2f}"


def key(name):
    toks = [t for t in re.findall(r"[a-z0-9]+", norm(name)) if t not in STOP]
    return " ".join(toks)


def entity_type(name):
    n = norm(name)
    for rx, t in TYPES:
        if re.search(rx, n):
            return t
    return "outro"


# nomes que não são entidades: documentos, eventos, totais e a própria freguesia
NOT_ENTITY = re.compile(r"^(orcamento|or[cç]amento|ppi|plano|gop|grandes op|contas|prestacao de contas|receitas?|despesas?|total|saldo|"
                        r"festa|feira|fornecedores|diversos|varios|vários|particulares?|um particular|estado \(|fff\b|fundo de financiamento|"
                        r"uniao das freguesias de apulia e fao|junta de freguesia de fao|freguesia de fao)", re.I)


def is_entity_name(name):
    return bool(name) and not NOT_ENTITY.search(norm(name).strip())


def get_entity(con, name=None, nif=None, municipio=None, tipo=None):
    """Encontra ou cria a entidade. NIF manda; senão nome normalizado (com fusões manuais aplicadas).
    Documentos, eventos e totais ("Orçamento 2023", "Festa do Marisco") não são entidades: devolve None."""
    if name and not nif and not is_entity_name(name):
        return None
    if name and not nif and re.search(r"c[aâ]mara municipal de esposende|munic[ií]pio de esposende|^cme$", norm(name)):
        nif = "506617599"   # Câmara e Município são a mesma entidade
    nif = re.sub(r"\D", "", nif or "") or None
    if nif and len(nif) != 9:
        nif = None
    if nif:
        row = con.execute("SELECT id FROM entidade WHERE nif=?", (nif,)).fetchone()
        if row:
            return _merged(con, row["id"])
    k = key(name or "")
    if not k:
        return None
    eid = "e-" + short_id(k)
    eid = _merged(con, eid)
    row = con.execute("SELECT id, nif, aliases FROM entidade WHERE id=?", (eid,)).fetchone()
    if row:
        al = set(json.loads(row["aliases"] or "[]"))
        if name and name not in al:
            al.add(name)
            con.execute("UPDATE entidade SET aliases=? WHERE id=?", (json.dumps(sorted(al), ensure_ascii=False), eid))
        if nif and not row["nif"]:
            con.execute("UPDATE entidade SET nif=? WHERE id=?", (nif, eid))
        return eid
    t = tipo or entity_type(name or "")
    con.execute("INSERT INTO entidade (id, nif, nome, aliases, tipo, publica, municipio) VALUES (?,?,?,?,?,?,?)",
                (eid, nif, (name or "").strip(), json.dumps([name], ensure_ascii=False), t, int(t in ("autarquia", "escola")), municipio))
    return eid


def _merged(con, eid):
    seen = set()
    while True:
        row = con.execute("SELECT para FROM entidade_merge WHERE de=?", (eid,)).fetchone()
        if not row or eid in seen:
            return eid
        seen.add(eid)
        eid = row["para"]


def person_id(name):
    return "p-" + short_id(key(name))


def get_person(con, name):
    name = re.sub(r"\s+", " ", (name or "").strip(" .,;"))
    if len(name) < 4:
        return None
    pid = person_id(name)
    row = con.execute("SELECT aliases FROM pessoa WHERE id=?", (pid,)).fetchone()
    if not row:
        con.execute("INSERT INTO pessoa (id, nome, aliases) VALUES (?,?,?)", (pid, name, json.dumps([name], ensure_ascii=False)))
    return pid


def merge_people(con):
    """Junta nomes curtos ao nome completo da mesma pessoa (mesmo último nome, palavras contidas, sem ambiguidade)."""
    people = con.execute("SELECT id, nome FROM pessoa").fetchall()
    full = sorted(people, key=lambda p: -len(key(p["nome"]).split()))
    moved = 0
    for p in people:
        tk = key(p["nome"]).split()
        if len(tk) > 3 or len(tk) < 2:
            continue
        cands = [f for f in full if f["id"] != p["id"] and key(f["nome"]).split()[-1] == tk[-1]
                 and set(tk) <= set(key(f["nome"]).split()) and len(key(f["nome"]).split()) > len(tk)]
        if len({c["id"] for c in cands}) == 1:
            target = cands[0]["id"]
            for tbl, col in (("cargo", "pessoa_id"), ("presenca", "pessoa_id"), ("votacao", "pessoa_id")):
                con.execute(f"UPDATE OR IGNORE {tbl} SET {col}=? WHERE {col}=?", (target, p["id"]))
            al = json.loads(con.execute("SELECT aliases FROM pessoa WHERE id=?", (target,)).fetchone()[0] or "[]")
            con.execute("UPDATE pessoa SET aliases=? WHERE id=?", (json.dumps(sorted(set(al + [p["nome"]])), ensure_ascii=False), target))
            moved += 1
    return moved


def candidate_merges(con):
    """Junta entidades que são a mesma (regra same_entity); as parecidas (0,7–0,85) vão para revisão.
    Fica a entidade com NIF, ou a que tem mais movimentos; os outros nomes passam a aliases."""
    ents = con.execute("""SELECT e.id, e.nome, e.nif, e.aliases,
                          (SELECT COUNT(*) FROM fluxo f WHERE f.entidade_id=e.id) + (SELECT COUNT(*) FROM contrato c WHERE c.fornecedor_id=e.id) n
                          FROM entidade e WHERE e.id NOT IN (SELECT de FROM entidade_merge)""").fetchall()
    ents = sorted(ents, key=lambda e: (e["nif"] is None, -e["n"], -len(e["nome"] or "")))
    gone, auto, review = set(), 0, 0
    for i, a in enumerate(ents):
        if a["id"] in gone:
            continue
        for b in ents[i + 1:]:
            if b["id"] in gone or (a["nif"] and b["nif"] and a["nif"] != b["nif"]):
                continue
            ok, why = same_entity(a["nome"], b["nome"])
            if ok:
                con.execute("INSERT OR IGNORE INTO entidade_merge VALUES (?,?,?,?,?)", (b["id"], a["id"], "auto", now(), why))
                al = set(json.loads(a["aliases"] or "[]")) | set(json.loads(b["aliases"] or "[]")) | {a["nome"], b["nome"]}
                con.execute("UPDATE entidade SET aliases=?, nif=COALESCE(nif, ?) WHERE id=?",
                            (json.dumps(sorted(x for x in al if x), ensure_ascii=False), b["nif"], a["id"]))
                gone.add(b["id"])
                auto += 1
            elif why and float(why) >= 0.7:
                con.execute("INSERT OR IGNORE INTO revisao (id, item_tipo, item_id, prioridade, motivo) VALUES (?,?,?,?,?)",
                            ("rv-" + short_id("merge", a["id"], b["id"]), "fusao_entidade", f"{a['id']}|{b['id']}", 2,
                             f"Serão a mesma entidade? «{a['nome']}» e «{b['nome']}» ({why})"))
                review += 1
    # todas as entidades têm aliases (pelo menos o próprio nome)
    for e in con.execute("SELECT id, nome, aliases FROM entidade").fetchall():
        al = set(json.loads(e["aliases"] or "[]")) | ({e["nome"]} if e["nome"] else set())
        con.execute("UPDATE entidade SET aliases=? WHERE id=?", (json.dumps(sorted(al), ensure_ascii=False), e["id"]))
    return auto, review


def apply_merges(con):
    for row in con.execute("SELECT de, para FROM entidade_merge").fetchall():
        target = _merged(con, row["para"])
        for tbl in ("fluxo", "apoio", "beneficio", "mencao"):
            con.execute(f"UPDATE {tbl} SET entidade_id=? WHERE entidade_id=?", (target, row["de"]))
        con.execute("UPDATE contrato SET fornecedor_id=? WHERE fornecedor_id=?", (target, row["de"]))


def link_contracts(con):
    """Contrato ↔ decisão: mesmo fornecedor (nome), objeto parecido, até 180 dias."""
    n = 0
    for c in con.execute("SELECT id, autarquia, fornecedor, objeto, data_assinatura FROM contrato WHERE decisao_id IS NULL").fetchall():
        if not c["data_assinatura"]:
            continue
        best = None
        for d in con.execute("""SELECT id, assunto, resumo, entidades, data FROM decisao WHERE autarquia=? AND superseded=0
                                AND data BETWEEN date(?, '-180 day') AND date(?, '+30 day')""",
                             (c["autarquia"], c["data_assinatura"], c["data_assinatura"])).fetchall():
            text = norm(f"{d['assunto']} {d['resumo']} {d['entidades']}")
            if key(c["fornecedor"] or "zz") and key(c["fornecedor"]).split()[0] in text:
                score = difflib.SequenceMatcher(None, norm(c["objeto"] or ""), text).ratio()
                if not best or score > best[1]:
                    best = (d["id"], score)
        if best:
            con.execute("UPDATE contrato SET decisao_id=? WHERE id=?", (best[0], c["id"]))
            n += 1
    return n


def run():
    con = connect()
    apply_merges(con)
    auto, review = candidate_merges(con)
    apply_merges(con)
    moved = merge_people(con)
    linked = link_contracts(con)
    con.commit()
    log(f"Resolver: {auto} fusões automáticas, {review} para rever, {moved} nomes de pessoas juntados, {linked} contratos ligados a decisões")

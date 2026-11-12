"""Extração por regras (determinística): contratos BASE, resultados eleitorais, listas de subvenções, linhas de orçamento/contas."""
import json
import re

from ..common import norm, now, parse_eur, short_id
from ..resolve import get_entity, get_person

VERSION = "rules-2.0"
PROC_OPEN = re.compile(r"concurso p[uú]blico", re.I)


def _d(s):
    """'07-10-2026' -> '2026-10-07'"""
    if s and re.fullmatch(r"\d{2}-\d{2}-\d{4}", s):
        return f"{s[6:]}-{s[3:5]}-{s[:2]}"
    return s or None


def prov(doc_id, excerto, pagina=1, conf=1.0, metodo="regra", extrator=VERSION):
    return dict(doc_id=doc_id, pagina=pagina, excerto=(excerto or "")[:600], metodo=metodo, extrator=extrator,
                versao=VERSION, confianca=conf, criado=now())


def insert(con, table, row):
    cols = ", ".join(row)
    con.execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({', '.join('?' * len(row))})", list(row.values()))


def base_contract(con, doc, aut, unit, text):
    d = json.loads(text)
    sup = (d.get("contracted") or [{}])
    sup0 = sup[0] if sup else {}
    fid = get_entity(con, sup0.get("description"), sup0.get("nif"), tipo="empresa") if sup0 else None
    price = parse_eur(d.get("initialContractualPrice"))
    eff = parse_eur(d.get("totalEffectivePrice"))
    base_price = parse_eur(d.get("estimatedBasePrice") or d.get("basePrice"))
    m = re.search(r"(\d+)\s*dias?", d.get("executionDeadline") or "")
    cid = "c-" + str(d.get("id"))
    cpv = d.get("cpvs") or ""
    insert(con, "contrato", dict(
        id=cid, base_id=str(d.get("id")), autarquia=aut, unidade=unit,
        adjudicante_nif=(d.get("contracting") or [{}])[0].get("nif"), adjudicante=(d.get("contracting") or [{}])[0].get("description"),
        fornecedor_id=fid, fornecedor_nif=sup0.get("nif"), fornecedor=sup0.get("description"),
        objeto=d.get("objectBriefDescription"), cpv=cpv, procedimento=d.get("contractingProcedureType"),
        preco_base=base_price, preco_contratual=price, preco_efetivo=eff,
        data_publicacao=_d(d.get("publicationDate")), data_assinatura=_d(d.get("signingDate")),
        prazo_dias=int(m.group(1)) if m else None,
        n_concorrentes=len(d.get("contestants") or []) or None,
        modificacoes=json.dumps({"preco": d.get("causesPriceChange"), "prazo": d.get("causesDeadlineChange"),
                                 "aumentos": d.get("increments")}, ensure_ascii=False),
        local=json.dumps(d.get("executionPlace"), ensure_ascii=False) if d.get("executionPlace") else None,
        raw=None))
    obras = cpv.startswith("45")
    insert(con, "fluxo", dict(
        id="f-" + short_id(doc["id"], "contrato"), autarquia=aut, unidade=unit, direcao="saida", valor_cent=eff or price,
        data=_d(d.get("signingDate")), periodo_inicio=_d(d.get("signingDate")), periodo_fim=_d(d.get("closeDate")) or _d(d.get("signingDate")),
        granularidade="data", origem="freguesia" if unit and "esposende" not in unit else "municipio",
        destino="entidade_privada", entidade_id=fid,
        categoria="obras" if obras else "bens_servicos", instrumento="contrato_publico", nivel="known",
        tipo_valor="executado" if eff else "comprometido", contrato_id=cid,
        descricao=f"{d.get('objectBriefDescription', '')} ({d.get('contractingProcedureType', '')})",
        **prov(doc["id"], f"{sup0.get('description')} · {d.get('initialContractualPrice')} · {d.get('objectBriefDescription')}")))
    return 1


def sgmai(con, doc, aut, unit, text, meta):
    data = json.loads(text).get("data")
    orgao = {"AF": "assembleia_freguesia", "CM": "camara", "AM": "assembleia_municipal"}[meta.get("orgao", "AF")]
    eid = "el-" + short_id(aut, unit, orgao, meta.get("eleicao"))
    if meta.get("conteudo") == "resultados":
        cr = (data or {}).get("currentResults") or {}
        lists = []
        for k, v in cr.items():
            if isinstance(v, list) and v and isinstance(v[0], dict) and "votes" in json.dumps(v[0]):
                lists = v
                break
        insert(con, "eleicao", dict(
            id=eid, autarquia=aut, unidade=unit, orgao=orgao, data=meta.get("eleicao"),
            inscritos=cr.get("subscribedVoters"), votantes=cr.get("numberVoters") or cr.get("totalVoters"),
            brancos=cr.get("blankVotes"), nulos=cr.get("nullVotes"),
            mandatos_total=sum(int(x.get("mandates") or 0) for x in lists) or None,
            **prov(doc["id"], f"inscritos {cr.get('subscribedVoters')}, brancos {cr.get('blankVotes')}, nulos {cr.get('nullVotes')}")))
        for x in lists:
            sigla = x.get("acronym") or x.get("partyAcronym") or x.get("name") or "?"
            insert(con, "eleicao_lista", dict(eleicao_id=eid, lista=sigla, nome_lista=x.get("name") or x.get("description") or sigla,
                                              votos=x.get("votes"), pct=x.get("percentage"), mandatos=x.get("mandates")))
        return 1
    # candidatos
    n = 0
    def walk(o, lista=None):
        nonlocal n
        if isinstance(o, dict):
            lista = o.get("acronym") or o.get("partyAcronym") or lista
            name = o.get("name") if isinstance(o.get("name"), str) and len(o.get("name", "")) > 6 and " " in o.get("name", "") else None
            if name and (o.get("position") is not None or o.get("candidateOrder") is not None or "effective" in o):
                insert(con, "eleito", dict(eleicao_id=eid, lista=lista or "?", ordem=o.get("position") or o.get("candidateOrder") or 0,
                                           nome=name, efetivo=int(bool(o.get("effective", True))), eleito=int(bool(o.get("elected", False)))))
                get_person(con, name)
                n += 1
            for v in o.values():
                walk(v, lista)
        elif isinstance(o, list):
            for v in o:
                walk(v, lista)
    walk(data)
    return n


SUB_SPLIT = re.compile(r"\b(\d{9})\s+Munic[ií]pio\s+de\s+\w+", re.I)


def subvencoes(con, doc, aut, unit, text, year):
    """Listas oficiais (Lei 64/2013): NIF entidade · Beneficiário · Montante € · Data decisão · Finalidade."""
    flat = re.sub(r"\s+", " ", text).replace("￾", "-")
    parts = SUB_SPLIT.split(flat)
    n = 0
    # parts: [antes, nif_eo, resto, nif_eo, resto...]
    for i in range(2, len(parts), 2):
        rec = parts[i]
        m = re.search(r"^\s*\|?\s*(\d{9})\s*\|?\s*(.*?)\s+(\d{1,3}(?:[ .]\d{3})*,\d{2})\s*€\s*\|?\s*(\d{2}[/-]\d{2}[/-]\d{4})?\s*\|?\s*(.*?)\s*(?:Lei|Despacho|Delibera|$)", rec)
        if not m:
            continue
        nif, name, amount, dd, purpose = m.groups()
        eid = get_entity(con, name, nif)
        cents = parse_eur(amount)
        ddec = f"{dd[6:]}-{dd[3:5]}-{dd[:2]}" if dd else None
        aid = "a-" + short_id(doc["id"], i)
        excerpt = f"{nif} {name} {amount} € {dd or ''} {purpose[:120]}"
        insert(con, "apoio", dict(id=aid, autarquia=aut, unidade=unit, entidade_id=eid, valor_cent=cents,
                                  finalidade=purpose[:300], ano=year, data_decisao=ddec, pago="transferido",
                                  origem="municipio" if "municipio" in norm(flat[:400]) or aut == "esposende" else "freguesia",
                                  **prov(doc["id"], excerpt)))
        insert(con, "fluxo", dict(
            id="f-" + short_id(doc["id"], "sub", i), autarquia=aut, unidade=unit, direcao="saida", valor_cent=cents,
            data=None, periodo_inicio=f"{year}-01-01", periodo_fim=f"{year}-12-31", granularidade="year",
            origem="municipio" if aut == "esposende" else "freguesia", destino="entidade_privada", entidade_id=eid,
            categoria="apoios", instrumento="subvencao", nivel="known", tipo_valor="pago", apoio_id=aid,
            descricao=purpose[:200], **prov(doc["id"], excerpt)))
        n += 1
    return n


LINE = re.compile(r"^\s*((?:\d{2}(?:\.\d{2}){0,4}))\s+([A-Za-zÀ-ú][^\d\n]{3,90}?)\s+(-?\d{1,3}(?:[ .]\d{3})*,\d{2})(?:\s+(-?\d{1,3}(?:[ .]\d{3})*,\d{2}))?(?:\s+(-?\d{1,3}(?:[ .]\d{3})*,\d{2}))?\s*$", re.M)


def budget_lines(con, doc, aut, unit, pages, tipo, year):
    """Linhas 'código  descrição  valor [valor] [valor]' em orçamentos e contas. Confiança média: vão à revisão."""
    n = 0
    side = None
    for p in pages:
        t = p["texto"]
        low = norm(t[:2000])
        if "receita" in low and "despesa" not in low[:300]:
            side = "receita"
        elif "despesa" in low:
            side = "despesa"
        for m in LINE.finditer(t):
            code, label, a, b, c = m.groups()
            vals = [parse_eur(x) for x in (a, b, c) if x]
            if not vals or max(abs(v) for v in vals) < 100:
                continue
            row = dict(id="lo-" + short_id(doc["id"], p["n"], m.start()), autarquia=aut, unidade=unit, ano=year,
                       lado=side or ("receita" if code[:2] in ("01", "02", "04", "05", "06", "07", "08", "09", "10") and tipo == "orcamento" else "despesa"),
                       codigo=code, rotulo=label.strip(), categoria=None,
                       previsto=vals[0] if tipo in ("orcamento", "gop") else (vals[0] if len(vals) > 1 else None),
                       corrigido=vals[1] if len(vals) > 2 else None,
                       executado=vals[-1] if tipo == "prestacao_contas" else None,
                       **prov(doc["id"], m.group(0).strip(), p["n"], 0.6))
            insert(con, "linha_orcamental", row)
            n += 1
    return n


# ---- Mapas SNC-AP (orçamento "Plano Orçamental Plurianual" e contas "Demonstração do Desempenho Orçamental") ----
NUM = re.compile(r"-?\d{1,3}(?:[ .]\d{3})+,\d{2}|-?\d+,\d{2}|-?\d{4,}")
SNC_IN = [  # (padrão no rótulo normalizado, categoria, origem)
    (r"^saldo de gerencia anterior", "saldo_anterior", "freguesia"),
    (r"^receita fiscal", "outras_receitas", "estado"),
    (r"^taxas, multas", "taxas", "entidade_privada"),
    (r"^rendimentos de propriedade", "rendas", "entidade_privada"),
    (r"administracao central - estado", "transferencias_estado", "estado"),
    (r"administracao central - outras", "transferencias_estado", "estado"),
    (r"^administracao local", "transferencias_municipio", "municipio"),
    (r"^exterior|uniao europeia", "fundos_europeus", "ue"),
    (r"^venda de bens", "vendas", "entidade_privada"),
    (r"^outras receitas correntes", "outras_receitas", "desconhecido"),
    (r"^venda de bens de investimento", "vendas", "entidade_privada"),
    (r"^outras receitas de capital", "outras_receitas", "desconhecido"),
    (r"^passivos financeiros|^emprestimos", "emprestimos", "banco"),
]
SNC_OUT = [
    (r"^despesas com o? ?pessoal", "pessoal"), (r"^aquisicao de bens e servicos", "bens_servicos"),
    (r"^juros e outros encargos", "juros_divida"), (r"^transferencias e subsidios correntes", "apoios"),
    (r"^outras despesas correntes", "outras_despesas"), (r"^aquisicao de bens de capital", "obras"),
    (r"^transferencias e subsidios de capital", "apoios"), (r"^outras despesas de capital", "outras_despesas"),
    (r"^passivos financeiros", "amortizacao"),
]
CODE = re.compile(r"^\s*([RD])[\d.,]*\s+(.*)$")


def _snc_num(tok):
    tok = tok.replace(" ", "").replace(".", "")
    if "," in tok:
        return int(round(float(tok.replace(",", ".")) * 100))
    return int(tok)   # OCR sem vírgula: os 2 últimos algarismos são cêntimos


def snc_maps(con, doc, aut, unit, pages, tipo, title):
    """Extrai, por categoria, o orçamento (2.ª coluna = ano do orçamento) ou o executado (1.ª coluna = ano; última = ano anterior)."""
    mode = "orc" if tipo in ("orcamento", "gop") else "exe"
    marker = "plano orcamental plurianual" if mode == "orc" else "desempenho orcamental"
    year = None
    m = re.search(r"(?:or[cç]amento|contas)\s*(?:de\s*)?(\d{4})", title or "", re.I)
    if m:
        year = int(m.group(1))
    n = 0
    seen = set()
    active = False
    stop = ("alteracoes orcamentais", "execucao anual", "balanco", "demonstracao dos resultados", "anexo", "plano plurianual de investimentos",
            "fluxos de caixa", "mapa de pessoal", "operacoes de tesouraria", "contratacao administrativa", "informacao adicional")
    for p in pages:
        low = norm(p["texto"][:600])
        if marker in low:
            active = True            # o mapa continua nas páginas seguintes (ex.: a parte da despesa)
        elif any(w in low for w in stop):
            active = False
        if not active:
            continue
        g = re.search(r"gerencia de (\d{4})-01-01", norm(p["texto"][:800]))
        if g:
            year = int(g.group(1))
        if not year:
            continue
        side = "despesa" if re.search(r"\bpagamentos\b|despesa corrente", low) and "recebimentos" not in low else "receita"
        for line in p["texto"].split("\n"):
            cm = CODE.match(line)
            rest = cm.group(2) if cm else line.strip()
            if cm:
                side = "receita" if cm.group(1) == "R" else "despesa"
            elif re.match(r"\s*(receita|saldo de ger)", norm(line)):
                side = "receita"
            elif re.match(r"\s*despesa", norm(line)):
                side = "despesa"
            label = NUM.split(norm(rest))[0].strip(" -")
            if not label:
                continue
            nums = NUM.findall(rest)   # só os números depois do código (o código "R5111" não é um valor)
            if len(nums) < 2:
                continue
            if side == "receita":
                hit = next(((cat, ori) for rx, cat, ori in SNC_IN if re.search(rx, label)), None)
            else:
                hit = next(((cat, None) for rx, cat in SNC_OUT if re.search(rx, label)), None)
            if not hit:
                continue
            key = (side, label[:40], hit[0])
            if key in seen:   # "Administração local" aparece na parte corrente e na de capital: as duas contam
                key = key + ("capital",)
                if key in seen:
                    continue
            seen.add(key)
            try:
                v = _snc_num(nums[1] if mode == "orc" else nums[0])
                prev = _snc_num(nums[-1]) if mode == "exe" and len(nums) >= 3 else None
            except ValueError:
                continue
            if v is None or v < 0:
                continue
            cat = hit[0]
            insert(con, "linha_orcamental", dict(id="lo-" + short_id(doc["id"], p["n"], line), autarquia=aut, unidade=unit, ano=year,
                   lado=side, codigo=(cm.group(1) if cm else ""), rotulo=line.strip()[:120], categoria=cat,
                   previsto=v if mode == "orc" else None, corrigido=None, executado=v if mode == "exe" else None,
                   **prov(doc["id"], line.strip()[:300], p["n"], 0.85)))
            if v and cat != "saldo_anterior":
                insert(con, "fluxo", dict(
                    id="f-" + short_id(doc["id"], p["n"], line), autarquia=aut, unidade=unit,
                    direcao="entrada" if side == "receita" else "saida", valor_cent=v, data=None,
                    periodo_inicio=f"{year}-01-01", periodo_fim=f"{year}-12-31", granularidade="year",
                    origem=hit[1] if side == "receita" else "freguesia", destino="freguesia" if side == "receita" else "desconhecido",
                    entidade_id=None, categoria=cat, instrumento="orcamento" if mode == "orc" else "prestacao_contas", nivel="known",
                    tipo_valor="previsto" if mode == "orc" else "executado",
                    descricao=f"{'Orçamento' if mode == 'orc' else 'Contas'} {year}: {cm.group(2).strip()[:80] if cm else line.strip()[:80]}",
                    **prov(doc["id"], line.strip()[:300], p["n"], 0.85)))
            n += 1
    return n


def run(con):
    rows = con.execute("""SELECT d.id, d.autarquia, d.unidade, d.meta, d.titulo, c.tipo, c.periodo_inicio FROM documento d
                          JOIN classificacao c ON c.documento_id=d.id AND c.parte=0
                          WHERE c.tipo IN ('contrato_publico','resultado_eleitoral','lista_apoios','orcamento','prestacao_contas','gop')
                          AND NOT EXISTS (SELECT 1 FROM fluxo WHERE doc_id=d.id AND extrator=?)
                          AND NOT EXISTS (SELECT 1 FROM eleicao WHERE doc_id=d.id AND extrator=?)
                          AND NOT EXISTS (SELECT 1 FROM linha_orcamental WHERE doc_id=d.id AND extrator=?)
                          AND NOT EXISTS (SELECT 1 FROM apoio WHERE doc_id=d.id AND extrator=?)""",
                       (VERSION, VERSION, VERSION, VERSION)).fetchall()
    stats = {}
    for r in rows:
        pages = con.execute("SELECT n, texto FROM pagina WHERE documento_id=? ORDER BY n", (r["id"],)).fetchall()
        if not pages:
            continue
        text = "\n".join(p["texto"] for p in pages)
        meta = json.loads(r["meta"] or "{}")
        year = int(r["periodo_inicio"][:4]) if r["periodo_inicio"] else None
        try:
            if r["tipo"] == "contrato_publico":
                n = base_contract(con, r, r["autarquia"], r["unidade"], text)
            elif r["tipo"] == "resultado_eleitoral" and meta.get("tipo_fonte") == "sgmai":
                n = sgmai(con, r, r["autarquia"], r["unidade"], text, meta)
            elif r["tipo"] == "lista_apoios":
                n = subvencoes(con, r, r["autarquia"], r["unidade"], text, year)
            elif r["tipo"] in ("orcamento", "prestacao_contas", "gop"):
                n = snc_maps(con, r, r["autarquia"], r["unidade"], pages, r["tipo"], r["titulo"])   # mapas SNC-AP (2019+)
                if not n:
                    n = budget_lines(con, r, r["autarquia"], r["unidade"], pages, r["tipo"], year)
            else:
                n = 0
        except (ValueError, KeyError, TypeError) as e:
            con.execute("INSERT OR IGNORE INTO revisao (id, item_tipo, item_id, prioridade, motivo) VALUES (?,?,?,?,?)",
                        ("rv-" + short_id("rule", r["id"]), "extracao", r["id"], 2, f"Regra falhou: {type(e).__name__}: {e}"))
            n = 0
        stats[r["tipo"]] = stats.get(r["tipo"], 0) + n
    con.commit()
    return stats

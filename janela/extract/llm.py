"""Extração com IA (sem API): o programa escreve tarefas, a IA responde em JSON, o programa valida e guarda.

  data/revisao/ia/tarefas/<doc>.json    texto das páginas + instruções + esquema
  data/revisao/ia/respostas/<doc>.json  resposta da IA (um objeto por documento)

Validação (requisitos 05 §2.5): cada valor tem de ter um "excerto" que existe mesmo na página indicada;
os montantes têm de aparecer no excerto; datas válidas; área e tipo das listas fixas. O que falha vai para a revisão.
"""
import datetime as dt
import json
import re

from ..common import REVIEW, log, norm, now, parse_eur, short_id
from ..resolve import get_entity, get_person
from .rules import insert

PROMPT_VERSION = "ia-2.0"
TASKS, ANSWERS = REVIEW / "ia" / "tarefas", REVIEW / "ia" / "respostas"
LLM_TYPES = {"ata_junta", "ata_assembleia", "edital_convocatoria", "edital_deliberacoes", "informacao_escrita",
             "contrato_interadministrativo", "protocolo", "mapa_pessoal", "regulamento", "tabela_taxas",
             "prestacao_contas", "relatorio_atividades", "publicacao_redes", "noticia", "resultado_eleitoral",
             "lista_apoios", "orcamento", "gop", "aviso", "procedimento_concursal"}
AREAS = ["Finanças", "Pessoal", "Apoios", "Obras e espaço público", "Educação e juventude", "Ação social",
         "Cultura e festas", "Desporto", "Ambiente e limpeza", "Urbanismo e licenças", "Mobilidade",
         "Regulamentos e governação", "Outro"]
DEC_TYPES = ["aprovacao", "contrato", "apoio", "regulamento", "pessoal", "informacao", "outro"]
ORIGINS = ["estado", "municipio", "freguesia", "ue", "outra_autarquia", "entidade_privada", "pessoal", "banco", "desconhecido"]
CATS_IN = ["transferencias_estado", "transferencias_municipio", "fundos_europeus", "taxas", "vendas", "rendas",
           "emprestimos", "saldo_anterior", "outras_receitas", "desconhecida"]
CATS_OUT = ["pessoal", "bens_servicos", "apoios", "obras", "juros_divida", "amortizacao", "outras_despesas", "desconhecida"]

INSTRUCOES = f"""Leia o documento e devolva UM objeto JSON com as chaves abaixo (use [] quando não houver nada).
Regras:
- Cada item tem "pagina" (número) e "excerto": a frase EXATA copiada do texto da página (máx. 300 caracteres).
- Um nome de entidade só pode ser uma organização ou pessoa que paga ou recebe. Nunca um documento (orçamento, contas, ata), um evento (festa), um total, uma categoria, nem a própria Junta/Freguesia.
- Previsto não é gasto: valores de orçamento/plano são sempre "tipo_valor": "previsto".
- Estado não é movimento: "faturas por liquidar", "em dívida", "recebimentos pendentes" e saldos são o estado das contas num dia; não são fluxos (use saldos/dívida).
- Empréstimo não é receita: dinheiro emprestado é "categoria": "emprestimos"; pagar o empréstimo é "amortizacao" (não é despesa nova).
- Nunca invente montantes. Se o texto fala de dinheiro sem valor, use "valor": null (vira "valor desconhecido").
- "resumo": português simples, até 40 palavras, neutro, sem adjetivos.
- "area" de: {AREAS}. "tipo" de decisão de: {DEC_TYPES}.
- "origem"/"destino" de: {ORIGINS}. "categoria" de entrada: {CATS_IN}; de saída: {CATS_OUT}.
- "tipo_valor": previsto | comprometido | executado | pago. Datas em AAAA-MM-DD.
- Se o texto vier cortado ([…]) e faltar contexto para perceber um facto, devolva SÓ {{"pedir_paginas": [números]}}:
  na próxima ronda recebe essas páginas completas.
Chaves:
 reuniao: {{orgao: junta|assembleia_freguesia|camara|assembleia_municipal, data, tipo: ordinaria|extraordinaria|instalacao|publica, numero, local, pagina, excerto}} ou null
 presencas: [{{nome, estado: presente|ausente|justificada, pagina, excerto}}]
 decisoes: [{{ordem, assunto, resumo, tipo, area, tags:[], valor, entidades:[{{nome, nif}}], resultado: unanimidade|maioria|rejeitada|sem_votacao,
              votos_favor, votos_contra, abstencoes, votos:[{{nome, voto: favor|contra|abstencao}}], proponente, pagina, excerto}}]
 fluxos: [{{direcao: entrada|saida, valor, data, periodo_inicio, periodo_fim, origem, destino, entidade, nif, categoria, instrumento,
            tipo_valor, descricao, decisao_ordem, pagina, excerto}}]
 saldos: [{{data, conta: banco|caixa|total, valor, pagina, excerto}}]
 cargos: [{{nome, funcao, orgao, lista, inicio, fim, motivo_fim, pagina, excerto}}]
 instrumentos: [{{tipo: contrato_interadministrativo|acordo_execucao|auto_transferencia|protocolo|subsidio, freguesia, tarefa, ano, valor, decisao_ref, pagina, excerto}}]
 obras: [{{nome, tipo, local_texto, custo_previsto, custo_executado, inicio, fim, estado, pagina, excerto}}]
 beneficios: [{{entidade, nif, tipo: isencao_taxa|cedencia_espaco|apoio_especie, valor_estimado, descricao, pagina, excerto}}]
 eleicao: {{orgao, data, inscritos, votantes, brancos, nulos, listas:[{{lista, votos, mandatos}}], eleitos:[{{lista, ordem, nome}}], pagina, excerto}} ou null
 eventos: [{{data, nome, pagina, excerto}}]
"""


def compact(s):
    return re.sub(r"[^a-z0-9]", "", norm(s))


def excerpt_ok(excerto, pages, pagina):
    if not excerto:
        return False
    texts = [pages.get(pagina, "")] + [t for n, t in pages.items() if n != pagina]
    pieces = [compact(x) for x in re.split(r"\.\.\.|…", excerto) if len(compact(x)) >= 8]
    if not pieces:
        return False
    for t in texts[:1] + texts[1:]:
        ct = compact(t)
        if all(p in ct for p in pieces):
            return True
    return False


def amount_ok(valor, excerto):
    """O montante tem de estar escrito no excerto (dígitos)."""
    if valor in (None, ""):
        return True
    cents = parse_eur(valor) if not isinstance(valor, (int, float)) else round(valor * 100)
    if cents is None:
        return False
    digits = re.sub(r"\D", "", excerto or "")
    euros = str(abs(cents) // 100)
    return euros in digits


def date_ok(s):
    if not s:
        return True
    try:
        dt.date.fromisoformat(s)
        return True
    except (ValueError, TypeError):
        return False


def cents(v):
    if v in (None, ""):
        return None
    return round(v * 100) if isinstance(v, (int, float)) else parse_eur(v)


FAO = re.compile(r"\bf[aã]o\b", re.I)


def _trechos_fao(pages, around=6, head=1200):
    """Guarda só as linhas perto de cada menção a Fão (±6 linhas). Na 1.ª página guarda também o início
    (data, presenças). Os trechos são texto exato da página, por isso os excertos continuam verificáveis."""
    out = []
    for p in pages:
        lines = p["texto"].split("\n")
        hits = [i for i, l in enumerate(lines) if FAO.search(l)]
        keep = set()
        for i in hits:
            keep |= set(range(max(0, i - around), min(len(lines), i + around + 1)))
        parts, last = [], None
        for i in sorted(keep):
            if last is not None and i != last + 1:
                parts.append("[…]")
            parts.append(lines[i])
            last = i
        text = "\n".join(parts)
        if p["n"] == 1:
            text = p["texto"][:head] + ("\n[…]\n" + text if text else "")
        if hits or p["n"] == 1:
            out.append({"n": p["n"], "texto": text})
    return out if any(FAO.search(p["texto"]) for p in out) else []


def export(con, units_local):
    """Escreve tarefas para documentos sem resposta. Câmara: só documentos que referem Fão (páginas relevantes)."""
    TASKS.mkdir(parents=True, exist_ok=True)
    ANSWERS.mkdir(parents=True, exist_ok=True)
    rows = con.execute("""SELECT d.id, d.autarquia, d.unidade, d.titulo, d.url, c.tipo, c.data_doc, c.orgao, c.refere, l.estado
                          FROM documento d JOIN classificacao c ON c.documento_id=d.id AND c.parte=0
                          JOIN leitura l ON l.documento_id=d.id
                          WHERE l.estado IN ('native','ocr_good','ocr_poor')""").fetchall()
    n, current = 0, set()
    for r in rows:
        ans, full = ANSWERS / f"{r['id']}.json", set()
        if ans.exists():
            try:
                full = {int(x) for x in json.loads(ans.read_text(encoding="utf-8")).get("pedir_paginas") or []}
            except (ValueError, AttributeError):
                full = set()
            if not full:
                continue
            (ANSWERS / "_pedidos").mkdir(exist_ok=True)   # o pedido sai da pasta; a tarefa volta com as páginas completas
            ans.replace(ANSWERS / "_pedidos" / ans.name)
        if r["tipo"] not in LLM_TYPES:
            continue
        refere = set(json.loads(r["refere"] or "[]"))
        if r["autarquia"] != "fao" and not (refere & units_local) and r["tipo"] not in ("contrato_interadministrativo",):
            continue
        if r["tipo"] in ("orcamento", "gop", "lista_apoios") and r["autarquia"] != "fao":
            continue   # tabelas da Câmara: tratadas por regras
        pages = con.execute("SELECT n, texto FROM pagina WHERE documento_id=? ORDER BY n", (r["id"],)).fetchall()
        if r["autarquia"] != "fao":   # Câmara: só os trechos que falam de Fão, mais o cabeçalho da 1.ª página
            all_pages = {p["n"]: p for p in pages}
            pages = _trechos_fao(pages)
            if not pages and not full:
                continue
            pages = [all_pages[p["n"]] if p["n"] in full else p for p in pages] + \
                    [{"n": n, "texto": all_pages[n]["texto"]} for n in sorted(full) if n in all_pages and n not in {p["n"] for p in pages}]
            pages.sort(key=lambda p: p["n"])
        task = {"doc_id": r["id"], "tipo": r["tipo"], "orgao": r["orgao"], "autarquia": r["autarquia"], "unidade": r["unidade"],
                "titulo": r["titulo"], "data": r["data_doc"], "url": r["url"], "versao": PROMPT_VERSION,
                "instrucoes": INSTRUCOES, "paginas": [{"n": p["n"], "texto": p["texto"]} for p in pages]}
        path = TASKS / f"{r['id']}.json"
        current.add(path.name)
        body = json.dumps(task, ensure_ascii=False, indent=1)
        if not path.exists() or path.read_text(encoding="utf-8") != body:   # reescreve se o texto mudou (ex.: OCR)
            path.write_text(body, encoding="utf-8")
            n += 1
    old = TASKS / "_antigas"
    for path in TASKS.glob("*.json"):   # tarefas que já não fazem sentido saem da pasta (não se apagam)
        if path.name not in current and not (ANSWERS / path.name).exists():
            old.mkdir(exist_ok=True)
            path.replace(old / path.name)
    return n


def review(con, doc_id, what, reason, prio=2):
    con.execute("INSERT OR IGNORE INTO revisao (id, item_tipo, item_id, prioridade, motivo) VALUES (?,?,?,?,?)",
                ("rv-" + short_id("ia", doc_id, what, reason), "extracao_ia", doc_id, prio, f"{what}: {reason}"))


DIVIDA = ANSWERS.parent / "divida.json"
DIV_TIPOS = {"emprestimo", "amortizacao", "juros", "divida", "leasing", "prestacoes", "ajuda"}


def import_divida(con):
    """Empréstimos e dívidas (data/revisao/ia/divida.json). Só entra o que tem excerto exato e valor no excerto."""
    if not DIVIDA.exists():
        return 0
    con.execute("DELETE FROM divida WHERE extrator='ia'")
    n = 0
    for i, x in enumerate(json.loads(DIVIDA.read_text(encoding="utf-8"))):
        doc = con.execute("SELECT autarquia, unidade FROM documento WHERE id=?", (x.get("doc_id"),)).fetchone()
        if not doc or x.get("tipo") not in DIV_TIPOS or not date_ok(x.get("data")):
            continue
        pages = {p["n"]: p["texto"] for p in con.execute("SELECT n, texto FROM pagina WHERE documento_id=?", (x["doc_id"],))}
        if not excerpt_ok(x.get("excerto"), pages, x.get("pagina")):
            continue
        v = x.get("valor")
        insert(con, "divida", dict(id="dv-" + short_id(x["doc_id"], x.get("tipo"), v, x.get("credor"), i), autarquia=doc["autarquia"],
                                   unidade=x.get("unidade") or doc["unidade"], data=x["data"], tipo=x["tipo"],
                                   valor_cent=round(v * 100) if isinstance(v, (int, float)) else None, credor=x.get("credor"),
                                   estado=x.get("estado"), descricao=(x.get("descricao") or "")[:300], doc_id=x["doc_id"],
                                   pagina=x.get("pagina"), excerto=(x.get("excerto") or "")[:300], metodo="llm", extrator="ia",
                                   versao=PROMPT_VERSION, confianca=0.8, superseded=0, criado=now()))
        n += 1
    con.commit()
    return n


def import_events(con):
    """Eventos de todas as respostas (separado, porque as respostas já importadas não voltam a ser lidas)."""
    n = 0
    for path in sorted(ANSWERS.glob("*.json")):
        try:
            a = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            continue
        evs = a.get("eventos") or []
        if not evs:
            continue
        doc = con.execute("SELECT autarquia, unidade FROM documento WHERE id=?", (path.stem,)).fetchone()
        if not doc:
            continue
        pages = {p["n"]: p["texto"] for p in con.execute("SELECT n, texto FROM pagina WHERE documento_id=?", (path.stem,))}
        for i, x in enumerate(evs):
            if not (x.get("nome") and date_ok(x.get("data")) and x.get("data") and excerpt_ok(x.get("excerto"), pages, x.get("pagina"))):
                continue
            insert(con, "evento", dict(id="ev-" + short_id(path.stem, i), autarquia=doc["autarquia"], unidade=doc["unidade"],
                                       data=x["data"], nome=x["nome"][:200], doc_id=path.stem, pagina=x.get("pagina"),
                                       excerto=(x.get("excerto") or "")[:300], metodo="llm", extrator="ia", versao=PROMPT_VERSION,
                                       confianca=0.8, superseded=0, criado=now()))
            n += 1
    con.commit()
    return n


def import_answers(con):
    done = {r[0] for r in con.execute("SELECT DISTINCT doc_id FROM decisao WHERE extrator='ia' UNION "
                                      "SELECT DISTINCT doc_id FROM reuniao WHERE extrator='ia' UNION "
                                      "SELECT DISTINCT doc_id FROM fluxo WHERE extrator='ia' UNION "
                                      "SELECT DISTINCT doc_id FROM cargo WHERE extrator='ia'")}
    ok = bad = 0
    for path in sorted(ANSWERS.glob("*.json")):
        doc_id = path.stem
        if doc_id in done:
            continue
        doc = con.execute("""SELECT d.autarquia, d.unidade, c.data_doc, c.orgao, c.tipo FROM documento d
                             JOIN classificacao c ON c.documento_id=d.id AND c.parte=0 WHERE d.id=?""", (doc_id,)).fetchone()
        if not doc:
            continue
        try:
            a = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as e:
            review(con, doc_id, "resposta", f"JSON inválido: {e}", 1)
            bad += 1
            continue
        if a.get("pedir_paginas"):
            continue   # pedido de mais texto: tratado no export
        pages = {p["n"]: p["texto"] for p in con.execute("SELECT n, texto FROM pagina WHERE documento_id=?", (doc_id,))}
        aut, unit = doc["autarquia"], doc["unidade"]
        conf = float(a.get("confianca", 0.85))

        def P(item, extra_check=True, what="item"):
            nonlocal bad
            pg, ex = item.get("pagina") or 1, item.get("excerto") or ""
            if not excerpt_ok(ex, pages, pg):
                review(con, doc_id, what, f"excerto não encontrado no texto: «{ex[:120]}»")
                bad += 1
                return None
            if not extra_check:
                review(con, doc_id, what, f"valor/data inválido ou montante não está no excerto: «{ex[:120]}»")
                bad += 1
                return None
            return dict(doc_id=doc_id, pagina=pg, excerto=ex[:600], metodo="llm", extrator="ia", versao=PROMPT_VERSION,
                        confianca=conf, criado=now())

        # reunião
        rid = None
        r = a.get("reuniao")
        if r:
            pv = P(r, date_ok(r.get("data")), "reunião")
            if pv:
                orgao, rdate = r.get("orgao") or doc["orgao"], r.get("data") or doc["data_doc"]
                rid = "r-" + short_id(aut, unit, orgao, rdate)   # uma reunião, vários documentos (edital, ata, notícia)
                old = con.execute("SELECT ata_doc, edital_doc, numero, local FROM reuniao WHERE id=?", (rid,)).fetchone()
                is_ata = doc["tipo"].startswith("ata")
                if old and old["ata_doc"] and not is_ata:
                    pv = None   # já há ata: o resto não substitui a fonte
                else:
                    insert(con, "reuniao", dict(id=rid, autarquia=aut, unidade=unit, orgao=orgao, data=rdate, tipo=r.get("tipo"),
                                                numero=r.get("numero") or (old["numero"] if old else None),
                                                local=r.get("local") or (old["local"] if old else None),
                                                ata_doc=doc_id if is_ata else None,
                                                edital_doc=(old["edital_doc"] if old else None) or (None if is_ata else doc_id), **pv))
                ok += 1
        mdate = (r or {}).get("data") or doc["data_doc"]
        for x in a.get("presencas") or []:
            pv = P(x, x.get("estado") in ("presente", "ausente", "justificada"), "presença")
            pid = get_person(con, x.get("nome"))
            if pv and rid and pid:
                insert(con, "presenca", dict(reuniao_id=rid, pessoa_id=pid, estado=x["estado"], **pv))
                ok += 1
        dec_ids = {}
        for x in a.get("decisoes") or []:
            pv = P(x, amount_ok(x.get("valor"), x.get("excerto")) and (x.get("area") in AREAS) and (x.get("tipo") in DEC_TYPES), "decisão")
            if not pv:
                continue
            did = "d-" + short_id(doc_id, x.get("ordem"), x.get("assunto"))
            dec_ids[x.get("ordem")] = did
            insert(con, "decisao", dict(id=did, reuniao_id=rid, autarquia=aut, unidade=unit, data=mdate, ordem=x.get("ordem"),
                                        assunto=x.get("assunto"), resumo=x.get("resumo"), tipo=x.get("tipo"), area=x.get("area"),
                                        tags=json.dumps(x.get("tags") or [], ensure_ascii=False), valor_cent=cents(x.get("valor")),
                                        tem_dinheiro=int(x.get("valor") is not None or x.get("tipo") in ("apoio", "contrato")),
                                        entidades=json.dumps(x.get("entidades") or [], ensure_ascii=False), resultado=x.get("resultado"),
                                        votos_favor=x.get("votos_favor"), votos_contra=x.get("votos_contra"), abstencoes=x.get("abstencoes"),
                                        proponente=x.get("proponente"), **pv))
            ok += 1
            for v in x.get("votos") or []:
                pid = get_person(con, v.get("nome"))
                if pid and v.get("voto") in ("favor", "contra", "abstencao"):
                    insert(con, "votacao", dict(decisao_id=did, pessoa_id=pid, voto=v["voto"], declaracao=v.get("declaracao"), **pv))
            if x.get("tipo") in ("apoio", "contrato") and x.get("valor") is None:   # dinheiro sem valor escrito
                for e in x.get("entidades") or [{}]:
                    insert(con, "mencao", dict(id="m-" + short_id(did, e.get("nome")), autarquia=aut, unidade=unit, data=mdate,
                                               sobre=x.get("tipo"), entidade_id=get_entity(con, e.get("nome"), e.get("nif")) if e.get("nome") else None,
                                               texto=x.get("resumo"), **pv))
        for i, x in enumerate(a.get("fluxos") or []):
            valid = (amount_ok(x.get("valor"), x.get("excerto")) and x.get("direcao") in ("entrada", "saida")
                     and x.get("origem") in ORIGINS and x.get("destino") in ORIGINS
                     and date_ok(x.get("data")) and date_ok(x.get("periodo_inicio")) and date_ok(x.get("periodo_fim")))
            pv = P(x, valid, "fluxo")
            if not pv:
                continue
            eid = get_entity(con, x.get("entidade"), x.get("nif")) if x.get("entidade") else None
            d0 = x.get("periodo_inicio") or x.get("data") or mdate
            insert(con, "fluxo", dict(
                id="f-" + short_id(doc_id, "ia", i), autarquia=aut, unidade=unit, direcao=x["direcao"], valor_cent=cents(x.get("valor")),
                data=x.get("data"), periodo_inicio=d0, periodo_fim=x.get("periodo_fim") or x.get("data") or d0,
                granularidade="date" if x.get("data") else "period", origem=x["origem"], destino=x["destino"], entidade_id=eid,
                categoria=x.get("categoria"), instrumento=x.get("instrumento"), nivel="known" if x.get("valor") is not None else "unknown",
                tipo_valor=x.get("tipo_valor"), decisao_id=dec_ids.get(x.get("decisao_ordem")), descricao=x.get("descricao"), **pv))
            ok += 1
        for i, x in enumerate(a.get("saldos") or []):
            pv = P(x, amount_ok(x.get("valor"), x.get("excerto")) and date_ok(x.get("data")) and x.get("valor") is not None, "saldo")
            if pv:
                insert(con, "saldo", dict(id="s-" + short_id(doc_id, i), autarquia=aut, unidade=unit, data=x.get("data") or mdate,
                                          conta=x.get("conta") or "total", valor_cent=cents(x["valor"]), **pv))
                ok += 1
        for i, x in enumerate(a.get("cargos") or []):
            pv = P(x, date_ok(x.get("inicio")) and date_ok(x.get("fim")), "cargo")
            pid = get_person(con, x.get("nome"))
            if pv and pid:
                insert(con, "cargo", dict(id="cg-" + short_id(doc_id, i, pid), pessoa_id=pid, autarquia=aut, unidade=unit,
                                          orgao=x.get("orgao"), funcao=x.get("funcao"), lista=x.get("lista"), inicio=x.get("inicio") or mdate,
                                          fim=x.get("fim"), motivo_fim=x.get("motivo_fim"), **pv))
                ok += 1
        for i, x in enumerate(a.get("instrumentos") or []):
            pv = P(x, amount_ok(x.get("valor"), x.get("excerto")), "instrumento")
            if pv:
                fr = x.get("freguesia") or ""
                insert(con, "instrumento", dict(id="in-" + short_id(doc_id, i), municipio="esposende", freguesia=fr,
                                                unidade=unit, tipo=x.get("tipo"), tarefa=x.get("tarefa"), ano=x.get("ano"),
                                                valor_cent=cents(x.get("valor")), lado="camara" if aut == "esposende" else "junta",
                                                decisao_ref=x.get("decisao_ref"), **pv))
                ok += 1
        for i, x in enumerate(a.get("obras") or []):
            pv = P(x, amount_ok(x.get("custo_previsto"), x.get("excerto")) or amount_ok(x.get("custo_executado"), x.get("excerto")), "obra")
            if pv:
                insert(con, "obra", dict(id="o-" + short_id(aut, norm(x.get("nome"))[:40], x.get("local_texto")), autarquia=aut, unidade=unit,
                                         nome=x.get("nome"), tipo=x.get("tipo"), local_texto=x.get("local_texto"),
                                         custo_previsto=cents(x.get("custo_previsto")), custo_executado=cents(x.get("custo_executado")),
                                         inicio=x.get("inicio"), fim=x.get("fim"), estado=x.get("estado"), decisoes=json.dumps([doc_id]), **pv))
                ok += 1
        for i, x in enumerate(a.get("beneficios") or []):
            pv = P(x, True, "benefício")
            if pv:
                insert(con, "beneficio", dict(id="b-" + short_id(doc_id, i), autarquia=aut, entidade_id=get_entity(con, x.get("entidade"), x.get("nif")),
                                              tipo=x.get("tipo"), valor_estimado=cents(x.get("valor_estimado")), descricao=x.get("descricao"), **pv))
                ok += 1
        e = a.get("eleicao")
        if e:
            pv = P(e, date_ok(e.get("data")), "eleição")
            if pv:
                eid = "el-" + short_id(aut, unit, e.get("orgao"), e.get("data"))
                exists = con.execute("SELECT 1 FROM eleicao WHERE id=?", (eid,)).fetchone()
                if not exists:   # já existe (ex.: resultados oficiais): só se juntam os eleitos
                  insert(con, "eleicao", dict(id=eid, autarquia=aut, unidade=unit, orgao=e.get("orgao"), data=e.get("data"),
                                            inscritos=e.get("inscritos"), votantes=e.get("votantes"), brancos=e.get("brancos"),
                                            nulos=e.get("nulos"), mandatos_total=sum(int(l.get("mandatos") or 0) for l in e.get("listas") or []) or None, **pv))
                for l in ([] if exists else e.get("listas") or []):
                    insert(con, "eleicao_lista", dict(eleicao_id=eid, lista=l.get("lista"), nome_lista=l.get("lista"), votos=l.get("votos"),
                                                      pct=None, mandatos=l.get("mandatos")))
                for el in e.get("eleitos") or []:
                    insert(con, "eleito", dict(eleicao_id=eid, lista=el.get("lista"), ordem=el.get("ordem") or 0, nome=el.get("nome"), efetivo=1, eleito=1))
                    get_person(con, el.get("nome"))
                ok += 1
    con.commit()
    return ok, bad

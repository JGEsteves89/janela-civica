"""Regra R3 — um facto conta uma vez: decisões que são passos da mesma coisa formam um processo.

Só valores a partir de 5 000 € (abaixo disso, valores iguais são quase sempre coincidência: "Bebé do ano" todos os anos).
Palavra própria = palavra do TÍTULO de uma decisão que aparece no texto da outra (não conta "aprovação", "Câmara", "informação"…).
- Passos (mesma direção): valor quase igual (±1%), até 400 dias, palavra própria em comum
  (ex.: abertura → adjudicação da "ampliação do cemitério").
- Financiamento: uma entrada vinda de quem financia (Estado, Câmara, UE, outra autarquia) que paga 40–102% de uma saída,
  até 400 dias, com palavra própria em comum (ex.: verba da Câmara → pagamento do "autocarro").
"""
import re

from ..common import log, norm

BUDGET = re.compile(r"^(\d+\.ª )?(orçamento|plano plurianual|grandes opções|alteração (permutativa|modificativa)|revisão|retificação|contas|controlo orçamental)", re.I)
MIN = 5_000_00
FINANCIA = {"estado", "municipio", "ue", "outra_autarquia"}
# palavras que dizem o passo ou o lugar, não a coisa
VAZIAS = set("""aprovada aprovado aprovacao aprovou deliberada deliberado deliberou unanimidade maioria abertura procedimento
adjudicacao adjudicada adjudicado adjudicar empreitada pagamento pagar protocolo contrato contratos valor valores proposta
assembleia segue apoio apoios financeiro financeira verba verbas transferiu transferencia euros estimado mais total
parte usada freguesia freguesias uniao camara municipal municipio esposende apulia junta executivo pecas aprovar
janeiro fevereiro marco abril junho julho agosto setembro outubro novembro dezembro meses tranches leasing divida
publico publica concurso ajuste direto despesa despesas receita compra informacao informacoes escrita presidente
geral carater outras outros controlo orcamental orcamento retificacao pedido assunto sobre relativo referente ponto
subsidio transferencia aquisicao venda donativo donativos contas habitual diversos varios""".split())


def words(t):
    return {w for w in re.findall(r"[a-z]{5,}", norm(t or "")) if w not in VAZIAS}


def shared(a, b):
    """Palavras do título de uma que aparecem no texto da outra."""
    return (a["t"] & b["w"]) | (b["t"] & a["w"])


def days(a, b):
    from datetime import date
    return abs((date.fromisoformat(a[:10]) - date.fromisoformat(b[:10])).days)


def run(con):
    con.execute("DELETE FROM processo")
    decs = [dict(r) for r in con.execute(
        """SELECT d.id, d.autarquia, d.unidade, d.data, d.assunto, d.resumo, d.valor_cent,
                  (SELECT direcao FROM fluxo f WHERE f.decisao_id=d.id LIMIT 1) dir,
                  (SELECT origem FROM fluxo f WHERE f.decisao_id=d.id LIMIT 1) origem
           FROM decisao d WHERE d.superseded=0 AND d.valor_cent >= ? AND d.data IS NOT NULL""", (MIN,))]
    decs = [d for d in decs if not BUDGET.match(d["assunto"] or "")]
    for d in decs:
        d["dir"] = d["dir"] or "saida"
        d["t"] = words(d["assunto"])
        d["w"] = d["t"] | words(d["resumo"])
    parent = {d["id"]: d["id"] for d in decs}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    # 1. passos do mesmo processo
    for i, a in enumerate(decs):
        for b in decs[i + 1:]:
            if (a["autarquia"], a["unidade"], a["dir"]) != (b["autarquia"], b["unidade"], b["dir"]):
                continue
            hi = max(a["valor_cent"], b["valor_cent"])
            if abs(a["valor_cent"] - b["valor_cent"]) <= 0.01 * hi and days(a["data"], b["data"]) <= 400 and shared(a, b):
                parent[find(b["id"])] = find(a["id"])
    groups = {}
    for d in decs:
        groups.setdefault(find(d["id"]), []).append(d)

    def info(g):
        return dict(val=max(x["valor_cent"] for x in g), w=set().union(*(x["w"] for x in g)), t=set().union(*(x["t"] for x in g)),
                    fin=any(x["origem"] in FINANCIA for x in g),
                    dates=[x["data"] for x in g], key=(g[0]["autarquia"], g[0]["unidade"]), dir=g[0]["dir"],
                    pid=min(g, key=lambda x: x["data"])["id"])
    G = {k: info(g) for k, g in groups.items()}

    # 2. entradas que financiam uma saída
    funds = {}
    for ke, e in G.items():
        if e["dir"] != "entrada" or not e["fin"]:
            continue
        best = None
        for ks, s in G.items():
            if s["dir"] != "saida" or s["key"] != e["key"]:
                continue
            common = shared(e, s)
            near = min(days(a, b) for a in e["dates"] for b in s["dates"])
            if common and near <= 400 and 0.4 * s["val"] <= e["val"] <= 1.02 * s["val"]:
                score = (len(common), -abs(s["val"] - e["val"]))
                if not best or score > best[0]:
                    best = (score, ks, common)
        if best:
            funds[ke] = best

    n_proc = n_fin = 0
    for k, g in groups.items():
        pid = G[k]["pid"]
        if k in funds:
            pid, papel = G[funds[k][1]]["pid"], "financiamento"
            motivo = "financia: " + ", ".join(sorted(funds[k][2]))
            n_fin += 1
        elif len(g) > 1 or any(G[x]["dir"] == "entrada" and funds[x][1] == k for x in funds):
            papel, motivo = "passo", "mesmo valor e palavras: " + ", ".join(sorted(G[k]["w"]))[:200]
            n_proc += len(g) > 1
        else:
            continue
        for d in g:
            con.execute("INSERT OR REPLACE INTO processo VALUES (?,?,?,?,?)", (d["id"], pid, papel, d["dir"], motivo))
    con.commit()
    log(f"  processos: {n_proc} com vários passos, {n_fin} entradas ligadas à saída que financiam")

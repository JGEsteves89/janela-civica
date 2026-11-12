"""Etapa 4 — Extrair factos: regras para tabelas e dados estruturados; IA (tarefas/respostas) para texto narrativo."""
from ..common import connect, log, unidades
from . import llm, rules


def run(force=False):
    con = connect()
    stats = rules.run(con)
    log("Extração por regras:", stats)
    local = {u for u, v in unidades().items() if v["autarquia"] == "fao"}
    ok, bad = llm.import_answers(con)
    log(f"Respostas da IA importadas: {ok} factos válidos, {bad} rejeitados (ver fila de revisão)")
    log(f"Eventos com data: {llm.import_events(con)}")
    log(f"Empréstimos e dívidas: {llm.import_divida(con)}")
    n = llm.export(con, local)
    pending = len(list(llm.TASKS.glob("*.json"))) - len(list(llm.ANSWERS.glob("*.json")))
    log(f"Tarefas para a IA: {n} novas, {max(0, pending)} por responder em {llm.TASKS}")

"""Etapa 6 — Calcular: calendário, dinheiro, estimativas, pontuação, alertas, achados, temas."""
from ..common import connect, log
from . import calendar, findings, flags, money, processos, score


def run():
    con = connect()
    log("Calcular:")
    from .. import verificar
    verificar.run(con)   # regras de REGRAS.md, sempre primeiro
    calendar.run(con)
    money.run(con)
    processos.run(con)
    from . import livro
    livro.run(con)
    score.run(con)
    flags.run(con)
    findings.run(con)
    from .. import review
    review.import_decisions(con)
    n = review.export(con)
    log(f"Calcular terminado. Fila de revisão: {n} itens.")

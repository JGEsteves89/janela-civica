"""Janela Cívica — pipeline.

  python run.py recolher [--autarquia fao] [--fonte jffao]   1 Recolha (sites, BASE, eleições, INE, caixa)
  python run.py ler [--forcar]                              2 Texto por página + OCR
  python run.py classificar                                 3 Tipo, período, órgão
  python run.py extrair                                     4 Factos (regras; tarefas para a IA)
  python run.py resolver                                    5 Entidades, pessoas, ligações
  python run.py calcular                                    6 Calendário, dinheiro, estimativas, pontuação, alertas
  python run.py publicar                                    8 JSON + site em public/
  python run.py tudo                                        todas as etapas, por ordem
"""
import argparse
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("etapa", choices=["recolher", "ler", "classificar", "extrair", "resolver", "calcular", "publicar", "tudo"])
    ap.add_argument("--autarquia")
    ap.add_argument("--fonte")
    ap.add_argument("--forcar", action="store_true")
    ap.add_argument("--limite", type=int)
    ap.add_argument("--pausa", type=float, default=1.0, help="segundos entre pedidos ao mesmo site")
    a = ap.parse_args()
    steps = ["recolher", "ler", "classificar", "extrair", "resolver", "calcular", "publicar"] if a.etapa == "tudo" else [a.etapa]
    for s in steps:
        if s == "recolher":
            from janela import collect
            collect.run(a.autarquia, a.fonte, a.pausa)
        elif s == "ler":
            from janela import read
            read.run(force=a.forcar, limit=a.limite)
        elif s == "classificar":
            from janela import classify
            classify.run(force=a.forcar)
        elif s == "extrair":
            from janela import extract
            extract.run(force=a.forcar)
        elif s == "resolver":
            from janela import resolve
            resolve.run()
        elif s == "calcular":
            from janela import compute
            compute.run()
        elif s == "publicar":
            from janela import publish
            publish.run()


if __name__ == "__main__":
    main()

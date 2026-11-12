# Regras dos dados

Regras simples. Valem para todas as autarquias e para todos os dados.

## As regras

| # | Regra | Onde é garantida |
|---|-------|------------------|
| R1 | **Cada campo só aceita o tipo certo.** Uma entidade é uma organização ou pessoa que paga ou recebe. Nunca um documento, evento, total, categoria ou a própria autarquia. | `resolve.is_entity_name`, `verificar.r1` |
| R2 | **Previsto não é gasto. Empréstimo não é receita. Pagar dívida não é despesa nova.** Orçamentos não contam como gasto; empréstimos e o seu pagamento aparecem à parte ("Mandatos e dívida"). | `compute/money.py`, `verificar.r2`, `web/js/app.js` (J.DEBT) |
| R3 | **Um facto conta uma vez.** O mesmo valor em duas fontes conta só uma vez. Decisões que são passos da mesma coisa (abertura → adjudicação → pagamento) são **um processo**; a entrada que paga uma saída fica ligada a ela ("financiado por"). | `compute/money.py` (coberto, duplicados), `compute/processos.py` |
| R4 | **Um nome, uma identidade.** Mesmo NIF = mesma entidade. Nomes parecidos juntam-se. Todas as entidades têm aliases. | `resolve.candidate_merges`, `verificar.r4` |
| R5 | **Datas e valores têm de ser possíveis.** Data entre 1990 e hoje + 2 anos; valor ≥ 0 e < 100 M€. | `verificar.r5` (vai para revisão) |
| R6 | **Tudo tem fonte.** Cada valor tem documento, página e excerto, e os números do valor estão no excerto. | `extract/llm.py` (validação) |
| R8 | **Estado não é movimento.** "Faturas por liquidar", "em dívida", "recebimentos pendentes" e saldos descrevem as contas num dia: vão para dívida/saldos, nunca para entradas ou saídas. Uma decisão de informação só mostra + ou − se houver um movimento real; senão mostra o valor sem sinal. "De onde vem" só aparece com a origem real do dinheiro. | `verificar.r8`, `publish.py` (direcao "estado"), `web/js` (J.money) |
| R7 | **O site mostra texto para pessoas.** Nunca chaves internas (`fao-2021`, `saida`). Entradas sempre com **+** e cor `--in`; saídas com **−** e cor `--out`. | `web/js/app.js` (J.sc, J.unitName…) |

## Regra para qualquer correção

Quando aparece um erro, não basta corrigir o caso. Fazer sempre os 4 passos:

1. **Corrigir os dados** do caso.
2. **Achar a regra** (R1–R8) que falhou. Se nenhuma serve, criar uma nova regra **genérica** (para a família do erro, não para o caso).
3. **Pôr a regra no código:** um filtro na entrada e uma verificação em `janela/verificar.py`. Se for seguro, corrige sozinha; se não, vai para a fila de revisão.
4. **Pôr a regra nas instruções da IA** (`INSTRUCOES` em `extract/llm.py`) e nesta tabela.

`verificar.py` corre sempre no início de `calcular`, por isso a regra vale também para dados antigos.

## Como mudar ficheiros

- Mudar sempre o ficheiro **no sítio**, com pequenas edições. Nunca copiar um ficheiro inteiro por cima de outro.
- Antes de mudar, ver a data do ficheiro. Se mudou desde a última leitura, ler outra vez e só depois editar.

## Totais "Entrou / Saiu"

- Cada total mostra **"sabemos de onde / para onde"** (valores lidos nos documentos) e **"sem explicação"** (diferença de saldos: o dinheiro saiu da conta, mas nenhum documento diz para onde).
- A direção de uma decisão vem do seu movimento. Se tem entrada e saída (a Câmara paga uma obra), conta como **saída financiada**.

## Livro do ano (contabilidade refeita)

- **Âncora:** as contas oficiais do ano (saldo inicial + entradas − saídas = saldo final). Tem de bater certo.
- **A IA só anota menções** (cada vez que um documento fala de dinheiro, com a fase: previsto, pedido, aprovado, adjudicado, faturado, pago, recebido, estado). Instruções: `data/revisao/ia/INSTRUCOES_MENCOES.md`.
- **Só "pago" e "recebido" são dinheiro que mexeu.** O mesmo pagamento em vários documentos é uma só transação (muitos-para-muitos com os documentos).
- **Compromissos** (aprovado, adjudicado, faturado, pedido) ligam-se ao pagamento que os cumpre; sem pagamento ficam "sem pagamento visto" e não contam.
- **A diferença aparece por categoria** ("sem detalhe"), nunca como um só valor às cegas. Encontrar mais do que as contas dizem é um alerta (duplicado ou data errada).
- Categorias iguais às das contas: Segurança Social, descontos e salários = pessoal; orçamentos e planos = previsto.

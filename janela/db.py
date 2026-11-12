"""Esquema SQLite. Cada etapa escreve nas suas tabelas; nada é apagado, versões antigas ficam com superseded=1.

Todo o facto publicado (fluxo, decisão, cargo, apoio, contrato, obra...) tem proveniência:
doc_id + pagina + excerto (frase exata) + metodo (manual/regra/llm) + extrator + versao + confianca.
"""

PROV = """
  doc_id TEXT, pagina INTEGER, excerto TEXT,
  metodo TEXT, extrator TEXT, versao TEXT, confianca REAL,
  revisto TEXT, superseded INTEGER DEFAULT 0, criado TEXT
"""

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS crawl (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fonte TEXT, autarquia TEXT, unidade TEXT,
  inicio TEXT, fim TEXT, paginas INTEGER DEFAULT 0, novos INTEGER DEFAULT 0, erros INTEGER DEFAULT 0, nota TEXT);

-- mapa do site em cada recolha (para saber se um documento desapareceu)
CREATE TABLE IF NOT EXISTS link_visto (
  crawl_id INTEGER, url TEXT, found_on TEXT, link_text TEXT, PRIMARY KEY (crawl_id, url));

CREATE TABLE IF NOT EXISTS ficheiro (
  sha256 TEXT PRIMARY KEY, mime TEXT, ext TEXT, bytes INTEGER, path TEXT, first_seen TEXT);

-- um documento = um conteúdo (hash). URLs diferentes com o mesmo conteúdo apontam para o mesmo documento.
CREATE TABLE IF NOT EXISTS documento (
  id TEXT PRIMARY KEY, sha256 TEXT, autarquia TEXT, unidade TEXT, fonte TEXT,
  titulo TEXT, url TEXT, found_on TEXT, link_text TEXT, date_hint TEXT, http_date TEXT,
  mime TEXT, first_seen TEXT, last_seen TEXT, removed_at TEXT,
  link_only INTEGER DEFAULT 0, nota TEXT, meta TEXT);
CREATE INDEX IF NOT EXISTS ix_doc_aut ON documento(autarquia, unidade);

CREATE TABLE IF NOT EXISTS url (
  url TEXT PRIMARY KEY, documento_id TEXT, fonte TEXT, found_on TEXT, link_text TEXT,
  first_seen TEXT, last_seen TEXT, removed_at TEXT, http_status INTEGER, etag TEXT, last_modified TEXT);

CREATE TABLE IF NOT EXISTS pagina (
  documento_id TEXT, n INTEGER, texto TEXT, metodo TEXT, chars INTEGER, qualidade REAL,
  PRIMARY KEY (documento_id, n));
CREATE VIRTUAL TABLE IF NOT EXISTS pagina_fts USING fts5(documento_id UNINDEXED, n UNINDEXED, texto,
  tokenize='unicode61 remove_diacritics 2');

CREATE TABLE IF NOT EXISTS leitura (
  documento_id TEXT PRIMARY KEY, estado TEXT, paginas INTEGER, chars INTEGER, qualidade REAL,
  paginas_ocr INTEGER, versao TEXT, quando TEXT);

CREATE TABLE IF NOT EXISTS classificacao (
  documento_id TEXT, parte INTEGER DEFAULT 0, pag_de INTEGER, pag_ate INTEGER,
  tipo TEXT, grupo TEXT, orgao TEXT, unidade TEXT,
  periodo_inicio TEXT, periodo_fim TEXT, data_doc TEXT, data_publicacao TEXT, numero TEXT,
  confianca REAL, metodo TEXT, versao TEXT, quando TEXT, rever INTEGER DEFAULT 0, motivo TEXT,
  refere TEXT, PRIMARY KEY (documento_id, parte));

-- ---------- factos ----------
CREATE TABLE IF NOT EXISTS reuniao (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, orgao TEXT, data TEXT, tipo TEXT, numero TEXT,
  local TEXT, ata_doc TEXT, edital_doc TEXT, {PROV});

CREATE TABLE IF NOT EXISTS decisao (
  id TEXT PRIMARY KEY, reuniao_id TEXT, autarquia TEXT, unidade TEXT, data TEXT, ordem INTEGER,
  assunto TEXT, resumo TEXT, tipo TEXT, area TEXT, tags TEXT, valor_cent INTEGER, tem_dinheiro INTEGER,
  entidades TEXT, resultado TEXT, votos_favor INTEGER, votos_contra INTEGER, abstencoes INTEGER,
  proponente TEXT, {PROV});

CREATE TABLE IF NOT EXISTS pessoa (
  id TEXT PRIMARY KEY, nome TEXT, aliases TEXT, interesses TEXT);

CREATE TABLE IF NOT EXISTS cargo (
  id TEXT PRIMARY KEY, pessoa_id TEXT, autarquia TEXT, unidade TEXT, orgao TEXT, funcao TEXT,
  lista TEXT, inicio TEXT, fim TEXT, motivo_fim TEXT, {PROV});

CREATE TABLE IF NOT EXISTS presenca (
  reuniao_id TEXT, pessoa_id TEXT, estado TEXT, {PROV}, PRIMARY KEY (reuniao_id, pessoa_id));

CREATE TABLE IF NOT EXISTS votacao (
  decisao_id TEXT, pessoa_id TEXT, voto TEXT, declaracao TEXT, {PROV}, PRIMARY KEY (decisao_id, pessoa_id));

CREATE TABLE IF NOT EXISTS eleicao (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, orgao TEXT, data TEXT,
  inscritos INTEGER, votantes INTEGER, brancos INTEGER, nulos INTEGER, mandatos_total INTEGER, {PROV});
CREATE TABLE IF NOT EXISTS eleicao_lista (
  eleicao_id TEXT, lista TEXT, nome_lista TEXT, votos INTEGER, pct REAL, mandatos INTEGER,
  PRIMARY KEY (eleicao_id, lista));
CREATE TABLE IF NOT EXISTS eleito (
  eleicao_id TEXT, lista TEXT, ordem INTEGER, nome TEXT, efetivo INTEGER, eleito INTEGER,
  PRIMARY KEY (eleicao_id, lista, ordem, efetivo));

CREATE TABLE IF NOT EXISTS entidade (
  id TEXT PRIMARY KEY, nif TEXT, nome TEXT, aliases TEXT, tipo TEXT, setor TEXT,
  publica INTEGER DEFAULT 0, municipio TEXT, lat REAL, lon REAL);
CREATE TABLE IF NOT EXISTS entidade_merge (
  de TEXT PRIMARY KEY, para TEXT, quem TEXT, quando TEXT, motivo TEXT);

CREATE TABLE IF NOT EXISTS fluxo (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, direcao TEXT, valor_cent INTEGER,
  data TEXT, periodo_inicio TEXT, periodo_fim TEXT, granularidade TEXT,
  origem TEXT, destino TEXT, entidade_id TEXT, categoria TEXT, instrumento TEXT, tarefa TEXT,
  nivel TEXT, tipo_valor TEXT, tamanho_esperado INTEGER,
  decisao_id TEXT, contrato_id TEXT, apoio_id TEXT, descricao TEXT, {PROV});
CREATE INDEX IF NOT EXISTS ix_fluxo ON fluxo(autarquia, periodo_inicio);

CREATE TABLE IF NOT EXISTS saldo (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, data TEXT, conta TEXT, valor_cent INTEGER, {PROV});

CREATE TABLE IF NOT EXISTS mencao (   -- algo de que se fala sem valor (alimenta os fluxos "desconhecidos")
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, data TEXT, sobre TEXT, entidade_id TEXT, texto TEXT, {PROV});

CREATE TABLE IF NOT EXISTS linha_orcamental (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, ano INTEGER, lado TEXT, codigo TEXT, rotulo TEXT,
  categoria TEXT, previsto INTEGER, corrigido INTEGER, executado INTEGER, {PROV});

CREATE TABLE IF NOT EXISTS contrato (
  id TEXT PRIMARY KEY, base_id TEXT, autarquia TEXT, unidade TEXT, adjudicante_nif TEXT, adjudicante TEXT,
  fornecedor_id TEXT, fornecedor_nif TEXT, fornecedor TEXT, objeto TEXT, cpv TEXT, procedimento TEXT,
  preco_base INTEGER, preco_contratual INTEGER, preco_efetivo INTEGER,
  data_publicacao TEXT, data_assinatura TEXT, prazo_dias INTEGER, n_concorrentes INTEGER,
  modificacoes TEXT, local TEXT, decisao_id TEXT, raw TEXT);

CREATE TABLE IF NOT EXISTS apoio (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, decisao_id TEXT, entidade_id TEXT, valor_cent INTEGER,
  especie TEXT, finalidade TEXT, regulamento TEXT, ano INTEGER, data_decisao TEXT, pago TEXT, origem TEXT, {PROV});

CREATE TABLE IF NOT EXISTS beneficio (
  id TEXT PRIMARY KEY, autarquia TEXT, entidade_id TEXT, tipo TEXT, valor_estimado INTEGER,
  decisao_id TEXT, descricao TEXT, {PROV});

CREATE TABLE IF NOT EXISTS divida (   -- empréstimos, dívidas, prestações, ajudas (regra R2: não é receita nem despesa nova)
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, data TEXT, tipo TEXT, valor_cent INTEGER, credor TEXT,
  estado TEXT, descricao TEXT, {PROV});

CREATE TABLE IF NOT EXISTS processo (   -- decisões que são passos da mesma coisa (regra R3)
  decisao_id TEXT PRIMARY KEY, processo_id TEXT, papel TEXT, direcao TEXT, motivo TEXT);

CREATE TABLE IF NOT EXISTS evento (   -- acontecimento com data (festa, assinatura, visita, consulta pública...)
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, data TEXT, nome TEXT, {PROV});

CREATE TABLE IF NOT EXISTS obra (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, nome TEXT, tipo TEXT, local_texto TEXT,
  lat REAL, lon REAL, zona TEXT, custo_previsto INTEGER, custo_executado INTEGER,
  inicio TEXT, fim TEXT, estado TEXT, linha_gop TEXT, contratos TEXT, decisoes TEXT, {PROV});

CREATE TABLE IF NOT EXISTS instrumento (   -- Câmara <-> Junta (contratos interadministrativos, acordos, autos, protocolos)
  id TEXT PRIMARY KEY, municipio TEXT, freguesia TEXT, unidade TEXT, tipo TEXT, tarefa TEXT,
  ano INTEGER, valor_cent INTEGER, lado TEXT, decisao_ref TEXT, {PROV});

-- ---------- calculado ----------
CREATE TABLE IF NOT EXISTS esperado (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, ano INTEGER, tipo TEXT, slot TEXT,
  devido_ate TEXT, estado TEXT, documentos TEXT, motivo TEXT, pedido_id TEXT);

CREATE TABLE IF NOT EXISTS estimativa (
  id TEXT PRIMARY KEY, autarquia TEXT, alvo TEXT, metodo TEXT, inputs TEXT, nivel TEXT, explicacao TEXT, valor_cent INTEGER);

CREATE TABLE IF NOT EXISTS flag (
  id TEXT PRIMARY KEY, regra TEXT, severidade INTEGER, autarquia TEXT, unidade TEXT,
  alvo TEXT, periodo_inicio TEXT, periodo_fim TEXT, titulo TEXT, texto TEXT, evidencia TEXT,
  estado TEXT DEFAULT 'aberto', resposta TEXT, resposta_data TEXT, primeira_vez TEXT, ultima_vez TEXT, ativo INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS finding (
  id TEXT PRIMARY KEY, autarquia TEXT, titulo TEXT, resumo TEXT, flags TEXT, documentos TEXT,
  periodo_inicio TEXT, periodo_fim TEXT, importancia REAL, estado TEXT DEFAULT 'rascunho', revisto_por TEXT, quando TEXT);

CREATE TABLE IF NOT EXISTS score (
  autarquia TEXT, ano INTEGER, dimensao TEXT, valor REAL, detalhe TEXT, PRIMARY KEY (autarquia, ano, dimensao));

CREATE TABLE IF NOT EXISTS pedido_lada (
  id TEXT PRIMARY KEY, autarquia TEXT, unidade TEXT, data_envio TEXT, texto TEXT, documentos TEXT,
  prazo TEXT, data_resposta TEXT, resposta TEXT, resultado TEXT, estado TEXT DEFAULT 'rascunho');

CREATE TABLE IF NOT EXISTS revisao (
  id TEXT PRIMARY KEY, item_tipo TEXT, item_id TEXT, prioridade INTEGER, motivo TEXT,
  estado TEXT DEFAULT 'pendente', decisao TEXT, quem TEXT, quando TEXT);

CREATE TABLE IF NOT EXISTS changelog (
  autarquia TEXT, quando TEXT, tipo TEXT, texto TEXT);
"""


def ensure_schema(con):
    con.executescript(SCHEMA)

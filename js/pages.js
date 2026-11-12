/* Páginas: início, autarquia (com linha do tempo e separadores), páginas de detalhe, comparar, metodologia, sobre, resposta. */
(function () {
  const J = window.J, d3 = window.d3;
  const G = (J.pages = {});
  const EMAIL = "janela.civica@exemplo.pt";   // configurar o contacto do projeto

  G.home = async app => {
    const idx = await J.get("data/index.json").catch(() => ({ autarquias: [] }));
    app.innerHTML = `<section class="home-hero"><h1>O que a autarquia decide, gasta e publica — e o que falta publicar</h1>
      <p>Lemos os documentos públicos das juntas de freguesia e câmaras municipais. Mostramos quem governou, o que foi decidido, de onde veio e para onde foi o dinheiro, e que documentos obrigatórios não aparecem. Cada número tem a fonte.</p>
      <input type="search" id="h-q" placeholder="Procurar uma freguesia ou município" style="width:100%;max-width:520px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card)"></section>
      <div class="grid g3" id="h-list"></div>`;
    const draw = () => {
      const q = J.$("#h-q").value.toLowerCase();
      J.$("#h-list").innerHTML = idx.autarquias.filter(a => a.nome.toLowerCase().includes(q)).map(a => `<a class="card acard" href="#/${a.tipo === "municipio" ? "m" : "f"}/${a.id}">
        <div class="sub">${a.tipo === "municipio" ? "Município" : "Freguesia"}</div><h3 style="margin:2px 0 8px">${J.esc(a.nome)}</h3>
        <div class="split"><span class="scorebadge">${a.score == null ? "?" : Math.round(a.score)}<small>/100 transparência ${a.ano_score || ""}</small></span></div>
        <p class="sub">${a.documentos} documentos · ${a.alertas} alertas</p></a>`).join("") || `<div class="empty">Ainda não há autarquias publicadas.</div>`;
    };
    J.$("#h-q").addEventListener("input", draw); draw();
  };

  // separadores (barra de baixo no telemóvel, barra lateral no ecrã largo)
  // 4 separadores na barra de vidro; "Procurar" (antigo Explorar) é o botão redondo ao lado
  const TABS4 = [["inicio", "Início", "house"], ["dinheiro", "Dinheiro", "euro"], ["decisoes", "Decisões", "seal"], ["alertas", "Alertas", "bubble"]];
  const OLD_TAB = { resumo: "inicio", reunioes: "decisoes" };
  G.EXPL = { documentos: "Documentos", pessoas: "Pessoas", entidades: "Entidades", obras: "Obras", eleicoes: "Eleições", nota: "Nota por área", linha: "Linha do tempo detalhada",
    arquivo: "Todos os documentos", presencas: "Presenças e votações", graficos: "Entidades em gráficos" };
  // ecrãs mais fundos de cada separador: /<separador>/<ecrã>
  const SUBS = {
    explorar: { names: G.EXPL, draw: (el, D, S, q, k) => J.panels[k](el, D, S, q) },
    dinheiro: { names: { geral: "De onde vem e para onde vai", entradas: "Entradas", saidas: "Saídas, apoios e contratos", mes: "Por mês", livro: "Livro do ano", mandatos: "Mandatos e dívida", euro: "O meu euro" },
      draw: (el, D, S, q, k) => J.panels.analise(el, D, S, q, k) },
    decisoes: { names: { reunioes: "Reuniões" }, draw: (el, D, S, q) => J.panels.reunioes(el, D, S, q) },
    alertas: { names: { tipos: "Alertas por tipo" }, draw: (el, D, S, q) => J.panels.alertasTipos(el, D, S, q) }
  };
  // em que separador vive cada detalhe (quando o link não diz)
  const KIND_TAB = { doc: "explorar", reuniao: "decisoes", decisao: "decisoes", pessoa: "explorar", entidade: "explorar", contrato: "dinheiro", obra: "explorar", alerta: "alertas", pedidos: "explorar" };
  const shortName = A => A.nome.replace(/^(Freguesia|Município|União das Freguesias) de /, "");

  // títulos de revista por secção (rótulo em mono + título em serifa)
  const SEC = { inicio: ["Início", ""], dinheiro: ["Dinheiro", "Para onde foi o dinheiro"], decisoes: ["Decisões", "O que se decidiu"],
    alertas: ["Alertas", "O que precisa de explicação"], explorar: ["Procurar", "Procurar"] };
  G.autarquia = (app, D, rest, q) => {
    const A = D.aut;
    // links antigos (?tab=resumo, ?tab=documentos…) continuam a funcionar
    if (OLD_TAB[q.tab]) { location.replace(J.href(J.base(D), { tab: OLD_TAB[q.tab] })); return; }
    if (G.EXPL[q.tab] && !rest.length) { location.replace(J.href(J.base(D) + "/explorar/" + q.tab, { tab: "explorar" })); return; }
    if (q.tab === "dinheiro" && q.sub && !rest.length) { location.replace(J.href(J.base(D) + "/dinheiro/" + q.sub, { tab: "dinheiro" })); return; }
    const S = J.selection(D, q.sel);
    const SUB = SUBS[rest[0]] && SUBS[rest[0]].names[rest[1]] ? SUBS[rest[0]] : null;
    const isExpl = !!SUB;   // ecrã mais fundo de um separador (mostra a pílula, não é um detalhe)
    const detail = rest.length && !isExpl;
    const tab = isExpl ? rest[0] : q.tab && SEC[q.tab] ? q.tab : detail ? KIND_TAB[rest[0]] || "inicio" : "inicio";
    const flagsSel = (D.alertas.alertas || []).filter(f => J.inSel(S, f.periodo_inicio, f.periodo_fim));
    const n3 = flagsSel.filter(f => f.severidade === 3).length;
    const sub = isExpl ? SUB.names[rest[1]] : null;
    // pílula de vidro na barra de cima: partido (com a sua cor), presidente, período, pontuação
    const m = S.kind === "m" ? S.m : J.mandateAt(D, S.to > J.today ? J.today : S.to);
    const pres = m && m.presidente ? m.presidente.split(" ").filter(Boolean) : [];
    const who = pres.length ? `${pres[0][0]}. ${pres[pres.length - 1]}` : "?";
    const what = S.kind === "m" ? `${S.m.inicio.slice(2, 4)}–${S.m.fim && S.m.fim < J.today ? S.m.fim.slice(2, 4) : "hoje"}` : S.kind === "a" ? String(S.year) : S.label;
    const pc = m && m.lista ? J.partyColor(A, m.lista) : "var(--unread)";
    const score = J.scoreOf(D, S.from, S.to);
    const pill = detail ? "" : `<button class="pill glass" id="pill" type="button" style="--pc:${pc}" aria-label="Mandato: ${J.esc(m && m.lista || "partido desconhecido")}, ${J.esc(m && m.presidente || "presidente desconhecido")}, ${J.esc(what)}. Tocar para mudar de período.">
        <span class="pparty">${J.esc(m && m.lista || "?")}</span><span class="pill-who">${J.esc(who)}</span><span class="pill-when">${J.esc(what)}</span>${score == null ? "" : `<b class="pill-sc num" style="color:${J.scoreColor(score / 100)}">${score}</b>`}${J.ICON.down}</button>`;
    J.chrome({
      sec: tab, tab, atRoot: !rest.length, center: pill,
      back: detail ? { href: J.href(J.base(D), { tab }), label: "Voltar" } : isExpl ? { href: J.href(J.base(D), { tab }), label: SEC[tab][0] } : { href: "#/", label: "Autarquias" },
      tabs: TABS4.map(([k, l, i]) => [k, l, J.ICON[i], k === "alertas" && n3 ? n3 : "", J.href(J.base(D), { tab: k })]),
      search: J.href(J.base(D), { tab: "explorar" }),
      menu: () => G.autMenu(D, S)
    });
    const kind = A.tipo === "municipio" ? "Município" : "Freguesia";
    const parent = A.municipio ? A.municipio[0].toUpperCase() + A.municipio.slice(1) : "";
    const period = S.kind === "m" ? `${S.m.inicio.slice(0, 4)}–${S.m.fim && S.m.fim < J.today ? S.m.fim.slice(0, 4) : "hoje"}` : S.label;
    const tag = tab === "inicio" && !isExpl ? `${kind}${parent ? " · " + parent : ""}` : `${isExpl ? sub && SEC[tab][0] : SEC[tab][0]} · ${shortName(A)}${tab === "explorar" ? "" : " · " + period}`;
    const title = isExpl ? sub : tab === "inicio" ? shortName(A) : SEC[tab][1];
    if (detail) app.innerHTML = `<section id="panel" class="detail"></section>`;
    else app.innerHTML = `<header class="lt"><div class="tag">${J.esc(tag)}</div><h1 class="serif">${J.esc(title)}${tab === "inicio" && !isExpl ? ` <span class="lt-when" style="--pc:${pc}">${J.esc(S.kind === "a" ? String(S.year) : period)}</span>` : ""}</h1></header>
      ${tab === "inicio" && !isExpl || J.wide() && tab !== "explorar" ? `<section class="hero glass-card" id="hero" aria-label="Linha do tempo"></section>` : ""}<section id="panel"></section>`;
    if (J.$("#hero")) J.timeline.hero(J.$("#hero"), D, S);
    if (J.$("#pill")) J.$("#pill").onclick = () => G.picker(D, S);   // a cápsula muda o período
    const panel = J.$("#panel");
    if (detail) return G.detail(panel, D, S, rest, q);
    if (isExpl) return SUB.draw(panel, D, S, q, rest[1]);
    if (tab === "inicio") return G.inicio(panel, D, S, q, flagsSel, n3);
    return J.panels[tab](panel, D, S, q);
  };

  // Início: frase-veredicto + cartões "bento" + carrosséis
  const FOUND = ["present", "late", "present_unreadable", "present_no_numbers"];
  // quanto sabemos do dinheiro de uma direção: total conhecido, parte sem explicação, categorias (regras R2/R3)
  G.moneySplit = (D, S, dir) => {
    const fs = J.flowsOf(D).filter(f => f.direcao === dir && !f.coberto && f.tipo_valor !== "previsto" && f.valor_cent != null && !J.DEBT.has(f.categoria)
      && J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim));
    const val = f => f.valor_cent;
    const known = fs.filter(f => (f.nivel || "known") === "known"), gap = d3.sum(fs.filter(f => f.nivel === "derived"), val);
    const SHORT = { transferencias_municipio: "Câmara", transferencias_estado: "Estado", fundos_europeus: "Fundos europeus", taxas: "Taxas", vendas: "Vendas",
      rendas: "Rendas", pessoal: "Pessoal", bens_servicos: "Bens e serviços", apoios: "Apoios", obras: "Obras", outras_despesas: "Outras despesas", outras_receitas: "Outras receitas",
      desconhecida: "Sem categoria", juros_divida: "Juros e dívida" };
    const lbl = f => f.instrumento === "contrato_publico" ? "Contratos" : SHORT[f.categoria] || J.CAT[f.categoria] || "Outros";
    return { k: d3.sum(known, val), gap, cats: d3.rollups(known, v => d3.sum(v, val), lbl).sort((a, b) => b[1] - a[1]) };
  };
  // folha com todos os números de Entrou e Saiu
  G.moneySheet = (D, S) => {
    const t = J.moneyTotals(D, S), vin = t.in.known + t.in.derived, vout = t.out.known + t.out.derived;
    const part = (dir, total) => {
      const x = G.moneySplit(D, S, dir), isIn = dir === "entrada";
      return J.glist(x.cats.map(([c, v]) => ({ title: J.esc(c), value: `<span class="num">${J.eur(v)}</span>`, sub: `${Math.round(v / (total || 1) * 100)}% do total` }))
        .concat(x.gap ? [{ title: `<span class="sub">${isIn ? "Sem origem conhecida" : "Sem explicação"}</span>`, value: `<span class="num">${J.eur(x.gap)}</span>`,
          sub: `Calculado pelos saldos do banco, sem documento que diga ${isIn ? "de onde veio" : "para onde foi"}` }] : []),
        `${isIn ? "Entrou" : "Saiu"} · <span class="num ${isIn ? "pos" : "neg"}">${J.eur(total)}</span>`);
    };
    J.sheet(`<div class="tag">Dinheiro · ${J.esc(S.kind === "m" ? `${S.m.inicio.slice(0, 4)}–${S.m.fim && S.m.fim < J.today ? S.m.fim.slice(0, 4) : "hoje"}` : S.label)}</div>
      <h2 class="sheet-t serif">De onde veio e para onde foi</h2><p class="note">Empréstimos não contam como receita nem como despesa.</p>
      ${part("entrada", vin)}${part("saida", vout)}
      ${J.glist([{ href: J.href(J.base(D), { tab: "dinheiro" }), title: "Abrir Dinheiro" }])}`, { detent: "large" });
  };
  G.inicio = (el, D, S, q, flagsSel, n3) => {
    const A = D.aut, base = J.base(D);
    const score = J.scoreOf(D, S.from, S.to);
    const expSel = (D.documentos.esperado || []).filter(e => e.estado !== "not_applicable" && J.inSel(S, `${e.ano}-01-01`, `${e.ano}-12-31`) && (S.kind !== "m" || e.unidade === S.unit || !S.unit));
    const found = expSel.filter(e => FOUND.includes(e.estado)).length;
    const t = J.moneyTotals(D, S);
    const vin = t.in.known + t.in.derived, vout = t.out.known + t.out.derived, saldo = vin - vout;
    const gapOut = G.moneySplit(D, S, "saida").gap;
    const fr = expSel.length ? found / expSel.length : null;
    // frase-veredicto em linguagem de jornal
    const how = fr == null ? "" : fr < .15 ? "quase nada" : fr < .4 ? "menos de metade" : fr < .6 ? "metade" : fr < .85 ? "a maior parte" : "quase tudo";
    const verdict = `${J.esc(shortName(A))} ${fr == null ? "ainda não tem calendário de documentos" : `publica ${how} do que devia`}.${n3 ? ` <em>${n3} ${n3 === 1 ? "ponto" : "pontos"} por explicar.</em>` : " <em>Nada por explicar.</em>"}`;
    const mx = Math.max(vin, vout) || 1;
    const fl = flagsSel.filter(f => f.severidade === 3).concat(flagsSel.filter(f => f.severidade === 2)).slice(0, 8);
    const decs = J.topDecisions(D, S, 8), rec = J.topRecipients(D, S, 8);
    const head = (title, href) => `<div class="shead"><h2 class="tag">${title}</h2>${href ? `<a href="${href}">Ver ${J.ICON.chev}</a>` : ""}</div>`;
    const carousel = (cards, empty) => cards.length ? `<div class="carousel">${cards.join("")}</div>` : `<div class="card empty-card sub">${empty}</div>`;
    el.innerHTML = `<p class="verdict serif">${verdict}</p>
      <div class="bento">
        <a class="bc score tall" href="${J.href(base + "/explorar/nota", { tab: "explorar" })}"><span class="tag">Transparência</span>
          <span class="ringwrap big">${J.ch.ring(score)}<span class="ring-n"><b class="num" ${score == null ? "" : `data-count="${score}" data-key="sc"`}>${score == null ? "?" : score}</b><small>/100</small></span></span>
          <span class="bc-s">Porquê esta nota ${J.ICON.chev}</span></a>
        <a class="bc alert fill" href="${J.href(base, { tab: "alertas" })}"><span class="tag">Alertas</span>
          <b class="bc-n num" data-count="${n3}" data-key="n3">${n3}</b><span class="bc-l">por explicar</span><span class="bc-s"><span class="num">${flagsSel.length}</span> no total</span></a>
        <a class="bc docs" href="${J.href(base + "/explorar/documentos", { tab: "explorar" })}"><span class="tag">Documentos</span>
          <b class="bc-n num"><span data-count="${found}" data-key="docs">${found}</span><small>/${expSel.length}</small></b>
          <span class="paper">${expSel.length ? Array.from({ length: Math.min(20, expSel.length) }, (_, i) => `<i class="${i < Math.round(found / expSel.length * Math.min(20, expSel.length)) ? "on" : ""}"></i>`).join("") : ""}</span></a>
        <button type="button" class="bc money wide" id="bc-money" aria-label="Ver os números do dinheiro"><span class="bc-top"><span class="tag">Dinheiro</span>
          <span class="bc-saldo">saldo <b class="num ${saldo < 0 ? "neg" : "pos"}" data-count="${saldo}" data-fmt="seur" data-key="saldo">${J.eur(saldo, true)}</b></span></span>
          <span class="mbar in"><i style="width:${(vin / mx * 100).toFixed(1)}%"></i><span>Entrou <b class="num" data-count="${vin}" data-fmt="eur" data-key="vin">${J.eur(vin, true)}</b></span></span>
          <span class="mbar out"><i style="width:${((vout - gapOut) / mx * 100).toFixed(1)}%"></i><i class="gap" style="width:${(gapOut / mx * 100).toFixed(1)}%"></i><span>Saiu <b class="num" data-count="${vout}" data-fmt="eur" data-key="vout">${J.eur(vout, true)}</b></span></span>
          ${gapOut ? `<span class="bc-s"><i class="key gap"></i>${J.eur(gapOut, true)} saiu sem explicação</span>` : ""}
          <span class="bc-s bc-more">De onde veio e para onde foi ${J.ICON.chev}</span></button>
      </div>
      ${(J.euroStory(D, S, true) || {}).html || ""}
      ${head("Por explicar", J.href(base, { tab: "alertas" }))}
      ${carousel(fl.map(f => `<a class="cc alert-c sev${f.severidade}" href="${J.href(base + "/alerta/" + f.id)}"><span class="tag">${J.esc(J.RULE[f.regra] || f.regra)}</span>
        <b class="cc-t serif">${J.flagTitle(f)}</b><span class="cc-s">${J.period(f)}</span></a>`), "Nada por explicar nesta seleção.")}
      ${head("Maiores decisões", J.href(base, { tab: "dinheiro" }))}
      ${carousel(decs.map(p => `<a class="cc dec-c" href="${J.href(base + "/decisao/" + p.top.id)}"><b class="cc-v num ${p.dir === "entrada" ? "pos" : "neg"}">${p.dir === "entrada" ? "+" : "−"}${J.eur(p.v, true)}</b>
        <span class="cc-t">${J.esc(p.top.assunto)}</span><span class="cc-s">${J.date(p.top.data)}</span></a>`), "Nenhuma decisão com valor nas atas lidas.")}
      ${head("Quem mais recebeu", J.href(base, { tab: "dinheiro", seg: "recebeu" }))}
      ${carousel(rec.map(([id, v], i) => `<a class="cc rec-c" href="${J.href(base + "/entidade/" + id)}"><span class="tag">#${i + 1}</span><b class="cc-v num">${J.eur(v, true)}</b>
        <span class="cc-t">${J.esc((D.entById[id] || {}).nome || id)}</span></a>`), "Sem pagamentos a entidades identificadas.")}`;
    J.$("#bc-money", el).onclick = () => G.moneySheet(D, S);
  };

  // folha do mandato (tocar na pílula): o partido, quem governou, os nomes da lista e os votos que os elegeram
  const ROLE = { presidente: "Presidente", secretario: "Secretário(a)", tesoureiro: "Tesoureiro(a)", vogal: "Vogal", presidente_mesa: "Presidente da Assembleia",
    primeiro_secretario_mesa: "1.º secretário(a) da mesa", segundo_secretario_mesa: "2.º secretário(a) da mesa", membro: "Membro", membro_assembleia: "Membro" };
  const ROLE_ORDER = ["presidente", "secretario", "tesoureiro", "vogal", "presidente_mesa", "primeiro_secretario_mesa", "segundo_secretario_mesa", "membro", "membro_assembleia"];
  // partido, nomes e eleições do mandato escolhido (usado no menu "⋯")
  G.mandateHtml = (D, S) => {
    const A = D.aut;
    const m = S.kind === "m" ? S.m : J.mandateAt(D, S.to > J.today ? J.today : S.to);
    if (!m) return `<p class="note">Não sabemos quem governava neste período.</p>`;
    const party = k => (A.partidos || {})[k] || {};
    const badge = k => `<span class="pparty" style="--pc:${k ? J.partyColor(A, k) : "var(--unread)"}">${J.esc(k || "?")}</span>`;
    const when = `${m.inicio.slice(0, 4)}–${m.fim && m.fim < J.today ? m.fim.slice(0, 4) : "hoje"}`;
    // nomes sem repetições (as atas repetem os mesmos cargos)
    const seen = new Set();
    const membros = (m.membros || []).filter(x => { const k = x.nome + "|" + x.funcao + "|" + x.orgao; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => ROLE_ORDER.indexOf(a.funcao) - ROLE_ORDER.indexOf(b.funcao));
    // no executivo: cada pessoa uma vez, com o cargo mais importante que teve
    const jSeen = new Set();
    const junta = membros.filter(x => (x.orgao === "junta" || x.orgao === "camara") && !jSeen.has(x.nome) && jSeen.add(x.nome));
    const ass = membros.filter(x => x.orgao !== "junta" && x.orgao !== "camara");
    // na assembleia: a mesma pessoa só uma vez, com o cargo mais importante
    const assP = d3.groups(ass, x => x.nome).map(([nome, xs]) => ({ nome, funcao: xs[0].funcao, lista: (xs.find(x => x.lista) || {}).lista }));
    const e = (m.eleicoes || [])[0];
    let elHtml = "";
    if (e) {
      const ls = (e.listas || []).filter(l => l.votos != null).sort((a, b) => b.votos - a.votos);
      const base = e.votantes || (d3.sum(ls, l => l.votos) + (e.brancos || 0) + (e.nulos || 0));
      const pct = l => l.pct != null ? l.pct : base ? l.votos / base * 100 : null;
      const p1 = v => v == null ? "?" : v.toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + "%";
      elHtml = `<h3 class="ghead">Eleições de ${J.date(e.data)}</h3>
        <div class="card"><div class="elbar">${ls.map(l => `<div style="flex:${l.votos};background:${J.partyColor(A, l.partido)}">${J.esc(l.partido || l.lista)}</div>`).join("")}</div>
          <p class="sub">${e.inscritos && e.votantes ? `Votaram ${Math.round(100 * e.votantes / e.inscritos)}% (${J.int(e.votantes)} de ${J.int(e.inscritos)} inscritos). ` : ""}${e.mandatos_total ? `${e.mandatos_total} lugares na Assembleia.` : ""}${e.brancos != null ? ` Brancos ${J.int(e.brancos)} · nulos ${J.int(e.nulos || 0)}.` : ""}</p></div>
        ${J.glist(ls.map((l, i) => ({ title: `${badge(l.partido || l.lista)} ${J.esc(party(l.partido).nome || l.nome_lista || l.lista)}${i === 0 ? " · <b>venceu</b>" : ""}`,
          sub: `${J.int(l.votos)} votos · ${l.mandatos ?? "?"} ${l.mandatos === 1 ? "lugar" : "lugares"} na Assembleia`, value: `<b class="num ms-pct">${p1(pct(l))}</b>` })))}
        ${e.doc_id ? `<p class="sub">${J.src(D, null, e, "Fonte dos resultados")}</p>` : ""}`;
    }
    return `<div class="ms-head" style="--pc:${m.lista ? J.partyColor(A, m.lista) : "var(--unread)"}">${badge(m.lista)}
        <div><div class="ms-party">${J.esc(party(m.lista).nome || m.lista || "Partido desconhecido")}</div>
        <div class="sub">Governou ${J.esc(m.nome_unidade || A.nome)} · ${when}</div></div></div>
      ${S.kind === "a" ? `<p class="note">O ano ${S.year} faz parte deste mandato.</p>` : ""}
      ${J.glist([{ title: `<b>${J.esc(m.presidente || "Presidente desconhecido")}</b>`, sub: "Presidente da Junta" }].concat(
        junta.filter(x => x.funcao !== "presidente").map(x => ({ title: J.esc(x.nome), sub: ROLE[x.funcao] || J.esc(x.funcao || "") }))), A.tipo === "municipio" ? "Câmara" : "Junta (executivo)")}
      ${elHtml}
      ${assP.length ? J.glist(d3.groups(assP, x => x.lista || "").sort((a, b) => b[1].length - a[1].length).map(([k, xs]) => ({
        title: `${badge(k)} <span class="ms-names">${xs.map(x => J.esc(x.nome) + (x.funcao && !/^membro/.test(x.funcao) ? ` <span class="sub">(${ROLE[x.funcao] || x.funcao})</span>` : "")).join(", ")}</span>` })),
        "Assembleia de Freguesia — nomes encontrados") : ""}
      ${!e && !assP.length ? `<p class="note">Ainda não temos os resultados das eleições nem a lista deste mandato.</p>` : ""}`;
  };

  // escolher o período: a mesma faixa + a lista dos mandatos
  G.picker = (D, S) => {
    const A = D.aut;
    const pick = sel => { J.sheet(null); J.setQ({ sel }); };
    const rows = D.mandatos.filter(m => J.timeline.yearsOf(D, m).length).slice().reverse().map(m => {
      const to = m.fim && m.fim < J.today ? m.fim : J.today, sc = J.scoreOf(D, m.inicio, to), on = S.kind === "m" && S.m.id === m.id;
      return { sel: "m:" + m.id, check: on,
        title: `<span class="pparty" style="--pc:${m.lista ? J.partyColor(A, m.lista) : "var(--unread)"}">${J.esc(m.lista || "?")}</span> <b>${J.esc(m.presidente ? m.presidente.split(" ")[0] + " " + m.presidente.split(" ").slice(-1)[0] : "Presidente desconhecido")}</b>`,
        sub: `${m.inicio.slice(0, 4)}–${m.fim && m.fim < J.today ? m.fim.slice(0, 4) : "hoje"} · ${J.esc(J.unitShort(D, m.unidade))}`,
        value: `<span class="num" style="color:${sc == null ? "inherit" : J.scoreColor(sc / 100)}">${sc == null ? "?" : sc}</span>` };
    });
    J.sheet(`<h2 class="sheet-t">Escolher período</h2><div class="hero in-sheet" id="pk-hero"></div>
      ${J.glist(rows, "Mandatos")}
      ${J.$("#pill") && J.parse().q.sel ? `<button class="btn wide" id="c-reset" type="button">Voltar ao mandato atual</button>` : ""}
      <details class="fold"><summary>Outro intervalo de datas</summary><div class="range"><label>de <input type="date" id="c-a" value="${S.from}"></label><label>a <input type="date" id="c-b" value="${S.to}"></label>
        <button class="btn primary" id="c-go" type="button">Aplicar</button></div></details>`);
    const dr = J.$("#drawer");
    J.timeline.hero(J.$("#pk-hero", dr), D, S, { onPick: pick });
    J.$$(".glist [data-sel]", dr).forEach(b => b.onclick = () => pick(b.dataset.sel));
    J.$("#c-go", dr).onclick = () => { const a = J.$("#c-a", dr).value, b = J.$("#c-b", dr).value; if (a && b && a <= b) pick(`r:${a}..${b}`); };
    if (J.$("#c-reset", dr)) J.$("#c-reset", dr).onclick = () => pick(null);
  };


  // menu "⋯" da autarquia
  G.autMenu = (D, S) => {
    const A = D.aut;
    const parent = A.municipio ? `Município de ${J.esc(A.municipio[0].toUpperCase() + A.municipio.slice(1))}` : "";
    const kids = (A.freguesias || []).map(f => `<a href="#/f/${f}">${J.esc(f)}</a>`).join(", ");
    const hist = (A.historia || []).map(h => `${J.esc(h.nome)} ${h.de ? String(h.de).slice(0, 4) : ""}–${h.ate ? String(h.ate).slice(0, 4) : "hoje"}`).join("<br>");
    J.sheet(`${G.mandateHtml(D, S)}
      ${J.glist([{ href: "#/metodologia", title: "Como é calculada a pontuação" }])}
      <h3 class="ghead">Sobre esta autarquia</h3><div class="card"><p>${A.tipo === "municipio" ? "Município" : "Freguesia"}${parent ? " · " + parent : ""}</p><p><b>NIF</b> ${J.esc(A.nif || "desconhecido")}</p>${kids ? `<p><b>Freguesias:</b> ${kids}</p>` : ""}${hist ? `<p class="sub">${hist}</p>` : ""}</div>`, { detent: "large" });
  };

  // ---------- detalhe ----------
  const back = () => "";   // o botão "Voltar" está na barra de cima
  const reportBtn = (what) => `<a class="btn" href="mailto:${EMAIL}?subject=${encodeURIComponent("Erro: " + what)}&body=${encodeURIComponent("Página: " + location.href + "\n\nO que está errado:\n")}">Reportar um erro</a>`;
  G.detail = async (el, D, S, rest, q) => {
    const [kind, id] = rest;
    const A = D.aut, T = A.taxonomia;
    if (kind === "doc") {
      const d = D.docById[id];
      if (!d) { el.innerHTML = `<div class="empty">Documento não encontrado.</div>`; return; }
      const facts = [];
      const scan = (arr, label, href) => (arr || []).forEach(x => x.doc_id === id && facts.push({ label: label(x), href: href ? href(x) : null, x }));
      scan(D.reunioes.reunioes, x => `Reunião ${J.org(x.orgao)} de ${J.date(x.data)}`, x => J.href(J.base(D) + "/reuniao/" + x.id));
      scan(D.reunioes.decisoes, x => `Decisão: ${J.esc(x.assunto)}${x.valor_cent ? " — " + J.eur(x.valor_cent) : ""}`, x => J.href(J.base(D) + "/decisao/" + x.id));
      scan(D.dinheiro.fluxos, x => `${x.direcao === "entrada" ? "Entrada" : "Saída"}: ${J.esc(x.descricao || "")} — ${x.valor_cent == null ? "valor ?" : J.eur(x.valor_cent)}`);
      scan(D.dinheiro.saldos, x => `Saldo ${J.esc(x.conta)} em ${J.date(x.data)}: ${J.eur(x.valor_cent)}`);
      scan(D.pessoas.cargos, x => `Cargo: ${J.esc(x.nome)} — ${J.esc(x.funcao || "")}`);
      scan(D.reunioes.eventos, x => `Evento: ${J.esc(x.nome)} (${J.date(x.data)})`);
      scan(D.dinheiro.apoios, x => `Apoio: ${J.esc((D.entById[x.entidade_id] || {}).nome || "")} — ${J.eur(x.valor_cent)}`);
      scan(D.dinheiro.linhas, x => `Linha ${J.esc(x.codigo)} ${J.esc(x.rotulo)}: ${J.eur(x.previsto || x.executado)}`);
      const flags = (D.alertas.alertas || []).filter(f => (f.evidencia || []).some(e => e.doc_id === id));
      const text = await J.get(`data/${A.id}/texto/${id}.json`).catch(() => null);
      const hl = q.q ? q.q.toLowerCase() : null;
      const viewer = d.espelho && /\.pdf$/i.test(d.espelho) && !(J.mobile() && text) ? `<iframe class="pdfframe" src="${d.espelho}#page=${q.pag || 1}${q.q ? "&search=" + encodeURIComponent(q.q.split(" ").slice(0, 4).join(" ")) : ""}" title="Documento"></iframe>`
        : d.espelho && /\.(jpe?g|png)$/i.test(d.espelho) ? `<img src="${d.espelho}" alt="${J.esc(d.titulo)}" style="max-width:100%;border:1px solid var(--line);border-radius:10px">`
        : text ? `<div class="card" style="max-height:70vh;overflow:auto">${text.paginas.map(p => `<div class="sub">página ${p.n}</div><div class="excerpt" ${String(p.n) === String(q.pag) ? 'id="pg-hl"' : ""}>${hl ? J.esc(p.texto).replace(new RegExp(J.esc(hl).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i"), m => `<mark>${m}</mark>`) : J.esc(p.texto)}</div>`).join("")}</div>`
        : `<div class="empty">${d.link_only ? "Só temos o título e o link: o site da autarquia não permite descarregar este ficheiro." : "Sem pré-visualização."}</div>`;
      el.innerHTML = `${back(D, "documentos")}<h2>${J.esc(d.titulo)}</h2>
        <div class="sub">${J.esc((T.tipos[d.tipo] || {}).nome || d.tipo)} · ${J.date(d.data_doc)} · leitura: ${J.esc(d.leitura || "?")} · encontrado em ${J.date(d.first_seen)}${d.removed_at ? ` · <b>retirado do site em ${J.date(d.removed_at)}</b> (guardámos cópia)` : ""}</div>
        <p class="btns"><a class="btn" href="${J.esc(d.url)}" target="_blank" rel="noopener">Original no site ↗</a> ${d.espelho ? `<a class="btn" href="${d.espelho}" target="_blank" rel="noopener">Abrir a nossa cópia</a>` : ""} ${reportBtn(d.titulo)}</p>
        ${q.q ? `<div class="excerpt">«${J.esc(q.q)}…» — página ${J.esc(q.pag || "?")}</div>` : ""}
        <div class="grid g2"><div>${viewer}</div><div><div class="card"><h3>Factos tirados deste documento (${facts.length})</h3>
          ${facts.map(f => `<div style="margin-bottom:8px">${f.href ? `<a href="${f.href}">${f.label}</a>` : f.label}<div class="sub">p. ${f.x.pagina || "?"} — «${J.esc((f.x.excerto || "").slice(0, 160))}»</div></div>`).join("") || `<div class="empty">Ainda nenhum facto extraído.</div>`}</div>
          ${flags.length ? `<div class="card" style="margin-top:10px"><h3>Alertas</h3>${flags.map(f => `<div>${J.sevTag(f.severidade)} <a href="${J.href(J.base(D) + "/alerta/" + f.id)}">${J.flagTitle(f)}</a></div>`).join("")}</div>` : ""}</div></div>`;
      const h = J.$("#pg-hl"); if (h) h.scrollIntoView({ block: "center" });
      return;
    }
    if (kind === "reuniao") {
      const r = D.reuById[id]; if (!r) { el.innerHTML = `<div class="empty">Reunião não encontrada.</div>`; return; }
      const decs = (D.reunioes.decisoes || []).filter(d => d.reuniao_id === id).sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
      const pres = (D.reunioes.presencas || []).filter(p => p.reuniao_id === id);
      const all = (D.reunioes.reunioes || []).filter(x => x.orgao === r.orgao).sort((a, b) => a.data.localeCompare(b.data)), i = all.findIndex(x => x.id === id);
      el.innerHTML = `${back(D, "reunioes")}<h2>Reunião ${J.esc(r.tipo || "")} — ${J.org(r.orgao)} — ${J.date(r.data)}</h2>
        <p>${r.ata_doc ? `<a class="btn" href="${J.href(J.base(D) + "/doc/" + r.ata_doc)}">Ata</a>` : '<span class="badge unk">ata não encontrada</span>'} ${r.edital_doc ? `<a class="btn" href="${J.href(J.base(D) + "/doc/" + r.edital_doc)}">Edital</a>` : ""}
        <a class="btn" href="${J.href(J.base(D), { sel: "reu:" + id, tab: "decisoes" })}">Selecionar esta reunião</a>
        ${i > 0 ? `<a class="btn" href="${J.href(J.base(D) + "/reuniao/" + all[i - 1].id)}">← anterior</a>` : ""} ${i < all.length - 1 ? `<a class="btn" href="${J.href(J.base(D) + "/reuniao/" + all[i + 1].id)}">seguinte →</a>` : ""}</p>
        <div class="grid g2"><div class="card"><h3>Ordem de trabalhos e decisões</h3>${decs.map(d => `<div style="margin-bottom:10px"><b>${d.ordem || ""}. <a href="${J.href(J.base(D) + "/decisao/" + d.id)}">${J.esc(d.assunto)}</a></b>
          <div class="sub">${J.esc(d.resumo || "")}</div><div class="sub">${d.valor_cent ? J.eur(d.valor_cent) + " · " : ""}${J.esc(J.res(d.resultado) || "")} ${J.src(D, null, d)}</div></div>`).join("") || `<div class="empty">Sem decisões extraídas.</div>`}</div>
        <div class="card"><h3>Presenças</h3>${pres.map(p => `<div>${p.estado === "presente" ? "✓" : p.estado === "justificada" ? "≈" : "✕"} <a href="${J.href(J.base(D) + "/pessoa/" + p.pessoa_id)}">${J.esc(p.nome)}</a> <span class="sub">${p.estado}</span></div>`).join("") || `<div class="empty">A ata não regista presenças (ou ainda não foi lida).</div>`}</div></div>`;
      return;
    }
    if (kind === "decisao") {
      const d = D.decById[id]; if (!d) { el.innerHTML = `<div class="empty">Decisão não encontrada.</div>`; return; }
      const votes = (D.reunioes.votacoes || []).filter(v => v.decisao_id === id);
      const contracts = (D.dinheiro.contratos || []).filter(c => c.decisao_id === id);
      const flags = (D.alertas.alertas || []).filter(f => f.alvo && f.alvo.decisao === id);
      const ents = JSON.parse(d.entidades || "[]");
      // nome escrito de outra forma (hífen, vírgula, acentos): comparar também com os outros nomes conhecidos
      const norm = t => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const entOf = e => (D.entidades.entidades || []).find(x => (e.nif && x.nif === e.nif) || [x.nome, ...(x.aliases || [])].some(n => norm(n) === norm(e.nome)));
      const key = e => (e.nome || "").toLowerCase().slice(0, 18);
      const others = ents.length ? (D.reunioes.decisoes || []).filter(x => x.id !== id && ents.some(e => key(e) && (x.entidades || "").toLowerCase().includes(key(e)))).sort((a, b) => (b.data || "").localeCompare(a.data || "")).slice(0, 5) : [];
      const reu = D.reuById[d.reuniao_id];
      const VOTO = { favor: "A favor", contra: "Contra", abstencao: "Abstenção" };
      el.innerHTML = `<div class="dh"><div class="dh-k">${J.esc(d.area || "Decisão")} · ${J.date(d.data)}</div><h2>${J.esc(d.assunto)}</h2>
          ${d.valor_cent ? `<div class="dh-v">${J.money(d.valor_cent, d.direcao || "saida")}</div>${d.direcao === "estado" ? `<p class="sub">Estado das contas nesse dia (o que se devia ou havia no banco). Não é dinheiro que entrou ou saiu.</p>` : ""}` : d.tem_dinheiro ? `<div class="dh-v"><span class="badge unk">valor não escrito na ata</span></div>` : ""}</div>
        ${d.resumo ? `<p class="lead">${J.gloss(d.resumo)}</p>` : ""}
        ${J.glist([
          { title: "Votação", value: J.esc(J.res(d.resultado) || "?"), sub: `${d.votos_favor ?? "?"} a favor · ${d.votos_contra ?? 0} contra · ${d.abstencoes ?? 0} abstenções` },
          { title: "Proposta por", value: J.esc(d.proponente || "não indicado") },
          reu ? { href: J.href(J.base(D) + "/reuniao/" + reu.id), title: "Reunião", value: `${J.org(reu.orgao)} · ${J.date(reu.data)}` } : null,
          d.doc_id ? { href: J.href(J.base(D) + "/doc/" + d.doc_id, { pag: d.pagina, q: (d.excerto || "").slice(0, 60) }), title: "Documento", value: `página ${d.pagina || "?"}` } : null].filter(Boolean))}
        ${(() => { // "De onde vem" só com a origem real do dinheiro; o excerto da ata é a "Fonte"
          const src = (D.dinheiro.fluxos || []).filter(f => f.decisao_id === id && f.direcao === "entrada" && f.origem && !/desconhec/.test(f.origem));
          return src.length ? J.glist(src.map(f => ({ title: f.entidade_id ? J.ent(D, f.entidade_id) : J.esc(J.ORIGIN[f.origem] || f.origem), sub: J.esc(f.descricao || ""), value: J.money(f.valor_cent, "entrada") })), "De onde vem") : ""; })()}
        ${d.excerto ? `<h3 class="ghead">Fonte</h3><div class="card quote">«${J.esc(d.excerto)}»</div>` : ""}
        ${ents.length ? J.glist(ents.map(e => { const x = entOf(e); return { href: x ? J.href(J.base(D) + "/entidade/" + x.id) : J.href(J.base(D), { tab: "explorar", find: e.nome }), title: J.esc(e.nome), sub: [e.nif ? "NIF " + J.esc(e.nif) : "", x ? "" : "sem página · procurar o nome"].filter(Boolean).join(" · ") }; }), "Entidades") : ""}
        ${votes.length ? J.glist(votes.map(v => ({ data: v.pessoa_id && D.pessoaById[v.pessoa_id] ? `data-p="${v.pessoa_id}"` : "", title: J.esc(v.nome), sub: v.declaracao ? J.esc(v.declaracao) : "", value: VOTO[v.voto] || J.esc(v.voto || "") })), "Votos") : ""}
        ${contracts.length ? J.glist(contracts.map(c => ({ href: J.href(J.base(D) + "/contrato/" + c.id), title: J.esc(c.objeto), value: `<span class="num">${J.eur(c.preco_contratual)}</span>` })), "Contratos ligados") : ""}
        ${flags.length ? J.glist(flags.map(f => ({ href: J.href(J.base(D) + "/alerta/" + f.id), icon: `<i class="pdot" style="background:var(--sev${f.severidade})"></i>`, title: J.flagTitle(f) })), "Alertas") : ""}
        ${others.length ? J.glist(others.map(x => ({ href: J.href(J.base(D) + "/decisao/" + x.id), title: J.esc(x.assunto), sub: J.date(x.data), value: x.valor_cent ? J.money(x.valor_cent, x.direcao || "saida") : "" })), "Outras decisões com esta entidade") : ""}
        <p class="btns">${reportBtn(d.assunto)}</p>`;
      J.$$("[data-p]", el).forEach(b => b.onclick = () => G.personSheet(D, b.dataset.p));
      return;
    }
    if (kind === "pessoa") {
      const p = D.pessoaById[id]; if (!p) { el.innerHTML = `<div class="empty">Pessoa não encontrada.</div>`; return; }
      const cargos = (D.pessoas.cargos || []).filter(c => c.pessoa_id === id).sort((a, b) => (a.inicio || "").localeCompare(b.inicio || ""));
      const pres = (D.reunioes.presencas || []).filter(x => x.pessoa_id === id);
      const votes = (D.reunioes.votacoes || []).filter(x => x.pessoa_id === id);
      const props = (D.reunioes.decisoes || []).filter(d => d.proponente && d.proponente.includes(p.nome.split(" ").slice(-1)[0]));
      el.innerHTML = `${back(D, "pessoas")}<h2>${J.esc(p.nome)}</h2><div class="sub">${p.aliases.length > 1 ? "Também escrito como: " + p.aliases.filter(a => a !== p.nome).map(J.esc).join(", ") : ""}</div>
        <div class="grid g4" style="margin:10px 0"><div class="card kpi"><div class="l">Presenças</div><div class="v">${pres.length ? J.pct(pres.filter(x => x.estado === "presente").length / pres.length) : "?"}</div><div class="p">${pres.length} reuniões registadas</div></div>
          <div class="card kpi"><div class="l">Votos registados</div><div class="v">${votes.length}</div><div class="p">${votes.filter(v => v.voto !== "favor").length} contra ou abstenção</div></div>
          <div class="card kpi"><div class="l">Propostas</div><div class="v">${props.length}</div></div>
          <div class="card kpi"><div class="l">Interesses declarados</div><div class="v" style="font-size:16px">${p.interesses ? J.esc(p.interesses) : "não publicados"}</div></div></div>
        <h3>Cargos</h3>${cargos.map(c => `<div>${J.date(c.inicio)} → ${c.fim ? J.date(c.fim) : "…"} · ${J.esc(c.funcao || "")} (${J.esc(c.orgao || "")}) ${J.partyTag(A, c.lista)} ${J.src(D, null, c)}</div>`).join("") || `<div class="empty">Sem cargos registados.</div>`}
        <h3>Ligações a entidades que recebem dinheiro</h3><div class="empty">Só mostramos ligações confirmadas manualmente (regra F18). Nenhuma confirmada.</div>
        <h3>Votos</h3>${votes.map(v => { const d = D.decById[v.decisao_id]; return d ? `<div>${J.date(d.data)} · <a href="${J.href(J.base(D) + "/decisao/" + d.id)}">${J.esc(d.assunto)}</a>: <b>${v.voto}</b></div>` : ""; }).join("") || `<div class="empty">Sem votos nominais registados.</div>`}`;
      return;
    }
    if (kind === "entidade") {
      const e = D.entById[id]; if (!e) { el.innerHTML = `<div class="empty">Entidade não encontrada.</div>`; return; }
      const flows = J.flowsOf(D).filter(f => f.entidade_id === id);
      const cons = (D.dinheiro.contratos || []).filter(c => c.fornecedor_id === id);
      const decs = (D.reunioes.decisoes || []).filter(d => (d.entidades || "").toLowerCase().includes((e.nome || "").toLowerCase().slice(0, 18)));
      const flags = (D.alertas.alertas || []).filter(f => f.alvo && f.alvo.entidade === id);
      const by = d3.rollups(flows.filter(f => f.valor_cent != null), v => d3.rollup(v, vv => d3.sum(vv, f => f.valor_cent), f => f.origem), f => (f.periodo_inicio || f.data).slice(0, 4)).sort((a, b) => a[0].localeCompare(b[0]));
      const got = d3.sum(flows.filter(f => f.direcao === "saida" && f.valor_cent != null && !f.coberto), f => f.valor_cent);
      el.innerHTML = `<div class="dh"><div class="dh-k">${J.esc(e.tipo || "Entidade")} · NIF ${J.esc(e.nif || "desconhecido")}</div><h2>${J.esc(e.nome)}</h2>${got ? `<div class="dh-v"><span class="num">${J.eur(got)}</span> <span class="sub">recebido, ao todo</span></div>` : ""}
        ${e.aliases.length > 1 ? `<div class="sub">Também escrito como: ${e.aliases.filter(a => a !== e.nome).slice(0, 4).map(J.esc).join("; ")}</div>` : ""}</div>
        <div class="card" style="margin-top:10px"><h3>Dinheiro recebido por ano e origem</h3><div id="en-y"></div></div>
        <h3>Movimentos (${flows.length})</h3><div id="en-mov"></div>
        ${cons.length ? `<h3>Contratos</h3>${cons.map(c => `<div><a href="${J.href(J.base(D) + "/contrato/" + c.id)}">${J.esc(c.objeto)}</a> · ${J.eur(c.preco_contratual)} · ${J.date(c.data_assinatura)}</div>`).join("")}` : ""}
        ${decs.length ? `<h3>Decisões que a referem</h3>${decs.map(d => `<div><a href="${J.href(J.base(D) + "/decisao/" + d.id)}">${J.esc(d.assunto)}</a> · ${J.date(d.data)}</div>`).join("")}` : ""}
        ${flags.length ? `<h3>Alertas</h3>${flags.map(f => `${J.sevTag(f.severidade)} <a href="${J.href(J.base(D) + "/alerta/" + f.id)}">${J.flagTitle(f)}</a>`).join("<br>")}` : ""}`;
      J.list(J.$("#en-mov"), flows.slice().sort((a, b) => (b.data || b.periodo_inicio || "").localeCompare(a.data || a.periodo_inicio || "")), f => `<div class="item"><span class="item-top"><span class="sub">${J.date(f.data || f.periodo_inicio)} · ${J.esc(J.ORIGIN[f.origem] || f.origem || "")}</span><b class="num">${f.valor_cent == null ? "?" : J.eur(f.valor_cent)} ${J.levelBadge(f.nivel)}</b></span>
        <span>${J.esc(f.descricao || "")}</span><span class="sub">${J.src(D, null, f)}</span></div>`, { page: 10, empty: "Sem movimentos." });
      J.ch.bars(J.$("#en-y"), by.map(([y, m]) => ({ label: y, stack: [...m].map(([k, v]) => ({ k: J.ORIGIN[k] || k, v, color: { municipio: "#1b8a8f", freguesia: "#4e79a7", estado: "#59a14f" }[k] || "#999" })) })), { name: "entidade_por_ano" });
      return;
    }
    if (kind === "contrato") {
      const c = D.conById[id]; if (!c) { el.innerHTML = `<div class="empty">Contrato não encontrado.</div>`; return; }
      const flags = (D.alertas.alertas || []).filter(f => f.alvo && (f.alvo.contrato === id || (f.alvo.contratos || []).includes(id)));
      el.innerHTML = `<div class="dh"><div class="dh-k">Contrato · ${J.date(c.data_assinatura)}</div><h2>${J.esc(c.objeto)}</h2><div class="dh-v"><span class="num neg">−${J.eur(c.preco_contratual)}</span></div></div>
        ${J.glist([["Fornecedor", J.esc(c.fornecedor || "?"), c.fornecedor_nif ? "NIF " + J.esc(c.fornecedor_nif) : "", c.fornecedor_id ? J.href(J.base(D) + "/entidade/" + c.fornecedor_id) : null],
          ["Adjudicante", J.esc(c.adjudicante || "?")], ["Procedimento", J.esc(c.procedimento || "?")], ["Concorrentes", J.esc(c.n_concorrentes ?? "?")],
          ["Preço base", J.eur(c.preco_base)], ["Preço contratual", J.eur(c.preco_contratual)], ["Preço efetivo", J.eur(c.preco_efetivo)],
          ["Publicado", J.date(c.data_publicacao)], ["Prazo", c.prazo_dias ? c.prazo_dias + " dias" : "?"], ["CPV", J.esc(c.cpv || "?")],
          ["Decisão na ata", c.decisao_id ? "ver decisão" : "não encontrada", "", c.decisao_id ? J.href(J.base(D) + "/decisao/" + c.decisao_id) : null]]
          .map(([t, v, sub, href]) => ({ title: t, value: v, sub, href })))}
        ${flags.length ? J.glist(flags.map(f => ({ href: J.href(J.base(D) + "/alerta/" + f.id), icon: `<i class="pdot" style="background:var(--sev${f.severidade})"></i>`, title: J.flagTitle(f) })), "Alertas") : ""}
        ${J.glist([{ href: `https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id=${encodeURIComponent(c.base_id)}`, ext: true, title: "Ver no Portal BASE", sub: "n.º " + J.esc(c.base_id) }])}`;
      return;
    }
    if (kind === "obra") {
      const o = (D.obras.obras || []).find(x => x.id === id); if (!o) { el.innerHTML = `<div class="empty">Obra não encontrada.</div>`; return; }
      el.innerHTML = `${back(D, "obras")}<h2>${J.esc(o.nome)}</h2><div class="sub">${J.esc(o.local_texto || "local ?")} · ${J.esc(o.estado || "")}</div>
        <div class="grid g3" style="margin:10px 0"><div class="card kpi"><div class="l">Custo previsto</div><div class="v">${J.eur(o.custo_previsto)}</div></div><div class="card kpi"><div class="l">Custo executado</div><div class="v">${J.eur(o.custo_executado)}</div></div>
        <div class="card kpi"><div class="l">Período</div><div class="v" style="font-size:16px">${J.date(o.inicio)} → ${J.date(o.fim)}</div></div></div>
        <div class="excerpt">${J.esc(o.excerto || "")}</div>${J.src(D, null, o, "fonte")}${o.lat ? `<div id="ob-map" class="map" style="margin-top:10px"></div>` : `<p class="sub">Localização ainda não identificada.</p>`}`;
      if (o.lat && window.L) { const m = L.map("ob-map").setView([o.lat, o.lon], 16); L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(m); L.marker([o.lat, o.lon]).addTo(m); }
      return;
    }
    if (kind === "alerta") {
      const f = D.flagById[id]; if (!f) { el.innerHTML = `<div class="empty">Alerta não encontrado (pode ter sido resolvido).</div>`; return; }
      const ev = (f.evidencia || []).map(e => e.doc_id ? `<div class="card quote">${e.excerto ? "«" + J.esc(e.excerto) + "»<br>" : ""}${J.src(D, null, e, (D.docById[e.doc_id] || {}).titulo || "documento")}</div>`
        : e.contrato ? J.glist([{ href: J.href(J.base(D) + "/contrato/" + e.contrato), title: "Contrato " + J.esc((D.conById[e.contrato] || {}).objeto || e.contrato) }])
        : e.esperado ? (x => x ? `<div class="card">${J.stateTag(x.estado)} ${J.esc((T.tipos[x.tipo] || {}).nome || x.tipo)} — ${J.esc(x.slot)}${x.devido_ate ? ` <span class="sub">(devido até ${J.date(x.devido_ate)})</span>` : ""}</div>` : "")((D.documentos.esperado || []).find(x => x.id === e.esperado)) : "").join("");
      el.innerHTML = `<div class="dh"><div class="dh-k">${J.sevTag(f.severidade)} · ${J.esc(J.RULE[f.regra] || f.regra)}</div><h2>${J.flagTitle(f)}</h2><div class="sub">${J.period(f)} · ${J.fstate(f.estado)}</div></div>
        <div class="thread"><div class="msg q"><div class="who">A pergunta</div><div class="bub">${J.gloss(f.texto)}</div></div></div>
        <h3 class="ghead">Provas</h3>${ev || '<div class="card sub">Sem provas documentais: é um cálculo sobre os dados.</div>'}
        <div class="thread"><div class="msg a"><div class="who">Resposta de ${J.esc(D.aut.nome)}${f.resposta_data ? " · " + J.date(f.resposta_data) : ""}</div>
          <div class="bub${f.resposta ? "" : " none"}">${f.resposta ? J.esc(f.resposta) : `Ainda sem resposta. <a href="#/resposta">Como responder</a>`}</div></div></div>
        <p class="note">Um alerta é uma pergunta, não uma acusação. Há explicações inocentes para quase todos os sinais; o que conta são padrões ao longo do tempo.</p>
        <h3 class="ghead">A regra, em palavras simples</h3><div class="card">${J.esc((G.RULES[f.regra] || [""])[0])} <span class="sub">(${J.esc(f.regra)})</span></div>
        <p class="sub">Visto pela primeira vez em ${J.date(f.primeira_vez)} · última verificação ${J.date(f.ultima_vez)}</p>`;
      return;
    }
    if (kind === "pedidos") {
      const ps = D.alertas.pedidos || [];
      const missing = (D.documentos.esperado || []).filter(e => e.estado === "not_found_yet");
      el.innerHTML = `${back(D, "resumo")}<h2>Pedidos de acesso a documentos (LADA)</h2>
        <p>Quando um documento obrigatório não aparece, pedimos formalmente à autarquia. A autarquia tem 10 dias úteis para responder (Lei 26/2016). Os pedidos e as respostas — ou o silêncio — ficam aqui e na linha do tempo.</p>
        ${ps.length ? `<div class="tablewrap"><table><tr><th>Enviado</th><th>O que pedimos</th><th>Prazo</th><th>Resposta</th><th>Resultado</th></tr>${ps.map(p => `<tr><td>${J.date(p.data_envio)}</td><td>${J.esc(p.documentos)}</td><td>${J.date(p.prazo)}</td><td>${p.data_resposta ? J.date(p.data_resposta) : "—"}</td><td>${J.esc(p.resultado || "à espera")}</td></tr>`).join("")}</table></div>` : `<div class="empty">Ainda não foi enviado nenhum pedido.</div>`}
        <h3>Documentos não encontrados que podem ser pedidos (${missing.length})</h3><div class="sub">${missing.slice(0, 80).map(e => `${J.esc((T.tipos[e.tipo] || {}).nome || e.tipo)} ${J.esc(e.slot)}`).join(" · ")}${missing.length > 80 ? " …" : ""}</div>`;
      return;
    }
    el.innerHTML = `<div class="empty">Página não encontrada.</div>`;
  };

  // pré-visualização rápida de uma pessoa (folha), a partir de uma decisão
  G.personSheet = (D, pid) => {
    const p = D.pessoaById[pid]; if (!p) return;
    const cargos = (D.pessoas.cargos || []).filter(c => c.pessoa_id === pid).sort((a, b) => (b.inicio || "").localeCompare(a.inicio || ""));
    const pres = (D.reunioes.presencas || []).filter(x => x.pessoa_id === pid);
    J.sheet(`<h2 class="sheet-t">${J.esc(p.nome)}</h2>
      ${J.glist(cargos.slice(0, 4).map(c => ({ icon: `<i class="pdot" style="background:${c.lista ? J.partyColor(D.aut, c.lista) : "var(--unread)"}"></i>`, title: J.esc(c.funcao || "cargo"),
        sub: `${J.date(c.inicio)} → ${c.fim ? J.date(c.fim) : "hoje"}${c.lista ? " · " + J.esc(c.lista) : ""}` })).concat(pres.length ? [{ title: "Presenças", value: J.pct(pres.filter(x => x.estado === "presente").length / pres.length), sub: `${pres.length} reuniões registadas` }] : []))}
      <a class="btn wide" href="${J.href(J.base(D) + "/pessoa/" + pid)}">Abrir perfil completo</a>`);
  };

  // ---------- comparar ----------
  G.compare = async (app, q) => {
    const idx = await J.get("data/index.json").catch(() => ({ autarquias: [] }));
    const a = q.a || (idx.autarquias[0] || {}).id, b = q.b || (idx.autarquias[1] || idx.autarquias[0] || {}).id;
    const opts = sel => idx.autarquias.map(x => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${J.esc(x.nome)}</option>`).join("");
    app.innerHTML = `<h1 style="margin-top:20px">Comparar</h1><div class="filters"><select id="ca">${opts(a)}</select><span>com</span><select id="cb">${opts(b)}</select>
      <select id="cy"><option value="">Mandato atual</option>${d3.range(new Date().getFullYear(), 2012, -1).map(y => `<option value="a:${y}" ${q.sel === "a:" + y ? "selected" : ""}>${y}</option>`).join("")}</select>
      <label><input type="checkbox" id="cpc" ${q.pc !== "0" ? "checked" : ""}> por habitante</label></div><div class="grid g2" id="cmp"></div>`;
    ["ca", "cb", "cy", "cpc"].forEach(id => J.$("#" + id).onchange = () => J.go("comparar", { a: J.$("#ca").value, b: J.$("#cb").value, sel: J.$("#cy").value, pc: J.$("#cpc").checked ? "1" : "0" }));
    for (const id of [a, b]) {
      if (!id) continue;
      const D = await J.load(id), S = J.selection(D, q.sel), t = J.moneyTotals(D, S), pop = (D.aut.populacao || {})[S.to.slice(0, 4)];
      const per = v => q.pc !== "0" && pop ? J.eur(Math.round(v / pop)) + " /hab." : J.eur(v, true);
      const exp = (D.documentos.esperado || []).filter(e => J.inSel(S, `${e.ano}-01-01`, `${e.ano}-12-31`));
      const c = document.createElement("div"); c.className = "card"; J.$("#cmp").appendChild(c);
      c.innerHTML = `<h3><a href="#/${D.aut.tipo === "municipio" ? "m" : "f"}/${id}">${J.esc(D.aut.nome)}</a></h3><div class="sub">${J.esc(S.label)}${q.pc !== "0" && !pop ? " · população desconhecida, valores totais" : ""}</div>
        <div class="grid g2" style="margin:8px 0"><div class="kpi"><div class="l">Entrou</div><div class="v">${per(t.in.known + t.in.derived)}</div></div><div class="kpi"><div class="l">Saiu</div><div class="v">${per(t.out.known + t.out.derived)}</div></div>
        <div class="kpi"><div class="l">Documentos encontrados</div><div class="v">${exp.filter(e => ["present", "late"].includes(e.estado)).length}/${exp.length}</div></div><div class="kpi"><div class="l">Alertas</div><div class="v">${(D.alertas.alertas || []).filter(f => J.inSel(S, f.periodo_inicio, f.periodo_fim)).length}</div></div></div><div class="cmpchart"></div>`;
      J.ch.periods(c.querySelector(".cmpchart"), J.moneyByPeriod(D, "year", S), { name: "comparar_" + id });
    }
  };

  // ---------- metodologia ----------
  G.RULES = {
    F00: ["Um documento que estava no site deixou de estar.", 1], F01: ["Falta um documento obrigatório de importância máxima (orçamento, GOP, contas, lista de apoios).", 3],
    F02: ["Falta um documento obrigatório de importância média ou baixa (atas, editais, mapa de pessoal…).", 2], F03: ["O documento existe, mas está ilegível ou sem os números que devia ter.", 2],
    F04: ["O documento foi publicado depois do prazo.", 1], F05: ["Em alguma linha, o executado ficou mais de 25% longe do previsto.", 2], F06: ["Uma revisão orçamental mexe em mais de 15% do orçamento.", 2],
    F07: ["Os totais de um documento não batem certo.", 3], F08: ["Uma decisão envolve dinheiro, mas a ata não escreve o valor.", 2], F09: ["Um contrato no Portal BASE não tem decisão correspondente nas atas.", 2],
    F10: ["Há apoios a entidades sem regulamento ou critérios publicados.", 2], F11: ["Uma entidade recebe mais de 30% dos apoios do ano, ou os apoios a ela mais do que duplicam.", 2],
    F12: ["Um fornecedor ganha mais de 40% do valor dos contratos do ano.", 2], F13: ["Três ou mais contratos com o mesmo fornecedor em menos de 90 dias, cada um abaixo do limite do ajuste direto (possível divisão).", 3],
    F14: ["Procedimento com concorrência, mas só um concorrente.", 1], F15: ["Preço do contrato igual (≥ 98%) ao preço base.", 1], F16: ["O valor do contrato subiu mais de 10% depois de assinado.", 2],
    F17: ["Mais de 90% do valor contratado no ano foi sem concurso público.", 1], F18: ["Um membro do órgão tem um cargo numa entidade que recebe dinheiro (só depois de confirmação manual).", 3],
    F19: ["Um membro faltou a mais de 30% das reuniões.", 1], F20: ["Os apoios a uma entidade param ou começam de repente, sem decisão escrita.", 2], F21: ["A Câmara diz que enviou um valor diferente do que a Junta diz que recebeu.", 3],
    F22: ["Pagamentos em atraso a crescer em 3 relatórios seguidos.", 2], F23: ["Mais de 60% do valor das obras do mandato numa só zona.", 1], F24: ["Sessão extraordinária anunciada com menos de 2 dias úteis.", 2]
  };
  G.method = async app => {
    app.innerHTML = `<h1 style="margin-top:20px">Metodologia</h1>
      <h2>Princípios</h2><ul><li><b>Cada número tem fonte:</b> documento, página e a frase exata. Sem fonte, não publicamos.</li><li><b>O que falta é um facto:</b> um documento obrigatório que não aparece mostra-se tão claramente como um que existe.</li>
      <li><b>Três estados, nunca misturados:</b> conhecido (cheio), estimado (tracejado, com "est.") e desconhecido (contorno cinzento com "?"). Nunca somamos conhecido com estimado sem mostrar as duas partes.</li>
      <li><b>Origem do dinheiro sempre visível:</b> Estado → Município → Junta → Entidade.</li><li><b>Tom neutro:</b> mostramos factos e padrões. Nunca dizemos "corrupção"; dizemos "precisa de explicação".</li><li><b>Uma receita para todas as autarquias:</b> as mesmas regras para todos os partidos e mandatos.</li></ul>
      <h2>De onde vêm os dados</h2><p>Sites da Junta e da Câmara, Portal BASE (contratos), resultados oficiais das eleições (MAI), DGAL, INE e documentos pedidos por LADA. Cada documento fica guardado com o seu código único (hash); se a autarquia o retirar do site, a nossa cópia continua disponível e isso fica registado.</p>
      <p><b>Respeito pelos sites:</b> pedimos uma página de cada vez, com pausas, e cada ficheiro é lido uma só vez e guardado. Seguimos o ficheiro robots.txt de cada site, com uma exceção: o portal freguesias.pt proíbe programas na pasta onde guarda as atas, orçamentos e contas das freguesias. Como são documentos públicos de publicação obrigatória (Lei 75/2013), descarregamos essa pasta só para a União de Apúlia e Fão e para a Fão antiga, devagar (uma pausa de 3 segundos entre ficheiros) e uma única vez. Os resultados eleitorais de 2013, 2017 e 2021 foram copiados à mão da página de resultados da RTP, com a ligação guardada.</p>
      <h2>Como lemos</h2><p>Texto de cada página; quando a página é uma imagem digitalizada, OCR em português. Documentos sem texto aproveitável ficam marcados como "ilegíveis" (isso conta contra a transparência). Os factos de tabelas (contratos, orçamentos, listas de apoios) saem por regras; os factos de texto (atas) são extraídos com IA, que tem de copiar a frase exata. O programa confirma que a frase existe na página e que o valor está escrito nela. O que falha vai para revisão humana.</p>
      <h2>Documentos esperados</h2><p>Para cada ano: orçamento e GOP (até 31 de dezembro do ano anterior; 31 de março depois de eleições), prestação de contas (até 30 de abril), atas da Junta (uma por mês), 4 sessões da Assembleia (abril, junho, setembro, novembro/dezembro), informação escrita do presidente, lista de apoios, mapa de pessoal, inventário, relatório de atividades. Um documento só passa a "em falta" depois de um pedido formal (LADA) sem resposta no prazo; antes disso é "não encontrado".</p>
      <h2>Estimativas</h2><ul><li>FFF: pago pelo Estado em 12 partes iguais; meses sem registo usam o valor mensal conhecido (estimado).</li><li>Valores anuais vistos por trimestre ou mês: espalhados por igual (estimado).</li>
      <li>Contratos: o valor é espalhado pela duração do contrato (estimado) até haver pagamentos conhecidos.</li><li>Previsto conhecido, executado desconhecido: o previsto aparece como expectativa, nunca como gasto.</li><li>Saídas calculadas pelos saldos bancários: saldo anterior + entradas − saldo novo; a parte sem explicação fica "calculada, destino desconhecido".</li></ul>
      <h2>Pontuação de transparência (0–100)</h2><table><tr><th>Dimensão</th><th>Peso</th><th>O que mede</th></tr>${[["Contas", 25, "Prestação de contas, informação escrita, inventário"], ["Planeamento", 15, "Orçamento e GOP"], ["Reuniões", 20, "Atas e editais das reuniões esperadas"], ["Dinheiro", 15, "Lista de apoios; contratos do BASE com decisão nas atas"], ["Pessoas", 10, "Mapa de pessoal; cargos identificados"], ["Regras", 10, "Regulamentos e taxas publicados"], ["Acesso", 5, "Documentos com texto legível"]].map(r => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td>${r[2]}</td></tr>`).join("")}</table>
      <p>Cada documento vale: publicado a tempo 1; com atraso 0,7; sem números 0,5; ilegível 0,3; em falta 0. A nota do mandato é a média dos anos.</p>
      <h2>Regras dos alertas</h2><table><tr><th>Regra</th><th>Gravidade</th><th>O que dispara</th></tr>${Object.entries(G.RULES).map(([k, [t, s]]) => `<tr><td>${k}</td><td>${J.sevTag(s)}</td><td>${t}</td></tr>`).join("")}</table>
      <p class="sub">Alertas de gravidade máxima que não são simples factos de calendário (F07, F13, F18, F21) e os achados escritos por IA só são publicados depois de revistos por uma pessoa.</p>
      <h2>Registo de alterações</h2><p class="sub">Cada publicação regista o que foi acrescentado, alterado ou assinalado (ficheiro de dados <code>changelog</code>).</p>`;
  };
  G.about = app => {
    app.innerHTML = `<h1 style="margin-top:20px">Sobre</h1><p>A Janela Cívica é um projeto cívico, sem fins lucrativos e sem ligação a partidos. Lê documentos públicos e mostra-os em linguagem simples.</p>
      <p>Só mostramos cargos públicos e documentos oficiais. Nomes de pessoas só aparecem quando são titulares de cargos ou representantes de entidades nomeados em documentos públicos.</p>
      <p>O código e os dados são abertos. Para reportar um erro, use o botão "Reportar um erro" em qualquer página ou escreva para <a href="mailto:${EMAIL}">${EMAIL}</a>.</p>`;
  };
  G.reply = app => {
    app.innerHTML = `<h1 style="margin-top:20px">Direito de resposta</h1><p>Se representa uma autarquia ou entidade referida num alerta, pode responder. A resposta é publicada junto ao alerta, com data, depois de moderação (só retiramos insultos ou dados pessoais).</p>
      <p>Escreva para <a href="mailto:${EMAIL}?subject=${encodeURIComponent("Direito de resposta")}">${EMAIL}</a> indicando o endereço da página do alerta e o texto da resposta. Se nos enviar o documento em falta, ele entra no site e o alerta é atualizado.</p>`;
  };
})();

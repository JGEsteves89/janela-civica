/* Separadores da página da autarquia: Resumo · Documentos · Reuniões e Decisões · Pessoas · Entidades · Dinheiro · Obras · Alertas */
(function () {
  const J = window.J, d3 = window.d3;
  const P = (J.panels = {});
  const G2 = new Proxy({}, { get: (_, k) => J.pages[k] });   // funções das páginas (carregadas depois)
  const empty = (txt) => `<div class="empty">${txt}</div>`;
  // IPC (variação média anual, INE). 2025: aproximado.
  const IPC = { 2013: 0.3, 2014: -0.3, 2015: 0.5, 2016: 0.6, 2017: 1.4, 2018: 1.0, 2019: 0.3, 2020: 0.0, 2021: 1.3, 2022: 7.8, 2023: 4.3, 2024: 2.4, 2025: 2.3, 2026: 2.0 };
  const realFactor = y => { let f = 1; for (let k = +y + 1; k <= new Date().getFullYear(); k++) f *= 1 + (IPC[k] || 0) / 100; return f; };

  // ---------- dinheiro: agregação no navegador (mesmas regras do servidor) ----------
  const zero = () => ({ known: 0, derived: 0, estimated: 0, unknown_n: 0, planned: 0 });
  function buckets(a, b, gran) {
    const A = new Date(a), B = new Date(b || a); if (B < A) return [];
    const out = new Map(); const days = Math.round((B - A) / 864e5) + 1;
    for (let d = new Date(A); d <= B; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const k = gran === "year" ? `${y}` : gran === "quarter" ? `${y}-T${Math.floor((m - 1) / 3) + 1}` : `${y}-${String(m).padStart(2, "0")}`;
      out.set(k, (out.get(k) || 0) + 1);
    }
    return [...out].map(([k, n]) => [k, n / days]);
  }
  J.flowsOf = D => (D.dinheiro.fluxos || []).filter(f => f.periodo_inicio || f.data);
  J.moneyByPeriod = (D, gran, S, opt = {}) => {
    const map = new Map();
    const cell = (k, dir) => { if (!map.has(k)) map.set(k, { key: k, in: zero(), out: zero() }); return map.get(k)[dir === "entrada" ? "in" : "out"]; };
    J.flowsOf(D).filter(f => !f.coberto && (opt.debt || !J.DEBT.has(f.categoria))).forEach(f => {   // "coberto": já está dentro do total anual das contas; empréstimos à parte (R2)
      const a = (f.periodo_inicio || f.data).slice(0, 10), b = (f.periodo_fim || f.data || a).slice(0, 10);
      if (S && !J.inSel(S, a, b)) return;
      const parts = buckets(a, b, gran);
      const big = Math.max(...parts.map(p => p[1]));
      parts.forEach(([k, frac]) => {
        if (S && (k < S.from.slice(0, k.length) || k > S.to.slice(0, k.length))) return;
        const c = cell(k, f.direcao);
        if (f.tipo_valor === "previsto") { c.planned += Math.round((f.valor_cent || 0) * frac); return; }
        if (f.nivel === "unknown" || f.valor_cent == null) { if (frac === big) c.unknown_n++; return; }
        let lvl = f.nivel || "known";
        if (lvl === "known" && parts.length > 1) lvl = "estimated";
        let v = Math.round(f.valor_cent * frac);
        if (opt.real) v = Math.round(v * realFactor(k.slice(0, 4)));
        if (opt.perCapita && D.aut.populacao && D.aut.populacao[k.slice(0, 4)]) v = Math.round(v / D.aut.populacao[k.slice(0, 4)]);
        c[lvl] += v;
      });
    });
    // períodos esperados sem nada
    if (S) {
      buckets(S.from, S.to > J.today ? J.today : S.to, gran).forEach(([k]) => { if (!map.has(k)) map.set(k, { key: k, in: zero(), out: zero(), expected: true }); });
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key)).map(p => Object.assign(p, { label: p.key.replace("-T", " T") }));
  };
  J.moneyTotals = (D, S) => {
    const t = { in: zero(), out: zero() };
    J.moneyByPeriod(D, "year", S).forEach(p => ["in", "out"].forEach(d => Object.keys(t[d]).forEach(k => t[d][k] += p[d][k])));
    return t;
  };
  const knownEst = s => `${s.estimated ? ` <span class="badge est">+ ~${J.eur(s.estimated)} est.</span>` : ""}${s.unknown_n ? ` <span class="badge unk">${s.unknown_n} sem valor</span>` : ""}`;

  // lista "nome — valor" com uma barra fina proporcional ao maior valor
  const vlist = (rows, color) => {
    if (!rows.length) return "";
    const max = d3.max(rows, r => r[1] || 0) || 1;
    return `<div class="vlist">${rows.map(([name, v]) => `<div class="vrow"><span>${name}</span>${v ? `<span class="num">${J.eur(v)}</span>` : `<span class="chipst">valor desconhecido</span>`}<span class="vbar"><i style="width:${((v || 0) / max * 100).toFixed(1)}%;--vc:${color}"></i></span></div>`).join("")}</div>`;
  };

  // ---------- maiores decisões e quem mais recebeu (usado no Início e no Dinheiro) ----------
  const BUDGET = /^(1\.ª |\d+\.ª )?(orçamento|plano plurianual|grandes opções|alteração (permutativa|modificativa))/i;
  // regra R3: passos do mesmo processo (abertura → adjudicação → pagamento) e a verba que o financia contam como 1 item
  J.topDecisions = (D, S, n) => {
    const procs = new Map();
    (D.reunioes.decisoes || []).filter(d => d.valor_cent && !BUDGET.test(d.assunto || "")).forEach(d => {
      const k = d.processo_id || d.id;
      if (!procs.has(k)) procs.set(k, []);
      procs.get(k).push(d);
    });
    const all = [...procs.values()].filter(g => g.some(d => J.inSel(S, d.data))).map(g => {
      g.sort((a, b) => (a.data || "").localeCompare(b.data || ""));
      const fin = g.filter(d => d.papel === "financiamento"), steps = g.filter(d => d.papel !== "financiamento");
      const main = steps.length ? steps : fin;
      const top = main.reduce((a, b) => (b.valor_cent >= a.valor_cent ? b : a));
      return { top, steps: main, fin: steps.length ? fin : [], dir: top.direcao || "saida", v: top.valor_cent };
    }).filter(p => p.dir !== "estado").sort((a, b) => b.v - a.v);   // estados (R8) não são decisões com dinheiro
    return n ? all.slice(0, n) : all;
  };
  J.topRecipients = (D, S, n) => {
    const ents = {};
    J.flowsOf(D).filter(f => f.direcao === "saida" && f.entidade_id && !f.coberto && ["comprometido", "executado", "pago"].includes(f.tipo_valor) && J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim))
      .forEach(f => ents[f.entidade_id] = (ents[f.entidade_id] || 0) + (f.valor_cent || 0));
    const all = Object.entries(ents).sort((a, b) => b[1] - a[1]);
    return n ? all.slice(0, n) : all;
  };
  // valor com sinal e cor: + entrada (verde), − saída (vermelho) — regra R7
  // "estado": valor que descreve as contas num dia (dívida, saldo) — sem sinal nem cor (regra R8)
  J.money = (v, dir) => dir === "estado" ? `<span class="num">${J.eur(v)}</span>` : `<span class="num ${dir === "entrada" ? "pos" : "neg"}">${dir === "entrada" ? "+" : "−"}${J.eur(v)}</span>`;
  // uma decisão (ou processo) como linha de lista: título, data (e financiamento), valor
  J.decRow = (D, p) => ({ href: J.href(J.base(D) + "/decisao/" + p.top.id), title: J.esc(p.top.assunto),
    sub: p.steps.map(d => J.date(d.data)).join(" → ") + p.fin.map(d => ` · financiado ${J.eur(d.valor_cent, true)}`).join(""), value: J.money(p.v, p.dir) });

  // ---------- NOTA POR ÁREA (porquê esta pontuação) ----------
  P.nota = (el, D, S) => {
    const A = D.aut;
    const years = Object.entries(A.score || {}).filter(([y]) => y >= S.from.slice(0, 4) && y <= S.to.slice(0, 4));
    const dims = ["contas", "planeamento", "reunioes", "dinheiro", "pessoas", "regras", "acesso"], W = { contas: 25, planeamento: 15, reunioes: 20, dinheiro: 15, pessoas: 10, regras: 10, acesso: 5 };
    const HELP = { contas: "Orçamento e prestação de contas publicados e legíveis.", planeamento: "Plano de atividades, grandes opções do plano e mapa de pessoal.",
      reunioes: "Atas da Junta e da Assembleia publicadas.", dinheiro: "Quanto do dinheiro que entra e sai tem valor conhecido.",
      pessoas: "Quem foi eleito, quem tem que cargo e quem esteve nas reuniões.", regras: "Regulamentos e tabela de taxas publicados.", acesso: "Documentos em texto (não só imagem) e fáceis de encontrar." };
    const rowsSc = dims.map(k => { const v = years.length ? d3.mean(years, ([, s]) => s[k] || 0) : 0; return { k, v, f: Math.max(0, Math.min(1, v / W[k])) }; });
    el.innerHTML = `<div class="card"><div id="sc-why" class="sbars">${rowsSc.map(({ k, v, f }) =>
      `<div class="sbar"><span>${J.DIM[k]}</span><span class="track"><i style="width:${(f * 100).toFixed(1)}%;background:${J.scoreColor(f)}"></i></span><span class="v">${v.toFixed(1)} <small>/${W[k]}</small></span><span class="sbar-help">${HELP[k]}</span></div>`).join("")}</div></div>
      <p><a href="#/metodologia">Como é calculada a pontuação ›</a></p>`;
    J.ch.frame(J.$("#sc-why"), "pontuacao_" + A.id, rowsSc.map(({ k, v }) => ({ area: J.DIM[k], pontos: +v.toFixed(1), maximo: W[k] })), "Pontuação de transparência por área");
  };


  // ---------- DOCUMENTOS ----------
  const LEIT = { native: "texto", ocr_good: "OCR", ocr_poor: "OCR fraco", unreadable: "ilegível", link_only: "só link" };
  P.arquivo = (el, D, S, q) => {   // grelha por ano + lista completa (Explorar › Documentos › Ver tudo)
    const tax = D.aut.taxonomia;
    const allYears = []; for (let y = +S.from.slice(0, 4); y <= Math.min(+S.to.slice(0, 4), new Date().getFullYear()); y++) allYears.push(y);
    const mob = J.mobile();
    const st = J.state.docs || (J.state.docs = { all: false, y: null });
    if (!allYears.includes(st.y)) st.y = allYears[allYears.length - 1];
    const years = mob ? [st.y] : allYears;
    const exp = (D.documentos.esperado || []).filter(e => allYears.includes(e.ano));
    const OK = ["present", "late"];
    let types = [...new Set(exp.map(e => e.tipo))].sort((a, b) => (tax.tipos[b].importancia - tax.tipos[a].importancia) || a.localeCompare(b));
    const bad = t => exp.some(e => e.tipo === t && years.includes(e.ano) && !OK.includes(e.estado) && e.estado !== "not_applicable");
    const nAll = types.length;
    if (mob && !st.all) types = types.filter(bad);
    const cellOf = (t, y) => {
      const xs = exp.filter(e => e.tipo === t && e.ano === y);
      if (!xs.length) return `<span class="cell na" title="não se aplica"></span>`;
      const ok = xs.filter(e => OK.includes(e.estado)).length;
      const worst = ["missing", "not_found_yet", "present_unreadable", "present_no_numbers", "late", "present"].find(s => xs.some(e => e.estado === s));
      const cls = xs.length > 1 && ok && ok < xs.length ? "mix" : worst;
      const icon = { present: "✓", late: "⏱", present_unreadable: "▒", present_no_numbers: "0", not_found_yet: "?", missing: "✕" }[worst] || "";
      return `<span class="cell ${cls}" title="${J.esc(tax.tipos[t].nome)} ${y}: ${ok}/${xs.length} — ${J.esc(J.STATE[worst])}">${xs.length > 1 ? `${ok}/${xs.length}` : icon}</span>`;
    };
    const docs = (D.documentos.documentos || []).filter(d => !d.data_doc || J.inSel(S, d.data_doc) || (q.semdata && !d.data_doc));
    const yi = allYears.indexOf(st.y);
    el.innerHTML = `
      <h2>O que devia existir e o que existe</h2>
      ${mob && allYears.length > 1 ? `<div class="ysw"><button class="btn" id="y-prev" ${yi ? "" : "disabled"} aria-label="Ano anterior">◀</button><b>${st.y}</b><button class="btn" id="y-next" ${yi < allYears.length - 1 ? "" : "disabled"} aria-label="Ano seguinte">▶</button></div>` : ""}
      <div class="tablewrap"><table class="statusgrid"><tr><th>Tipo de documento</th>${years.map(y => `<th><a href="${J.href(J.base(D) + "/explorar/documentos", { sel: "a:" + y, tab: "explorar" })}">${y}</a></th>`).join("")}</tr>
      ${types.map(t => `<tr><td>${J.gloss(tax.tipos[t].nome)} <span class="imp" title="importância">${"●".repeat(tax.tipos[t].importancia)}</span></td>${years.map(y => `<td>${cellOf(t, y)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${years.length + 1}">${empty(mob && !st.all ? "Nada em falta neste ano." : "Sem calendário para esta seleção.")}</td></tr>`}</table></div>
      ${mob && nAll > types.length ? `<button class="btn more-btn" id="d-all" type="button">Mostrar também os ${nAll - types.length} tipos completos</button>` : mob && st.all ? `<button class="btn more-btn" id="d-all" type="button">Mostrar só o que falta</button>` : ""}
      <details class="fold"><summary>O que significam os símbolos</summary><p class="sub">✓ publicado · ⏱ com atraso · ▒ ilegível · 0 sem números · ? não encontrado (ainda sem pedido formal) · ✕ em falta (confirmado). 2/5 = encontrados / esperados. ●●● = importância.</p></details>
      <h2>Documentos (${docs.length})</h2>
      ${J.filters(`<input type="search" id="d-q" placeholder="Procurar no título" value="${J.esc(q.dq || "")}">`,
        `<select id="d-t"><option value="">Todos os tipos</option>${Object.entries(tax.tipos).map(([k, v]) => `<option value="${k}" ${q.dt === k ? "selected" : ""}>${v.nome}</option>`).join("")}</select>
        <select id="d-s"><option value="">Qualquer leitura</option><option value="native">Texto</option><option value="ocr">OCR</option><option value="unreadable">Ilegível</option><option value="link_only">Só link</option></select>
        <select id="d-o"><option value="data">Ordenar: data</option><option value="tipo">tipo</option><option value="imp">importância</option></select>`)}
      <div id="d-list"></div>`;
    const re = () => P.arquivo(el, D, S, q);
    if (J.$("#y-prev")) { J.$("#y-prev").onclick = () => { st.y = allYears[yi - 1]; re(); }; J.$("#y-next").onclick = () => { st.y = allYears[yi + 1]; re(); }; }
    if (J.$("#d-all")) J.$("#d-all").onclick = () => { st.all = !st.all; re(); };
    const flagsByDoc = {};
    (D.alertas.alertas || []).forEach(f => (f.evidencia || []).forEach(e => e.doc_id && (flagsByDoc[e.doc_id] = (flagsByDoc[e.doc_id] || 0) + 1)));
    const draw = () => {
      const qq = J.$("#d-q").value.toLowerCase(), tt = J.$("#d-t").value, ss = J.$("#d-s").value, oo = J.$("#d-o").value;
      const rows = docs.filter(d => (!qq || (d.titulo || "").toLowerCase().includes(qq)) && (!tt || d.tipo === tt) &&
        (!ss || (ss === "ocr" ? (d.leitura || "").startsWith("ocr") : d.leitura === ss)));
      rows.sort(oo === "tipo" ? (a, b) => (a.tipo || "").localeCompare(b.tipo || "") : oo === "imp" ? (a, b) => ((tax.tipos[b.tipo] || {}).importancia || 0) - ((tax.tipos[a.tipo] || {}).importancia || 0) : (a, b) => (b.data_doc || "").localeCompare(a.data_doc || ""));
      J.list(J.$("#d-list"), rows, d => `<a class="item" href="${J.href(J.base(D) + "/doc/" + d.id)}">
        <span class="item-top"><span class="chip"><i style="background:${(tax.grupos[(tax.tipos[d.tipo] || {}).grupo] || {}).cor || "#ccc"}"></i>${J.esc((tax.tipos[d.tipo] || {}).nome || d.tipo || "?")}</span><span class="sub">${J.date(d.data_doc)}</span></span>
        <span class="item-t">${J.esc(d.titulo)}</span>
        <span class="sub">${LEIT[d.leitura] || "leitura ?"}${d.removed_at ? " · <b>retirado do site</b>" : ""}${flagsByDoc[d.id] ? ` · <span class="sev sev2">${flagsByDoc[d.id]} alerta${flagsByDoc[d.id] > 1 ? "s" : ""}</span>` : ""}</span></a>`,
        { empty: "Nenhum documento com estes filtros." });
    };
    ["d-q", "d-t", "d-s", "d-o"].forEach(id => J.$("#" + id).addEventListener("input", draw));
    draw();
  };

  // ---------- REUNIÕES E DECISÕES ----------
  P.reunioes = (el, D, S) => {
    const reus = (D.reunioes.reunioes || []).filter(r => J.inSel(S, r.data)).sort((a, b) => b.data.localeCompare(a.data));
    const decs = (D.reunioes.decisoes || []).filter(d => J.inSel(S, d.data) && (S.kind !== "reu" || d.reuniao_id === S.reuniao.id));
    const expAtas = (D.documentos.esperado || []).filter(e => ["ata_junta", "ata_assembleia"].includes(e.tipo) && J.inSel(S, `${e.ano}-01-01`, `${e.ano}-12-31`) && !["present", "late"].includes(e.estado));
    const tags = {}; decs.forEach(d => JSON.parse(d.tags || "[]").forEach(t => tags[t] = (tags[t] || 0) + 1));
    const nDec = {}; decs.forEach(d => nDec[d.reuniao_id] = (nDec[d.reuniao_id] || 0) + 1);
    const byArea = d3.rollups(decs, v => ({ n: v.length, val: d3.sum(v, d => d.valor_cent || 0) }), d => d.area || "Outro").sort((a, b) => b[1].n - a[1].n);
    const maxA = d3.max(byArea, a => a[1].n) || 1;
    el.innerHTML = `
      <h2>Reuniões (${reus.length})</h2>
      <p class="sub">${reus.filter(r => r.ata_doc).length} com ata publicada${expAtas.length ? ` · <span class="ty-miss">${expAtas.length} atas em falta</span>` : ""}</p>
      ${J.mobile() ? "" : `<div class="card"><div id="r-strip"></div><div class="legend"><span><i style="background:var(--accent)"></i>ordinária</span><span><i style="background:var(--out)"></i>extraordinária</span><span><i class="lg-abs"></i>ata em falta</span></div></div>`}
      <div id="r-list"></div>
      <h2>Decisões (${decs.length})</h2>
      ${byArea.length ? `<details class="fold"><summary>Decisões por área</summary><div class="vlist">${byArea.map(([a, v]) => `<div class="vrow"><a href="javascript:void 0" data-area="${J.esc(a)}">${J.esc(a)}</a><span class="num">${v.n}</span><span class="vbar"><i style="width:${(v.n / maxA * 100).toFixed(1)}%;--vc:var(--accent)"></i></span></div>`).join("")}</div></details>` : ""}
      ${Object.keys(tags).length ? `<details class="fold"><summary>Palavras mais frequentes</summary><div class="chips">${Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t, n]) => `<a class="chip" href="javascript:void 0" data-tag="${J.esc(t)}">${J.esc(t)} <b>${n}</b></a>`).join(" ")}</div></details>` : ""}
      ${J.filters(`<input type="search" id="x-q" placeholder="Procurar assunto ou entidade">`,
        `<select id="x-a"><option value="">Todas as áreas</option>${J.AREAS.map(a => `<option>${a}</option>`).join("")}</select>
        <select id="x-m"><option value="">Com e sem dinheiro</option><option value="1">Só com dinheiro</option><option value="0">Dinheiro sem valor escrito</option></select>
        <select id="x-v"><option value="">Qualquer votação</option><option value="unanimidade">Unanimidade</option><option value="contestada">Com votos contra ou abstenções</option></select>
        <select id="x-o"><option value="data">Ordenar: data</option><option value="valor">valor</option><option value="contra">votos contra</option></select>`)}
      <div id="x-list"></div>`;
    J.list(J.$("#r-list"), reus, r => `<a class="item row" href="${J.href(J.base(D) + "/reuniao/" + r.id)}"><i class="rdot" style="background:${r.tipo === "extraordinaria" ? "var(--out)" : "var(--accent)"}"></i>
      <span><span class="item-t">${J.org(r.orgao)}</span><span class="sub">${J.date(r.data)}${r.tipo ? " · " + J.esc(r.tipo === "extraordinaria" ? "extraordinária" : r.tipo === "ordinaria" ? "ordinária" : r.tipo) : ""} · ${nDec[r.id] || 0} decisões${r.ata_doc ? "" : ' · <span class="ty-miss">sem ata</span>'}</span></span><span aria-hidden="true">›</span></a>`,
      { page: J.mobile() ? 5 : 10, empty: "Sem reuniões conhecidas nesta seleção." });
    // faixa de reuniões (só em ecrã largo)
    const sEl = J.$("#r-strip");
    if (sEl) {
      const Wd = Math.max(320, sEl.clientWidth || 600), Hd = 46;
      const x = d3.scaleTime().domain([new Date(S.from), new Date(S.to > J.today ? J.today : S.to)]).range([10, Wd - 10]);
      const svg = d3.select(sEl).append("svg").attr("viewBox", `0 0 ${Wd} ${Hd}`);
      svg.append("g").attr("class", "ax").attr("transform", `translate(0,${Hd - 16})`).call(d3.axisBottom(x).ticks(6));
      expAtas.forEach(e => { const d = /^\d{4}-\d{2}$/.test(e.slot) ? e.slot + "-15" : `${e.ano}-06-15`; svg.append("circle").attr("cx", x(new Date(d))).attr("cy", 14).attr("r", 5).attr("fill", "none").attr("stroke", "var(--miss)").attr("stroke-dasharray", "2 2")
        .on("mousemove", ev => J.tip(ev, `Ata em falta: ${J.esc(e.slot)}`)).on("mouseleave", J.hideTip); });
      reus.forEach(r => svg.append("circle").attr("cx", x(new Date(r.data))).attr("cy", 14).attr("r", 5).attr("fill", r.tipo === "extraordinaria" ? "var(--out)" : "var(--accent)").style("cursor", "pointer")
        .on("mousemove", ev => J.tip(ev, `<b>${J.org(r.orgao)}</b> · ${J.date(r.data)} (${J.esc(r.tipo || "")})<br>${nDec[r.id] || 0} decisões`)).on("mouseleave", J.hideTip)
        .on("click", () => location.hash = J.href(J.base(D) + "/reuniao/" + r.id)));
    }
    const draw = () => {
      const qq = J.$("#x-q").value.toLowerCase(), aa = J.$("#x-a").value, mm = J.$("#x-m").value, vv = J.$("#x-v").value, oo = J.$("#x-o").value;
      const rows = decs.filter(d => (!qq || `${d.assunto} ${d.resumo} ${d.entidades} ${d.tags}`.toLowerCase().includes(qq)) && (!aa || d.area === aa) &&
        (!mm || (mm === "1" ? d.valor_cent : d.tem_dinheiro && !d.valor_cent)) && (!vv || (vv === "unanimidade" ? d.resultado === "unanimidade" : (d.votos_contra || d.abstencoes))));
      rows.sort(oo === "valor" ? (a, b) => (b.valor_cent || 0) - (a.valor_cent || 0) : oo === "contra" ? (a, b) => (b.votos_contra || 0) - (a.votos_contra || 0) : (a, b) => (b.data || "").localeCompare(a.data || ""));
      J.list(J.$("#x-list"), rows, d => `<a class="item" href="${J.href(J.base(D) + "/decisao/" + d.id)}">
        <span class="item-top"><span class="sub">${J.date(d.data)}${d.area ? " · " + J.esc(d.area) : ""}</span>${d.valor_cent ? `<b class="num">${J.eur(d.valor_cent)}</b>` : d.tem_dinheiro ? '<span class="badge unk">? sem valor</span>' : ""}</span>
        <span class="item-t">${J.esc(d.assunto)}</span>
        <span class="sub">${J.esc(J.res(d.resultado))}${d.votos_contra ? ` · ${d.votos_contra} contra` : ""}${d.abstencoes ? ` · ${d.abstencoes} abst.` : ""}</span></a>`,
        { empty: "Sem decisões lidas nesta seleção. As atas podem não existir ou ainda não terem sido lidas." });
    };
    ["x-q", "x-a", "x-m", "x-v", "x-o"].forEach(id => J.$("#" + id).addEventListener("input", draw));
    J.$$("[data-tag]", el).forEach(a => a.onclick = () => { J.$("#x-q").value = a.dataset.tag; draw(); J.$("#x-q").scrollIntoView({ block: "center" }); });
    J.$$("[data-area]", el).forEach(a => a.onclick = () => { const s = J.$("#x-a"); s.value = a.dataset.area; const f = s.closest("details"); if (f) f.open = true; draw(); s.scrollIntoView({ block: "center" }); });
    draw();
  };

  // ---------- PESSOAS ----------
  P.presencas = (el, D, S) => {   // cartões, presenças e votações (Explorar › Pessoas › Presenças e votações)
    const A = D.aut;
    const cargos = (D.pessoas.cargos || []).filter(c => J.inSel(S, c.inicio, c.fim || J.today));
    const reus = (D.reunioes.reunioes || []).filter(r => J.inSel(S, r.data)).sort((a, b) => a.data.localeCompare(b.data));
    const pres = D.reunioes.presencas || [], votes = D.reunioes.votacoes || [];
    const people = [...new Set(cargos.map(c => c.pessoa_id).concat(pres.filter(p => reus.some(r => r.id === p.reuniao_id)).map(p => p.pessoa_id)))].map(id => D.pessoaById[id]).filter(Boolean);
    const decs = (D.reunioes.decisoes || []).filter(d => J.inSel(S, d.data));
    const contested = decs.filter(d => d.votos_contra || d.abstencoes);
    const stat = p => {
      const mine = pres.filter(x => x.pessoa_id === p.id && reus.some(r => r.id === x.reuniao_id));
      const v = votes.filter(x => x.pessoa_id === p.id && decs.some(d => d.id === x.decisao_id));
      const dissent = v.filter(x => { const d = D.decById[x.decisao_id]; return d && ((x.voto === "contra" && d.resultado !== "rejeitada") || x.voto === "abstencao"); }).length;
      const c = cargos.filter(x => x.pessoa_id === p.id);
      return { att: mine.length ? mine.filter(x => x.estado === "presente").length / mine.length : null, n: mine.length, dissent: v.length ? dissent / v.length : null,
        props: decs.filter(d => (d.proponente || "").includes(p.nome.split(" ").slice(-1)[0])).length, c };
    };
    const chg = cargos.filter(c => c.fim || c.motivo_fim);
    el.innerHTML = `
      ${J.filters("", `<select id="p-o"><option value="">Todos os órgãos</option><option value="junta">${A.tipo === "municipio" ? "Câmara" : "Junta"}</option><option value="assembleia">Assembleia</option></select>
      <select id="p-s"><option value="nome">Ordenar: nome</option><option value="att">presenças</option><option value="dis">votos diferentes da maioria</option></select>`)}
      <div id="p-cards"></div>
      <details class="fold"><summary>Presenças em cada reunião</summary><p class="sub">Verde = presente · laranja = falta justificada · vermelho = falta. Deslize para o lado.</p><div id="p-heat"></div></details>
      <details class="fold"><summary>Votações contestadas (${contested.length})</summary><p class="sub">Verde = a favor · vermelho = contra · laranja = abstenção.</p><div id="p-votes"></div></details>
      <details class="fold"><summary>Mudanças de cargo (${chg.length})</summary>${chg.map(c => `<div class="sub">${J.date(c.fim)} · ${J.esc(c.nome)} deixou ${J.esc(c.funcao || "")} ${c.motivo_fim ? "(" + J.esc(c.motivo_fim) + ")" : ""} ${J.src(D, null, c)}</div>`).join("") || empty("Sem substituições ou renúncias registadas.")}</details>`;
    const draw = () => {
      const o = J.$("#p-o").value, s = J.$("#p-s").value;
      let list = people.map(p => Object.assign({ p }, stat(p))).filter(x => !o || x.c.some(c => (c.orgao || "").startsWith(o === "junta" ? (A.tipo === "municipio" ? "camara" : "junta") : "assembleia")));
      list.sort(s === "att" ? (a, b) => (b.att ?? -1) - (a.att ?? -1) : s === "dis" ? (a, b) => (b.dissent ?? -1) - (a.dissent ?? -1) : (a, b) => a.p.nome.localeCompare(b.p.nome));
      J.list(J.$("#p-cards"), list, x => `<a class="item" href="${J.href(J.base(D) + "/pessoa/" + x.p.id)}"><span class="item-t">${J.esc(x.p.nome)}</span>
        <span class="sub">${[...new Set(x.c.map(c => `${J.esc(c.funcao || "")} ${J.partyTag(A, c.lista)}`))].join(" · ") || "sem cargo registado"}</span>
        <span class="sub">Presenças: <b>${x.att == null ? "?" : J.pct(x.att)}</b>${x.n ? ` em ${x.n}` : ""} · Votos diferentes: <b>${x.dissent == null ? "?" : J.pct(x.dissent)}</b></span></a>`,
        { cls: "items g-items", page: 12, empty: "Ninguém identificado nesta seleção." });
    };
    ["p-o", "p-s"].forEach(id => J.$("#" + id).addEventListener("input", draw)); draw();
    J.ch.heat(J.$("#p-heat"), people.map(p => ({ id: p.id, label: p.nome })), reus.map(r => ({ id: r.id, label: `${J.date(r.data)} ${J.org(r.orgao)}`, short: r.data.slice(2, 7), href: J.href(J.base(D) + "/reuniao/" + r.id) })),
      (r, c) => (pres.find(x => x.pessoa_id === r.id && x.reuniao_id === c.id) || {}).estado, { name: "presencas", empty: "Sem presenças registadas nas atas lidas." });
    J.ch.heat(J.$("#p-votes"), people.map(p => ({ id: p.id, label: p.nome })), contested.map(d => ({ id: d.id, label: d.assunto, short: d.data.slice(2, 7), href: J.href(J.base(D) + "/decisao/" + d.id) })),
      (r, c) => (votes.find(x => x.pessoa_id === r.id && x.decisao_id === c.id) || {}).voto, { name: "votacoes", empty: "Sem votações contestadas com nomes nas atas lidas." });
  };

  // ---------- ENTIDADES ----------
  P.graficos = (el, D, S) => {   // gráficos e evolução (Explorar › Entidades › Gráficos)
    const flows = J.flowsOf(D).filter(f => f.direcao === "saida" && f.entidade_id && J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim));
    const apoios = (D.dinheiro.apoios || []).filter(a => J.inSel(S, `${a.ano}-01-01`, `${a.ano}-12-31`));
    const by = {};
    flows.forEach(f => { const b = by[f.entidade_id] = by[f.entidade_id] || { id: f.entidade_id, total: 0, est: 0, unk: 0, n: 0, orig: {}, years: {} };
      if (f.valor_cent == null) b.unk++; else if (f.nivel === "estimated") b.est += f.valor_cent; else { b.total += f.valor_cent; b.orig[f.origem] = (b.orig[f.origem] || 0) + f.valor_cent; }
      b.n++; const y = (f.periodo_inicio || f.data).slice(0, 4); b.years[y] = (b.years[y] || 0) + (f.valor_cent || 0); });
    (D.dinheiro.mencoes || []).filter(m => m.entidade_id && J.inSel(S, m.data)).forEach(m => { (by[m.entidade_id] = by[m.entidade_id] || { id: m.entidade_id, total: 0, est: 0, unk: 0, n: 0, orig: {}, years: {} }).unk++; });
    const list = Object.values(by).map(b => Object.assign(b, { e: D.entById[b.id] || { nome: b.id, tipo: "?" } }));
    const flagsBy = {}; (D.alertas.alertas || []).forEach(f => f.alvo && f.alvo.entidade && (flagsBy[f.alvo.entidade] = (flagsBy[f.alvo.entidade] || 0) + 1));
    const colors = { municipio: getComputedStyle(document.documentElement).getPropertyValue("--in"), freguesia: "#4e79a7", estado: "#59a14f" };
    el.innerHTML = `
      <div class="card"><h3>Quem recebe mais</h3><div id="e-bars"></div>
        <div class="legend"><span><i style="background:${colors.municipio}"></i>da Câmara</span><span><i style="background:${colors.freguesia}"></i>da Junta</span><span><i style="background:${colors.estado}"></i>do Estado</span><span><i class="lg-est"></i>estimado</span></div></div>
      <details class="fold"><summary>Evolução por ano <span class="sub">— paragens e arranques bruscos</span></summary><div id="e-mult"></div></details>
      <h2>Todas as entidades (${list.length})</h2>
      ${J.filters(`<input type="search" id="e-q" placeholder="Procurar nome ou NIF">`, `<select id="e-t"><option value="">Todos os tipos</option>${["empresa", "associacao", "bombeiros", "ipss", "clube", "escola", "autarquia", "outro"].map(t => `<option>${t}</option>`).join("")}</select>
      <select id="e-o"><option value="total">Ordenar: total</option><option value="cresc">crescimento</option><option value="n">nº de movimentos</option><option value="nome">nome</option></select>`)}
      <div id="e-list"></div>`;
    const draw = () => {
      const t = J.$("#e-t").value, o = J.$("#e-o").value, qq = J.$("#e-q").value.toLowerCase();
      let rows = list.filter(b => (!t || b.e.tipo === t) && (!qq || `${b.e.nome} ${b.e.nif || ""}`.toLowerCase().includes(qq)));
      const growth = b => { const ys = Object.keys(b.years).sort(); return ys.length > 1 ? (b.years[ys[ys.length - 1]] - b.years[ys[0]]) / Math.max(1, b.years[ys[0]]) : 0; };
      rows.sort(o === "nome" ? (a, b) => a.e.nome.localeCompare(b.e.nome) : o === "n" ? (a, b) => b.n - a.n : o === "cresc" ? (a, b) => growth(b) - growth(a) : (a, b) => b.total - a.total);
      J.ch.bars(J.$("#e-bars"), rows.slice(0, J.mobile() ? 8 : 15).map(b => ({ label: b.e.nome, est: b.est, unk: b.unk, href: J.href(J.base(D) + "/entidade/" + b.id),
        stack: Object.entries(b.orig).map(([k, v]) => ({ k: J.ORIGIN[k] || k, v, color: colors[k] || "#999" })) })), { name: "entidades", empty: "Sem pagamentos a entidades nesta seleção." });
      J.list(J.$("#e-list"), rows, b => { const ys = Object.keys(b.years).sort(); const g = growth(b);
        return `<a class="item" href="${J.href(J.base(D) + "/entidade/" + b.id)}"><span class="item-top"><span class="item-t">${J.esc(b.e.nome)}</span><b class="num">${J.eur(b.total)}</b></span>
          <span class="sub">${J.esc(b.e.tipo)}${b.e.nif ? " · NIF " + J.esc(b.e.nif) : ""} · ${b.n} mov.${ys.length ? ` · ${ys[0]}–${ys[ys.length - 1]} ${g > 0.2 ? "↑" : g < -0.2 ? "↓" : "→"}` : ""}${b.unk ? ` · ${b.unk} sem valor` : ""}${flagsBy[b.id] ? ` · <span class="sev sev2">${flagsBy[b.id]} alertas</span>` : ""}</span></a>`; },
        { empty: "Sem entidades." });
      const years = [...new Set(rows.flatMap(b => Object.keys(b.years)))].sort();
      J.ch.multiples(J.$("#e-mult"), rows.slice(0, 8).map(b => ({ label: b.e.nome, href: J.href(J.base(D) + "/entidade/" + b.id), points: Object.entries(b.years).map(([y, v]) => ({ y, v })) })), years, { name: "evolucao_entidades" });
    };
    ["e-t", "e-o", "e-q"].forEach(id => J.$("#" + id).addEventListener("input", draw)); draw();
  };

  // ---------- DINHEIRO ----------
  // listas "De onde vem" / "Para onde vai" (as mesmas regras do fluxo detalhado)
  const flowSides = (D, S) => {
    const ins = {}, outs = {};
    J.flowsOf(D).filter(f => J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim) && f.valor_cent != null && f.tipo_valor !== "previsto" && !f.coberto).forEach(f => {
      const isIn = f.direcao === "entrada", t = isIn ? ins : outs;
      const k = isIn ? (J.ORIGIN[f.origem] || "Desconhecido") : (J.CAT[f.categoria] || J.ORIGIN[f.destino] || "Desconhecida");
      t[k] = (t[k] || 0) + Math.abs(f.valor_cent);
    });
    const rows = o => Object.entries(o).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    return { in: rows(ins), out: rows(outs) };
  };
  // gráfico circular (donut): uma fatia por origem/destino; tocar numa fatia ou linha mostra-a no centro
  const PIE = ["#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#FF375F", "#64D2FF", "#FFD60A", "#AC8E68"];
  const UNKNOWN = /^desconhecid/i;
  const donutSides = (box, D, S) => {
    const data = flowSides(D, S);
    if (!data.in.length && !data.out.length) return box.remove();
    const st = J.state.pie || (J.state.pie = { side: data.out.length ? "out" : "in", on: null });
    if (!data[st.side].length) st.side = data.in.length ? "in" : "out";
    const draw = () => {
      const rows = data[st.side], total = d3.sum(rows, r => r[1]);
      let c = 0;
      const col = rows.map(([k]) => UNKNOWN.test(k) ? "#8E8E93" : PIE[c++ % PIE.length]);
      const R = 92, r = 64, sz = R * 2 + 8;
      const arcs = d3.pie().value(d => d[1]).sort(null).padAngle(rows.length > 1 ? 0.025 : 0)(rows);
      const arc = d3.arc().innerRadius(r).outerRadius(R).cornerRadius(5);
      const arcOn = d3.arc().innerRadius(r - 2).outerRadius(R + 6).cornerRadius(6);
      const on = st.on != null && st.on < rows.length ? st.on : null;
      const sel = on != null ? rows[on] : null;
      const pct = v => (v / total * 100).toFixed(v / total < 0.1 ? 1 : 0).replace(".", ",") + "%";
      box.innerHTML = `<h3>De onde vem e para onde vai</h3>
        ${seg([["in", `Entrou <span class="num">${J.eur(d3.sum(data.in, x => x[1]), true)}</span>`], ["out", `Saiu <span class="num">${J.eur(d3.sum(data.out, x => x[1]), true)}</span>`]], st.side, "data-side")}
        <div class="pie">
          <svg viewBox="${-sz / 2} ${-sz / 2} ${sz} ${sz}" width="${sz}" height="${sz}" role="img" aria-label="${st.side === "in" ? "De onde vem o dinheiro" : "Para onde vai o dinheiro"}">
            ${arcs.map((a, n) => `<path d="${(n === on ? arcOn : arc)(a)}" fill="${col[n]}" data-i="${n}" class="${on != null && n !== on ? "dim" : ""}"><title>${J.esc(rows[n][0])}: ${J.eur(rows[n][1])} (${pct(rows[n][1])})</title></path>`).join("")}
          </svg>
          <div class="pie-c">${sel
            ? `<b class="num">${pct(sel[1])}</b><span>${J.esc(sel[0])}</span><span class="num">${J.eur(sel[1], true)}</span>`
            : `<b class="num">${J.eur(total, true)}</b><span>${st.side === "in" ? "entrou" : "saiu"}</span>`}</div>
        </div>
        <div class="pie-l">${rows.map(([k, v], n) => `<button type="button" class="pl-r${n === on ? " on" : ""}${on != null && n !== on ? " dim" : ""}" data-i="${n}" aria-pressed="${n === on}">
          <i style="background:${col[n]}"></i><span class="pl-n">${J.esc(k)}</span><span class="pl-p num">${pct(v)}</span><span class="pl-v num">${J.eur(v, true)}</span></button>`).join("")}</div>`;
      J.$$("[data-side]", box).forEach(b => b.onclick = () => { st.side = b.dataset.side; st.on = null; draw(); });
      J.$$("[data-i]", box).forEach(b => b.onclick = () => { const n = +b.dataset.i; st.on = st.on === n ? null : n; draw(); });
    };
    draw();
  };
  // análises de dinheiro (Dinheiro › Mais análises): cada uma é um ecrã próprio
  P.analise = (el, D, S, q, sub) => {
    el.innerHTML = `<div id="m-body"></div>
      <details class="fold"><summary>O que significam as cores</summary><div class="legend"><span><i class="lg-known"></i>conhecido (lido no documento)</span><span><i class="lg-est"></i>estimado (método na metodologia)</span><span><i class="lg-unk"></i>? valor desconhecido</span><span><i class="lg-abs"></i>sem informação quando devia haver</span></div></details>`;
    const body = J.$("#m-body");
    const flows = J.flowsOf(D).filter(f => J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim));
    if (sub === "geral") {
      const gran = q.gran || "year";
      body.innerHTML = `<div class="grid g2"><div class="card"><h3>De onde vem e para onde vai</h3><div id="m-sankey"></div></div>
        <div class="card"><h3>Entrou e saiu por período</h3><div class="filters"><select id="m-gran" aria-label="Agrupar por"><option value="year">Ano</option><option value="quarter">Trimestre</option><option value="month">Mês</option></select></div><div id="m-per"></div></div></div>
        <details class="fold"><summary>Prometido vs feito <span class="sub">— orçamento vs contas</span></summary><p class="sub">Linha fina = previsto no orçamento. Barra = feito (contas).</p><div id="m-bullet"></div></details>`;
      J.$("#m-gran").value = gran;
      J.$("#m-gran").onchange = e => J.setQ({ gran: e.target.value });
      const agg = {};
      flows.filter(f => f.valor_cent != null && f.tipo_valor !== "previsto" && !f.coberto).forEach(f => {
        const isIn = f.direcao === "entrada";
        const src = isIn ? (J.ORIGIN[f.origem] || "Desconhecido") : D.aut.nome, dst = isIn ? D.aut.nome : (J.CAT[f.categoria] || J.ORIGIN[f.destino] || "Desconhecido");
        const k = `${src}|${dst}|${f.nivel}`;
        agg[k] = agg[k] || { source: src, target: dst, value: 0, real: 0, level: f.nivel, dir: isIn ? "in" : "out" };
        agg[k].value += Math.abs(f.valor_cent); agg[k].real += f.valor_cent;
      });
      const links = Object.values(agg).filter(l => l.value > 0);
      if (J.mobile()) {
        const side = dir => d3.rollups(links.filter(l => l.dir === dir), v => d3.sum(v, l => l.value), l => dir === "in" ? l.source : l.target).sort((a, b) => b[1] - a[1]);
        J.$("#m-sankey").innerHTML = links.length ? `<h4>De onde vem</h4>${vlist(side("in").map(([k, v]) => [J.esc(k), v]), "var(--in)")}<h4>Para onde vai</h4>${vlist(side("out").map(([k, v]) => [J.esc(k), v]), "var(--out)")}`
          : empty("Sem fluxos de dinheiro com origem e destino nesta seleção.");
      } else J.ch.sankey(J.$("#m-sankey"), links, { name: "fluxo_dinheiro" });
      J.ch.periods(J.$("#m-per"), J.moneyByPeriod(D, gran, S), { name: "entradas_saidas", method: gran !== "year" ? "Valores anuais espalhados por igual aparecem como estimados." : "" });
      const SHORT = { transferencias_estado: "do Estado", transferencias_municipio: "da Câmara", taxas: "taxas", vendas: "vendas", rendas: "rendas",
        outras_receitas: "outras receitas", fundos_europeus: "fundos UE", emprestimos: "empréstimos", pessoal: "pessoal", bens_servicos: "bens e serviços",
        obras: "obras e investimento", apoios: "apoios", juros_divida: "juros e dívida", outras_despesas: "outras despesas" };
      // por ano e categoria: o orçamento (prometido) e as contas (feito) vêm de documentos diferentes
      const lines = (D.dinheiro.linhas || []).filter(l => J.inSel(S, `${l.ano}-01-01`, `${l.ano}-12-31`) && l.categoria && l.categoria !== "saldo_anterior");
      const byCat = d3.rollups(lines, v => ({ p: v.some(x => x.previsto != null) ? d3.sum(v, x => x.previsto || 0) : null, e: v.some(x => x.executado != null) ? d3.sum(v, x => x.executado || 0) : null }),
        l => `${l.ano} · ${l.lado === "receita" ? "entra" : "sai"}: ${SHORT[l.categoria] || J.CAT[l.categoria] || l.categoria}`);
      J.ch.bullet(J.$("#m-bullet"), byCat.filter(([, v]) => (v.p || 0) + (v.e || 0) > 0).sort((a, b) => b[0].slice(0, 4).localeCompare(a[0].slice(0, 4)) || ((b[1].p || b[1].e) - (a[1].p || a[1].e))).slice(0, 24)
        .map(([k, v]) => ({ label: k, planned: v.p, executed: v.e })), { empty: "Não há orçamento e prestação de contas legíveis para comparar nesta seleção. Ver o separador Documentos." });
    } else if (sub === "entradas") {
      const ins = flows.filter(f => f.direcao === "entrada");
      const byO = d3.rollups(ins.filter(f => f.valor_cent != null), v => d3.sum(v, f => f.valor_cent), f => J.ORIGIN[f.origem] || "Desconhecido");
      const inst = (D.dinheiro.instrumentos || []).filter(i => J.inSel(S, `${i.ano}-01-01`, `${i.ano}-12-31`));
      body.innerHTML = `<div class="grid g2"><div class="card"><h3>Origem</h3><div id="m-donut"></div></div>
        <div class="card"><h3>${D.aut.tipo === "municipio" ? "Transferências para as freguesias" : "Dinheiro da Câmara"}</h3>${inst.length ? `<div class="items">${inst.map(i => `<div class="item"><span class="item-top"><span class="item-t">${J.esc(i.tarefa || i.tipo || "")}</span><b class="num">${J.eur(i.valor_cent)}</b></span>
          <span class="sub">${i.ano || ""} · ${J.esc(i.tipo || "")} · ${i.lado === "camara" ? "diz a Câmara" : "diz a Junta"} · ${J.src(D, null, i)}</span></div>`).join("")}</div>
          <p class="sub">Quando a Câmara e a Junta dão valores diferentes para a mesma tarefa e ano, aparece o alerta F21.</p>` : empty("Sem contratos interadministrativos, acordos ou protocolos lidos nesta seleção.")}
          ${D.aut.tipo === "freguesia" && D.aut.municipio ? `<p><a href="#/m/${D.aut.municipio}/dinheiro/entradas?tab=dinheiro&sel=${encodeURIComponent(S.key.startsWith("m:") ? "a:" + S.to.slice(0, 4) : S.key)}">Ver na Câmara →</a></p>` : ""}</div></div>
        <h2>Todas as entradas (${ins.length})</h2><div id="m-flows"></div>`;
      flowList(J.$("#m-flows"), D, ins);
      J.ch.donut(J.$("#m-donut"), byO.map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v), { name: "origem_entradas" });
    } else if (sub === "saidas") {
      const outs = flows.filter(f => f.direcao === "saida");
      const tree = { name: "Saídas", children: d3.rollups(outs.filter(f => f.valor_cent != null), v => v, f => J.CAT[f.categoria] || "Desconhecida").map(([cat, v]) => ({
        name: cat, children: d3.rollups(v, vv => ({ v: d3.sum(vv, f => f.valor_cent), lvl: vv.every(f => f.nivel === "estimated") ? "estimated" : vv[0].nivel, id: vv[0].entidade_id }),
          f => (D.entById[f.entidade_id] || {}).nome || f.descricao || "Sem entidade").map(([n, x]) => ({ name: n, value: x.v, level: x.lvl, href: x.id ? J.href(J.base(D) + "/entidade/" + x.id) : null })) })) };
      const contratos = (D.dinheiro.contratos || []).filter(c => J.inSel(S, c.data_assinatura));
      const apoios = (D.dinheiro.apoios || []).filter(a => J.inSel(S, `${a.ano}-01-01`, `${a.ano}-12-31`));
      const ben = (D.dinheiro.beneficios || []);
      const unknown = outs.filter(f => f.valor_cent == null).concat((D.dinheiro.mencoes || []).filter(m => J.inSel(S, m.data)).map(m => ({ descricao: m.texto, entidade_id: m.entidade_id, data: m.data, doc_id: m.doc_id, pagina: m.pagina, excerto: m.excerto, sobre: m.sobre })));
      body.innerHTML = `<div class="card"><h3>Para onde vai</h3><p class="sub">Toque num bloco para ver o detalhe.</p><div id="m-tree"></div></div>
        <h2>Apoios a entidades</h2><div id="m-apoios"></div>
        <h2>Contratos públicos (${contratos.length})</h2><p class="sub">Do Portal BASE.</p><div id="m-con"></div>
        <details class="fold"><summary>Isenções e benefícios (${ben.length}) <span class="sub">— dinheiro que não se cobra ou que se dá em espécie</span></summary>${ben.length ? ben.map(b => `<div class="item">${J.ent(D, b.entidade_id)} · ${J.esc(b.tipo)} · ${b.valor_estimado ? "~" + J.eur(b.valor_estimado) : "valor ?"} <div class="sub">${J.esc(b.descricao || "")} ${J.src(D, null, b)}</div></div>`).join("") : empty("Sem isenções ou cedências registadas.")}</details>
        <details class="fold"><summary>Valores desconhecidos (${unknown.length}) <span class="sub">— houve dinheiro, mas o documento não diz quanto</span></summary><div id="m-unk"></div></details>
        <h2>Todas as saídas (${outs.length})</h2><div id="m-flows"></div>`;
      J.list(J.$("#m-con"), contratos.sort((a, b) => (b.data_assinatura || "").localeCompare(a.data_assinatura || "")), c => `<a class="item" href="${J.href(J.base(D) + "/contrato/" + c.id)}">
        <span class="item-top"><span class="sub">${J.date(c.data_assinatura)} · ${J.esc(c.procedimento || "")}</span><b class="num">${J.eur(c.preco_contratual)}</b></span>
        <span class="item-t">${J.esc(c.objeto)}</span><span class="sub">${J.esc(c.fornecedor)} · ${c.n_concorrentes ?? "?"} concorrente(s) · ${c.decisao_id ? "decisão ✓" : '<span class="badge unk">sem decisão nas atas</span>'}</span></a>`,
        { page: 10, empty: "Sem contratos no Portal BASE nesta seleção." });
      J.list(J.$("#m-unk"), unknown, u => `<div class="item"><span class="sub">${J.date(u.data || u.periodo_inicio)}${u.entidade_id ? " · " + J.ent(D, u.entidade_id) : ""}</span><span>${J.esc(u.descricao || "")}</span>
        <span class="sub">${J.src(D, null, u, "ver no documento")}${u.tamanho_esperado ? ` · esperado ~${J.eur(u.tamanho_esperado)}` : ""}</span></div>`, { page: 10, empty: "Nada registado." });
      flowList(J.$("#m-flows"), D, outs);
      J.ch.treemap(J.$("#m-tree"), tree, { name: "saidas" });
      J.ch.bars(J.$("#m-apoios"), d3.rollups(apoios, v => ({ v: d3.sum(v, a => a.valor_cent || 0), id: v[0].entidade_id }), a => (D.entById[a.entidade_id] || {}).nome || "?")
        .sort((a, b) => b[1].v - a[1].v).slice(0, 20).map(([n, x]) => ({ label: n, known: x.v, href: J.href(J.base(D) + "/entidade/" + x.id) })), { name: "apoios", empty: "Sem lista de apoios nesta seleção." });
    } else if (sub === "mes") {
      body.innerHTML = `<div class="filters"><label><input type="checkbox" id="m-real"> valores reais (descontando a inflação)</label>
        <label><input type="checkbox" id="m-pc" ${D.aut.populacao && Object.keys(D.aut.populacao).length ? "" : "disabled"}> por habitante ${D.aut.populacao && Object.keys(D.aut.populacao).length ? "" : "(população ainda não recolhida)"}</label></div><div id="m-month"></div>
        <p class="sub">Cada barra divide-se em parte conhecida (cheia) e parte estimada (tracejada). Passe o rato para ver o método.</p>`;
      const draw = () => J.ch.periods(J.$("#m-month"), J.moneyByPeriod(D, "month", S, { real: J.$("#m-real").checked, perCapita: J.$("#m-pc").checked }),
        { name: "por_mes", method: "Valores anuais ou de contratos são espalhados por igual pelos meses (estimado). O FFF é pago em 12 partes iguais." });
      ["m-real", "m-pc"].forEach(id => J.$("#" + id).addEventListener("change", draw)); draw();
    } else if (sub === "livro") {
      body.innerHTML = livroHtml(D, q);
    } else if (sub === "mandatos") {
      body.innerHTML = mandatesHtml(D);
    } else if (sub === "euro") {
      const outs = flows.filter(f => f.direcao === "saida" && f.valor_cent != null);
      const tot = d3.sum(outs, f => f.valor_cent) || 1;
      body.innerHTML = `<div class="card"><h3>O meu euro</h3><p>Se a autarquia gastasse <input type="number" id="eu-v" value="100" min="1" style="width:90px"> € como gasta o dinheiro que conhecemos nesta seleção, ia para:</p><div id="eu-tree"></div>
        <p class="sub">Só entra o dinheiro com valor conhecido ou estimado. A parte desconhecida não aparece aqui — veja o "livro dos valores desconhecidos".</p></div>`;
      const draw = () => { const v = +J.$("#eu-v").value || 100; J.ch.treemap(J.$("#eu-tree"), { name: `${v} €`, children: d3.rollups(outs, vv => d3.sum(vv, f => f.valor_cent), f => J.CAT[f.categoria] || "Desconhecida").map(([k, s]) => ({ name: k, value: Math.round(s / tot * v * 100) })) }, { name: "o_meu_euro" }); };
      J.$("#eu-v").addEventListener("input", draw); draw();
    }
  };
  // ---------- MANDATOS E DÍVIDA: porque é que os totais mudam de mandato para mandato ----------
  const IN_G = { estado: ["transferencias_estado", "fundos_europeus"], camara: ["transferencias_municipio"], proprias: ["taxas", "vendas", "rendas", "outras_receitas"] };
  const DIV_T = { emprestimo: ["Empréstimo", "entrada"], amortizacao: ["Pagamento de empréstimo", "saida"], juros: ["Juros", "saida"], divida: ["Dívida", ""], a_receber: ["A receber", ""],
    leasing: ["Leasing", ""], prestacoes: ["Pagamento em prestações", "saida"], ajuda: ["Ajuda / apoio recebido", "entrada"] };
  const DIV_E = { proposto: "proposto", aprovado: "aprovado", contraido: "contraído", em_divida: "em dívida", pendente: "por receber", pago: "pago" };
  const mid = f => { const a = (f.periodo_inicio || f.data).slice(0, 10), b = (f.periodo_fim || f.data || a).slice(0, 10);
    return new Date((new Date(a).getTime() + new Date(b).getTime()) / 2).toISOString().slice(0, 10); };
  // ---------- LIVRO DO ANO: refazer a contabilidade e fazê-la bater com as contas oficiais ----------
  const FASE = { pago: "pago", recebido: "recebido", aprovado: "aprovado", adjudicado: "adjudicado", faturado: "faturado", pedido: "pedido", previsto: "previsto", estado: "estado" };
  function livroHtml(D, q) {
    const books = D.dinheiro.livro || [];
    if (!books.length) return empty("Ainda não refizemos a contabilidade de nenhum ano.");
    const b = books.find(x => `${x.unidade}:${x.ano}` === q.ano) || books[0];
    const sel = `<div class="filters"><select aria-label="Ano" onchange="J.setQ({ano: this.value})">${books.map(x => `<option value="${x.unidade}:${x.ano}" ${x === b ? "selected" : ""}>${x.ano} · ${J.esc(J.unitShort(D, x.unidade))}</option>`).join("")}</select></div>`;
    const sg = (v, dir) => v == null ? '<span class="badge unk">?</span>' : J.money(v, dir);
    const c = b.contas;
    const docLink = (doc, pag, txt) => `<a href="${J.href(J.base(D) + "/doc/" + doc, { pag })}">${txt}</a>`;
    const eq = c ? `<p style="font-size:var(--fs-3)">Saldo inicial <b class="num">${J.eur(c.saldo_inicial)}</b> ${sg(c.entradas, "entrada")} ${sg(c.saidas, "saida")} = saldo final <b class="num">${J.eur(c.saldo_final)}</b>
        ${c.bate ? '<span class="badge" style="color:var(--ok)">✓ bate certo</span>' : '<span class="badge" style="color:var(--miss)">✗ não bate</span>'}</p>
        <p class="sub">Fonte: ${docLink(c.doc_id, (c.fontes.saldo_final || {}).pagina, "prestação de contas " + b.ano)}. As entradas não contam o saldo do ano anterior.</p>`
      : `<p><b>Sem contas publicadas para ${b.ano}.</b> Não é possível fechar o ano: mostramos só o que os documentos dizem.</p>`;
    const name = l => l.categoria === "rubricas_nao_lidas" ? "Rubricas das contas que ainda não lemos" : (J.CAT[l.categoria] || l.categoria) + (l.categoria === "emprestimos" ? " (empréstimo, não é receita)" : "");
    const rowsFor = dir => b.linhas.filter(l => l.direcao === dir).map(l => `<tr><td>${J.esc(name(l))}${l.encontrado ? `<div class="sub">encontrado: ${J.eur(l.encontrado)}</div>` : ""}</td><td class="num">${l.contas == null ? "—" : J.eur(l.contas)}</td>
        <td class="num">${l.sem_detalhe == null ? "—" : l.sem_detalhe < -100 ? `<span style="color:var(--miss)">${J.eur(l.sem_detalhe)} ⚠</span>` : J.eur(l.sem_detalhe)}</td></tr>`).join("");
    const lines = c ? `<div class="tablewrap"><table><tr><th>Categoria</th><th class="num">Contas</th><th class="num">Sem detalhe</th></tr>
        <tr><th colspan="3" style="color:var(--in)">+ Entradas</th></tr>${rowsFor("entrada")}<tr><th colspan="3" style="color:var(--out)">− Saídas</th></tr>${rowsFor("saida")}</table></div>
        <p class="sub">"Encontrado" = soma dos pagamentos e recebimentos descritos nos documentos. "Sem detalhe" = as contas dizem que o dinheiro entrou ou saiu, mas nenhum documento publicado diz quando, a quem ou porquê. ⚠ = encontrámos mais do que as contas dizem.</p>` : "";
    const probs = b.problemas.length ? `<ul>${b.problemas.map(p => `<li>${J.esc(p.texto)}</li>`).join("")}</ul>` : `<p class="sub">Nenhum problema encontrado.</p>`;
    const chip = m => `<span class="badge">${docLink(m.doc_id, m.pagina, `${FASE[m.fase] || m.fase} · ${J.date(m.data)}`)}</span>`;
    const tx = b.transacoes.length ? `<div class="tablewrap"><table><tr><th>Data</th><th>O quê</th><th>De / para</th><th class="num">Valor</th><th>Documentos</th></tr>${b.transacoes.map(t =>
        `<tr><td class="num">${J.date(t.data)}</td><td>${J.esc(t.objeto || "")}<div class="sub">${J.esc(J.CAT[t.categoria] || t.categoria)}</div></td><td>${J.esc(t.contraparte || "—")}</td>
        <td class="num">${J.money(t.valor_cent, t.direcao)}</td><td>${t.mencoes.map(chip).join(" ")}</td></tr>`).join("")}</table></div>` : empty("Nenhum pagamento ou recebimento descrito nos documentos lidos.");
    const com = b.compromissos.length ? `<div class="tablewrap"><table><tr><th>Data</th><th>O quê</th><th class="num">Valor</th><th>Fase</th></tr>${b.compromissos.map(m =>
        `<tr><td class="num">${J.date(m.data)}</td><td>${J.esc(m.objeto || "")}</td><td class="num">${J.money(Math.round(m.valor * 100), m.direcao)}</td><td>${chip(m)}</td></tr>`).join("")}</table></div>` : "";
    return `${sel}<div class="card"><h3>A conta do ano ${b.ano}</h3>${eq}</div>
      ${c ? `<div class="card" style="margin-top:12px"><h3>Categoria a categoria</h3>${lines}</div>` : ""}
      <div class="card" style="margin-top:12px"><h3>A verificar</h3>${probs}</div>
      <div class="card" style="margin-top:12px"><h3>Dinheiro que mexeu, segundo os documentos</h3><p class="sub">Cada linha é um só movimento, com todos os documentos que falam dele. Lemos ${b.docs_lidos} de ${b.docs_ano} documentos deste ano.</p>${tx}</div>
      ${com ? `<div class="card" style="margin-top:12px"><h3>Compromissos sem pagamento visto</h3><p class="sub">Aprovado, adjudicado, faturado ou pedido, mas sem pagamento nos documentos. Não conta nos totais.</p>${com}</div>` : ""}`;
  }

  function mandatesHtml(D) {
    const sg = (v, dir) => v == null ? '<span class="badge unk">?</span>' : `<span class="num" style="color:var(--${dir === "entrada" ? "in" : dir === "saida" ? "out" : "text"})">${dir === "entrada" ? "+" : dir === "saida" ? "−" : ""}${J.eur(v)}</span>`;
    const flows = J.flowsOf(D).filter(f => !f.coberto && f.tipo_valor !== "previsto" && f.valor_cent != null);
    const divs = (D.dinheiro.dividas || []);
    const inM = (m, unit, date) => unit === m.unidade && date >= m.inicio && date < (m.fim || "9999");
    const rows = D.mandatos.map(m => {
      const fs = flows.filter(f => inM(m, f.unidade, mid(f)));
      const ds = divs.filter(d => inM(m, d.unidade, d.data));
      const y0 = +m.inicio.slice(0, 4), y1 = +(m.fim || J.today).slice(0, 4);
      const years = []; for (let y = y0; y <= y1; y++) if (`${y}-07-01` >= m.inicio && `${y}-07-01` < (m.fim || J.today)) years.push(y);
      const contas = new Set(flows.filter(f => f.instrumento === "prestacao_contas" && f.unidade === m.unidade).map(f => +(f.periodo_inicio || "").slice(0, 4)));
      const withC = years.filter(y => contas.has(y));
      const sum = (dir, cats) => d3.sum(fs.filter(f => f.direcao === dir && (!cats || cats.includes(f.categoria))), f => f.valor_cent);
      const ins = sum("entrada"), outs = sum("saida");
      const g = Object.fromEntries(Object.entries(IN_G).map(([k, c]) => [k, sum("entrada", c)]));
      const loans = sum("entrada", ["emprestimos"]) + d3.sum(ds.filter(d => d.tipo === "emprestimo"), d => d.valor_cent || 0);
      const notes = [];
      if (years.length && withC.length < years.length) notes.push(`Só ${withC.length} de ${years.length} anos têm contas publicadas: o total está incompleto.`);
      if (/uniao/.test(m.unidade)) notes.push("Valores da União: Apúlia e Fão juntas.");
      if (ds.some(d => d.tipo === "emprestimo")) notes.push(`Pediu ${ds.filter(d => d.tipo === "emprestimo").length} empréstimo(s)${loans ? ` (${J.eur(loans)} com valor conhecido)` : ""}. Não conta como receita.`);
      if (ins && g.camara / ins > 0.2) notes.push(`A Câmara deu ${J.eur(g.camara)} (${Math.round(g.camara / ins * 100)}% das entradas).`);
      return { m, fs, ds, years, withC, ins, outs, g, notes };
    }).filter(r => r.fs.length || r.ds.length);
    const head = `<tr><th>Mandato</th><th>Anos com contas</th><th class="num">Estado</th><th class="num">Câmara</th><th class="num">Receitas próprias</th><th class="num">Total entradas</th><th class="num">Total saídas</th><th>Porquê</th></tr>`;
    const table = rows.map(r => `<tr><td>${r.m.inicio.slice(0, 4)}–${r.m.fim ? r.m.fim.slice(0, 4) : "hoje"}<div class="sub">${J.esc(J.unitShort(D, r.m.unidade))}${r.m.presidente ? " · " + J.esc(r.m.presidente) : ""}</div></td>
      <td>${r.withC.length} de ${r.years.length}${r.withC.length ? `<div class="sub">${r.withC.join(", ")}</div>` : ""}</td>
      <td class="num">${sg(r.g.estado, "entrada")}</td><td class="num">${sg(r.g.camara, "entrada")}</td><td class="num">${sg(r.g.proprias, "entrada")}</td>
      <td class="num"><b>${sg(r.ins, "entrada")}</b></td><td class="num"><b>${sg(r.outs, "saida")}</b></td><td class="sub">${r.notes.map(J.esc).join("<br>")}</td></tr>`).join("");
    const list = rows.filter(r => r.ds.length).map(r => `<h3 style="margin-top:16px">${r.m.inicio.slice(0, 4)}–${r.m.fim ? r.m.fim.slice(0, 4) : "hoje"} · ${J.esc(J.unitShort(D, r.m.unidade))}</h3>
      <div class="tablewrap"><table><tr><th>Data</th><th>O quê</th><th>A quem / de quem</th><th class="num">Valor</th><th>Estado</th><th>Descrição</th><th></th></tr>${r.ds.map(d => { const [lbl, dir] = DIV_T[d.tipo] || [d.tipo, ""];
        return `<tr><td class="num">${J.date(d.data)}</td><td>${lbl}</td><td>${J.esc(d.credor || "—")}</td><td class="num">${sg(d.valor_cent, dir)}</td><td>${DIV_E[d.estado] || J.esc(d.estado || "")}</td><td>${J.esc(d.descricao || "")}</td><td>${J.src(D, null, d)}</td></tr>`; }).join("")}</table></div>`).join("");
    return `<div class="card"><h3>Porque é que os totais mudam de mandato para mandato</h3>
      <p class="sub">Só conta dinheiro com valor conhecido; orçamentos (previsto) não contam. Empréstimos e o seu pagamento ficam fora dos totais (não são receita nem despesa nova).</p>
      <div class="tablewrap"><table>${head}${table}</table></div></div>
      <div class="card" style="margin-top:12px"><h3>Dívida, empréstimos e ajudas</h3><p class="sub"><span style="color:var(--in)">+ entra dinheiro</span> · <span style="color:var(--out)">− sai dinheiro</span> · sem sinal: valor em dívida nesse momento.</p>
      ${list || empty("Sem empréstimos ou dívidas encontrados nos documentos.")}</div>`;
  }

  function flowList(el, D, rows) {
    rows.sort((a, b) => (b.periodo_inicio || b.data || "").localeCompare(a.periodo_inicio || a.data || ""));
    J.list(el, rows, f => `<div class="item"><span class="item-top"><span class="sub">${f.data ? J.date(f.data) : `${J.date(f.periodo_inicio)} → ${J.date(f.periodo_fim)}`}</span>
      <b class="num" style="color:var(--${f.direcao === "entrada" ? "in" : "out"})">${f.valor_cent == null ? '<span class="badge unk">valor ?</span>' : (f.direcao === "entrada" ? "+" : "−") + J.eur(f.valor_cent)} ${J.levelBadge(f.nivel)}</b></span>
      <span class="item-t">${J.esc(f.descricao || J.CAT[f.categoria] || "")}</span>
      <span class="sub">${J.esc(J.ORIGIN[f.origem] || f.origem || "?")} → ${f.entidade_id ? J.ent(D, f.entidade_id) : J.esc(J.ORIGIN[f.destino] || f.destino || "?")} · ${J.esc(J.CAT[f.categoria] || f.categoria || "")} · ${J.src(D, null, f)}</span></div>`,
      { empty: "Sem movimentos nesta seleção." });
  }

  // ---------- OBRAS ----------
  P.obras = (el, D, S) => {
    const obras = (D.obras.obras || []).filter(o => !o.inicio || J.inSel(S, o.inicio, o.fim || J.today));
    el.innerHTML = `<div class="filters"><select id="o-s"><option value="">Qualquer estado</option>${[...new Set(obras.map(o => o.estado).filter(Boolean))].map(s => `<option>${J.esc(s)}</option>`).join("")}</select></div>
      <div class="grid g2"><div><div id="o-map" class="map"></div><p class="sub">Cada círculo é uma obra; o tamanho é o custo. Obras sem localização ficam só na lista. Mapa © OpenStreetMap.</p></div>
      <div><h3>Obras (${obras.length})</h3><div id="o-list"></div><details class="fold"><summary>Concentração por zona</summary><div id="o-zone"></div></details></div></div>`;
    const draw = () => {
      const s = J.$("#o-s").value; const rows = obras.filter(o => !s || o.estado === s);
      J.list(J.$("#o-list"), rows, o => `<a class="item" href="${J.href(J.base(D) + "/obra/" + o.id)}"><span class="item-top"><span class="item-t">${J.esc(o.nome)}</span><b class="num">${J.eur(o.custo_executado || o.custo_previsto)}</b></span>
        <span class="sub">${J.esc(o.local_texto || "local ?")}${o.estado ? " · " + J.esc(o.estado) : ""}${o.custo_executado ? "" : " · valor previsto"}</span></a>`, { page: 10, empty: "Sem obras identificadas nesta seleção." });
      const z = d3.rollups(rows, v => d3.sum(v, o => o.custo_executado || o.custo_previsto || 0), o => o.zona || "zona desconhecida");
      J.ch.bars(J.$("#o-zone"), z.map(([k, v]) => ({ label: k, known: v })), { name: "obras_por_zona" });
      if (window.L) {
        const box = J.$("#o-map"); box.innerHTML = ""; const c = D.aut.geo && D.aut.geo.centro || [41.5, -8.78];
        const map = L.map(box, { scrollWheelZoom: false, dragging: !J.touch, tap: true }).setView(c, 14);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
        const max = d3.max(rows, o => o.custo_executado || o.custo_previsto || 0) || 1;
        rows.filter(o => o.lat).forEach(o => L.circleMarker([o.lat, o.lon], { radius: 6 + 26 * Math.sqrt((o.custo_executado || o.custo_previsto || 0) / max), color: "#fff", weight: 2, fillColor: "#8e4585", fillOpacity: .6 })
          .bindPopup(`<b>${J.esc(o.nome)}</b><br>${J.eur(o.custo_executado || o.custo_previsto)}`).addTo(map));
      }
    };
    J.$("#o-s").addEventListener("input", draw); draw();
  };

  // ---------- ALERTAS ----------
  P.alertasTipos = (el, D, S) => {   // por tipo, gravidade e CSV (Alertas › Ver por tipo)
    const flags = (D.alertas.alertas || []).filter(f => J.inSel(S, f.periodo_inicio || S.from, f.periodo_fim || f.periodo_inicio || S.to));
    const ach = D.alertas.achados || [];
    const st = J.state.alertas || (J.state.alertas = { sev: new Set([3, 2, 1]), open: {} });
    const units = new Set(flags.map(f => f.unidade).filter(Boolean));
    const states = new Set(flags.map(f => f.estado));
    const nResp = flags.filter(f => f.resposta).length;
    el.innerHTML = `<p class="disclaimer">Um alerta é uma pergunta, não uma acusação. As regras são iguais para todos e estão na <a href="#/metodologia">metodologia</a>.</p>
      <div class="sevchips" id="f-cards" role="group" aria-label="Mostrar gravidade">${[3, 2, 1].map(s => `<button type="button" class="sevchip" data-s="${s}" aria-pressed="${st.sev.has(s)}">${J.sevTag(s)} <b>${flags.filter(f => f.severidade === s).length}</b></button>`).join("")}</div>
      <p class="sub small">Toque para mostrar ou esconder cada gravidade.${nResp ? ` ${nResp} alertas têm resposta da autarquia.` : ""}</p>
      ${ach.length ? `<h2>Achados <span class="sub">— escritos por IA, revistos por uma pessoa</span></h2><div class="grid g2">${ach.map(a => `<div class="card"><b>${J.esc(a.titulo)}</b><p>${J.gloss(a.resumo)}</p>${a.flags.map(id => `<a class="badge" href="${J.href(J.base(D) + "/alerta/" + id)}">${J.RULE[(D.flagById[id] || {}).regra] || id}</a>`).join(" ")}</div>`).join("")}</div>` : ""}
      <div class="hrow"><h2>Alertas por tipo</h2>
        ${states.size > 1 ? `<select id="f-e" aria-label="Estado"><option value="">Qualquer estado</option>${[...states].map(x => `<option value="${x}">${J.fstate(x)}</option>`).join("")}</select>` : ""}
        <button class="btn" id="f-csv" type="button">CSV</button></div>
      <div id="f-groups"></div>`;
    const item = f => {
      const semPedido = (f.alvo || {}).estado === "not_found_yet";
      return `<a class="item" href="${J.href(J.base(D) + "/alerta/" + f.id)}"><span class="item-top"><span class="sub">${J.period(f)}${units.size > 1 ? " · " + J.unitName(D, f.unidade) : ""}</span>${J.sevTag(f.severidade)}</span>
        <span class="item-t">${J.flagTitle(f)}</span><span class="sub clamp">${J.esc(f.texto)}</span>
        ${semPedido || f.resposta || states.size > 1 ? `<span class="sub">${semPedido ? `<span class="chipst">Sem pedido formal</span> ` : ""}${states.size > 1 ? J.fstate(f.estado) : ""}${f.resposta ? " · com resposta" : ""}</span>` : ""}</a>`;
    };
    const draw = () => {
      const e = J.$("#f-e") ? J.$("#f-e").value : "";
      const list = flags.filter(f => st.sev.has(f.severidade) && (!e || f.estado === e));
      const groups = d3.groups(list, f => f.regra).map(([r, fs]) => ({ r, fs: fs.sort((a, b) => b.severidade - a.severidade || (b.periodo_inicio || "").localeCompare(a.periodo_inicio || "")), sev: d3.max(fs, f => f.severidade) }))
        .sort((a, b) => b.sev - a.sev || b.fs.length - a.fs.length);
      J.$("#f-groups").innerHTML = groups.map(g => {
        const open = st.open[g.r] ?? (g.sev === 3 && !J.mobile());   // no telemóvel começa fechado: só a lista dos tipos
        return `<details class="fgroup" data-r="${g.r}" ${open ? "open" : ""}><summary>${J.sevTag(g.sev)} <b>${J.RULE[g.r] || g.r}</b> <span class="cnt">${g.fs.length}</span></summary><div class="fg-list"></div></details>`;
      }).join("") || empty("Sem alertas com estes filtros.");
      const fill = d => { const g = groups.find(x => x.r === d.dataset.r); if (g && !d.dataset.done) { d.dataset.done = 1; J.list(J.$(".fg-list", d), g.fs, item, { page: 10 }); } };
      J.$$("#f-groups details").forEach(d => { if (d.open) fill(d); d.addEventListener("toggle", () => { st.open[d.dataset.r] = d.open; if (d.open) fill(d); }); });
    };
    J.$$("#f-cards .sevchip").forEach(b => b.addEventListener("click", () => { const s = +b.dataset.s; st.sev.has(s) ? st.sev.delete(s) : st.sev.add(s); P.alertasTipos(el, D, S); }));
    if (J.$("#f-e")) J.$("#f-e").addEventListener("input", draw);
    J.$("#f-csv").addEventListener("click", () => J.csv("alertas_" + D.aut.id, flags.map(f => ({ gravidade: J.SEV[f.severidade], regra: f.regra, tipo: J.RULE[f.regra] || "",
      entidade: J.unitShort(D, f.unidade), periodo: J.period(f), titulo: J.sc(f.titulo), descricao: f.texto, estado: f.estado, link: location.origin + location.pathname + J.href(J.base(D) + "/alerta/" + f.id) }))));
    draw();
  };
  // ---------- DECISÕES (separador) ----------

  // ---------- peças comuns dos ecrãs de secção ----------
  // número grande (conta até ao valor) + uma linha de contexto
  const hstat = (v, l, sub, cls, cnt) => `<div class="hstat"><div class="hs-row"><span class="hs-v num${cls ? " " + cls : ""}"${cnt ? ` data-count="${cnt[0]}" data-fmt="${cnt[1] || "int"}" data-key="${cnt[2]}"` : ""}>${v}</span><span class="hs-l">${l}</span></div>${sub ? `<div class="hs-s">${sub}</div>` : ""}</div>`;
  // fichas de vidro (deslizam na horizontal)
  const seg = (items, on, attr) => `<div class="chips-g" role="tablist">${items.map(([k, t]) => `<button type="button" role="tab" class="chip-g glass" ${attr}="${k}" aria-selected="${on === k}">${t}</button>`).join("")}</div>`;
  const search = (id, ph, v) => `<label class="searchbar glass">${J.ICON.search}<input type="search" id="${id}" placeholder="${ph}" value="${J.esc(v || "")}" aria-label="${ph}"></label>`;
  const none = txt => `<div class="card empty-card sub">${txt}</div>`;
  // lista com "Mostrar mais" (html de cada linha já pronto)
  const listMore = (el, rows, empty, step = 25, wrap = h => J.glist(h)) => {
    let n = step;
    const draw = () => {
      el.innerHTML = rows.length ? wrap(rows.slice(0, n)) + (rows.length > n ? `<button class="btn wide more-btn glass" type="button">Mostrar mais (${rows.length - n})</button>` : "") : none(empty);
      const b = el.querySelector(".more-btn"); if (b) b.onclick = () => { n += step * 2; draw(); };
    };
    draw();
  };
  const glistMore = (el, rows, empty, step) => listMore(el, rows, empty, step);
  const signed = (v, short) => `${v < 0 ? "−" : "+"}${J.eur(Math.abs(v), short)}`;
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

  // ---------- DINHEIRO: saldo, fluxo (Sankey), cartões ----------
  // ---------- Movimentos: todo o dinheiro que entrou e saiu, com filtros e ordenação ----------
  // um movimento pode ter mais de uma fonte (ex.: decisão em ata que deu um contrato)
  const movKinds = f => {
    const k = [];
    if (f.decisao_id) k.push("decisao");
    if (f.contrato_id || /^contrato/.test(f.instrumento || "")) k.push("contrato");
    if (f.instrumento === "prestacao_contas" || f.instrumento === "conta_gerencia") k.push("contas");
    if (f.instrumento === "diferenca_saldos") k.push("semexp");
    return k.length ? k : ["outro"];
  };
  const KIND = { decisao: "Decisão em ata", contrato: "Contrato", contas: "Contas do ano", semexp: "Sem explicação", outro: "Outro documento" };
  const STAT = { comprometido: "Aprovado", pago: "Pago", executado: "Feito" };
  const SORT = { novo: "Mais recentes", velho: "Mais antigos", maior: "Maior valor", menor: "Menor valor" };
  // poucos tipos, fáceis de perceber (várias categorias juntam-se num só)
  const OUTT = { pessoal: "Pessoal", bens_servicos: "Bens e serviços", obras: "Obras", apoios: "Apoios a entidades", juros_divida: "Dívida e juros", amortizacao: "Dívida e juros", outras_despesas: "Outras despesas" };
  const INT = { transferencias_municipio: "Da Câmara", transferencias_estado: "Do Estado", fundos_europeus: "Fundos europeus", taxas: "Receitas próprias", vendas: "Receitas próprias",
    rendas: "Receitas próprias", outras_receitas: "Receitas próprias", emprestimos: "Empréstimos", saldo_anterior: "Receitas próprias" };
  const typeOf = f => (f.direcao === "entrada" ? "in:" : "out:") + ((f.direcao === "entrada" ? INT : OUTT)[f.categoria] || "Sem tipo");
  const MINS = [[0, "Qualquer"], [100000, "≥ 1 mil €"], [1000000, "≥ 10 mil €"], [10000000, "≥ 100 mil €"]];
  J.movements = (box, D, S) => {
    const st = J.state.mov || (J.state.mov = { dir: "all", sort: "novo", types: [], kinds: [], ents: [], min: 0 });
    const all = J.flowsOf(D).filter(f => f.valor_cent != null && f.tipo_valor !== "previsto" && J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim))
      .map(f => ({ f, kinds: movKinds(f), type: typeOf(f), ent: f.entidade_id && D.entById[f.entidade_id] ? f.entidade_id : null, v: Math.abs(f.valor_cent), when: f.data || f.periodo_inicio || "" }));
    // filtro; "skip" ignora um grupo (para as contagens dentro do painel de filtros)
    const pass = (m, skip) => (skip === "dir" || st.dir === "all" || (st.dir === "in") === (m.f.direcao === "entrada"))
      && (skip === "types" || !st.types.length || st.types.includes(m.type))
      && (skip === "kinds" || !st.kinds.length || st.kinds.some(k => m.kinds.includes(k)))
      && (skip === "ents" || !st.ents.length || st.ents.includes(m.ent))
      && (skip === "min" || m.v >= st.min)
      && (skip === "kinds" || st.showC || st.kinds.includes("contas") || !m.kinds.includes("contas"));
    const nFilt = () => st.types.length + st.kinds.length + st.ents.length + (st.min ? 1 : 0);
    const tname = t => t.slice(t.indexOf(":") + 1);
    const entName = id => (D.entById[id] || {}).nome || id;
    const draw = () => {
      const rows = all.filter(m => pass(m)).sort((a, b) => st.sort === "maior" ? b.v - a.v : st.sort === "menor" ? a.v - b.v
        : st.sort === "velho" ? a.when.localeCompare(b.when) : b.when.localeCompare(a.when));
      const hiddenC = st.showC || st.kinds.includes("contas") ? 0 : all.filter(m => m.kinds.includes("contas") && pass(m, "kinds")).length;
      const cnt = d => all.filter(m => pass(m, "dir") && (d === "all" || (d === "in") === (m.f.direcao === "entrada"))).length;
      const sumIn = d3.sum(rows.filter(m => m.f.direcao === "entrada"), m => m.v), sumOut = d3.sum(rows.filter(m => m.f.direcao !== "entrada"), m => m.v);
      // filtros ativos: só os escolhidos, cada um com ✕
      const active = st.types.map(t => ["types", t, tname(t)]).concat(st.kinds.map(k => ["kinds", k, KIND[k]]), st.ents.map(e => ["ents", e, entName(e)]),
        st.min ? [["min", st.min, (MINS.find(x => x[0] === st.min) || [0, ""])[1]]] : []);
      box.innerHTML = `<div class="mov-head"><h3 class="ghead">Movimentos <span class="num">${rows.length}</span></h3>
          <div class="mov-btns"><button type="button" class="mov-btn glass${nFilt() ? " on" : ""}" id="mv-filt">${J.ICON.grid}<span>Filtrar${nFilt() ? ` <b class="num">${nFilt()}</b>` : ""}</span></button>
          <button type="button" class="mov-btn glass" id="mv-sort" aria-label="Ordenar: ${SORT[st.sort]}">${J.ICON.down}<span>${SORT[st.sort]}</span></button></div></div>
        ${seg([["all", `Todos <span class="num">${cnt("all")}</span>`], ["in", `Entradas <span class="num">${cnt("in")}</span>`], ["out", `Saídas <span class="num">${cnt("out")}</span>`]], st.dir, "data-dir")}
        ${active.length ? `<div class="mov-active">${active.map(([g, k, t]) => `<button type="button" class="fchip" data-g="${g}" data-k="${J.esc(String(k))}" aria-label="Tirar o filtro ${J.esc(t)}">${J.esc(t)} <span aria-hidden="true">✕</span></button>`).join("")}
          <button type="button" class="linkbtn" id="mv-clear">Limpar tudo</button></div>
          <p class="mov-sum">${sumIn ? `Entrou <b class="num pos">${J.eur(sumIn, true)}</b>` : ""}${sumIn && sumOut ? " · " : ""}${sumOut ? `Saiu <b class="num neg">${J.eur(sumOut, true)}</b>` : ""}</p>` : ""}
        ${st.showC && !st.kinds.includes("contas") ? `<p class="hint">Com os totais das Contas do ano. <button type="button" class="linkbtn" id="mv-contas">Esconder</button></p>` : ""}
        ${hiddenC ? `<p class="hint">${hiddenC} totais das Contas do ano escondidos (repetem dinheiro que já está na lista). <button type="button" class="linkbtn" id="mv-contas">Mostrar</button></p>` : ""}
        <div id="mv-list"></div>`;
      const href = f => f.contrato_id ? J.href(J.base(D) + "/contrato/" + f.contrato_id)
        : f.decisao_id ? J.href(J.base(D) + "/decisao/" + f.decisao_id)
        : f.doc_id ? J.href(J.base(D) + "/doc/" + f.doc_id, { pag: f.pagina, q: (f.excerto || "").slice(0, 60) }) : null;
      const niceDates = t => t.replace(/(\d{4})-(\d{2})-(\d{2})/g, (x, y, mo, d) => J.date(`${y}-${mo}-${d}`));
      listMore(J.$("#mv-list", box), rows.map(m => {
        const f = m.f, isIn = f.direcao === "entrada", h = href(f), ent = m.ent && D.entById[m.ent];
        const date = f.granularidade === "year" ? (f.periodo_inicio || f.data || "").slice(0, 4) : J.date(m.when);
        const inner = `<span class="mv-top"><b class="vc-v num ${isIn ? "pos" : "neg"}">${isIn ? "+" : "−"}${J.eur(m.v, true)}</b><span class="vc-s">${date}</span></span>
          <span class="vc-t">${J.esc(niceDates(J.sc(f.descricao || tname(m.type))))}</span>
          ${ent ? `<span class="vc-s">${J.esc(ent.nome)}</span>` : ""}
          <span class="mv-tags"><span class="tagchip sm cat">${J.esc(tname(m.type))}</span>${m.kinds.map(k => `<span class="tagchip sm k-${k}">${KIND[k]}</span>`).join("")}${STAT[f.tipo_valor] ? `<span class="tagchip sm st">${STAT[f.tipo_valor]}</span>` : ""}</span>`;
        return h ? `<a class="vcard mv" href="${h}">${inner}</a>` : `<div class="vcard mv">${inner}</div>`;
      }), "Nenhum movimento com estes filtros.", 20, x => x.join(""));
      J.$$("[data-dir]", box).forEach(b => b.onclick = () => { st.dir = b.dataset.dir; draw(); });
      if (J.$("#mv-contas", box)) J.$("#mv-contas", box).onclick = () => { st.showC = !st.showC; draw(); };
      J.$$(".fchip", box).forEach(b => b.onclick = () => { const g = b.dataset.g, k = b.dataset.k; if (g === "min") st.min = 0; else st[g] = st[g].filter(x => String(x) !== k); draw(); });
      if (J.$("#mv-clear", box)) J.$("#mv-clear", box).onclick = () => { st.types = []; st.kinds = []; st.ents = []; st.min = 0; draw(); };
      J.$("#mv-sort", box).onclick = () => {
        J.sheet(`<h2 class="sheet-t">Ordenar</h2>${J.glist(Object.entries(SORT).map(([k, t]) => ({ sel: k, title: t, check: st.sort === k })))}`);
        J.$$("#drawer [data-sel]").forEach(b => b.onclick = () => { st.sort = b.dataset.sel; J.sheet(null); draw(); });
      };
      J.$("#mv-filt", box).onclick = () => { J.sheet(`<div id="fs"></div>`, { detent: "large" }); sheet(""); };
    };
    // painel de filtros: grupos curtos, cada linha com quantos movimentos tem
    const sheet = q => {
      const fs = J.$("#drawer #fs"); if (!fs) return;
      const opt = (g, k, t, n, sub) => `<button type="button" class="frow${(g === "min" ? st.min === k : st[g].includes(k)) ? " on" : ""}" data-g="${g}" data-k="${J.esc(String(k))}" aria-pressed="${g === "min" ? st.min === k : st[g].includes(k)}"${n === 0 ? " disabled" : ""}>
        <span class="fr-t">${t}${sub ? `<span class="fr-s">${sub}</span>` : ""}</span>${n == null ? "" : `<span class="fr-n num">${n}</span>`}<i class="fr-c">${J.ICON.check}</i></button>`;
      const count = (g, test) => all.filter(m => pass(m, g) && test(m)).length;
      const types = d3.groups(all.filter(m => st.dir === "all" || m.type.startsWith(st.dir + ":")), m => m.type).map(([t]) => t)
        .sort((a, b) => count("types", m => m.type === b) - count("types", m => m.type === a));
      const tIn = types.filter(t => t.startsWith("in:")), tOut = types.filter(t => t.startsWith("out:"));
      const ents = d3.rollups(all.filter(m => m.ent && pass(m, "ents")), v => ({ n: v.length, i: d3.sum(v.filter(m => m.f.direcao === "entrada"), m => m.v), o: d3.sum(v.filter(m => m.f.direcao !== "entrada"), m => m.v) }), m => m.ent)
        .sort((a, b) => (b[1].i + b[1].o) - (a[1].i + a[1].o));
      const qn = J.norm ? J.norm(q) : q.toLowerCase();
      const entShown = ents.filter(([id]) => st.ents.includes(id) || !q || (J.norm ? J.norm(entName(id)) : entName(id).toLowerCase()).includes(qn));
      const box2 = (h, body) => body ? `<h3 class="ghead">${h}</h3><div class="fgroup">${body}</div>` : "";
      fs.innerHTML = `<h2 class="sheet-t">Filtrar</h2>
        ${box2("Gastos — em quê", tOut.map(t => opt("types", t, tname(t), count("types", m => m.type === t))).join(""))}
        ${box2("Receitas — de onde", tIn.map(t => opt("types", t, tname(t), count("types", m => m.type === t))).join(""))}
        <h3 class="ghead">Empresa ou entidade</h3>
        <label class="searchbar glass">${J.ICON.search}<input type="search" id="fs-q" placeholder="Procurar entidade" value="${J.esc(q)}" aria-label="Procurar entidade"></label>
        <div class="fgroup">${entShown.slice(0, q ? 30 : 8).map(([id, s]) => opt("ents", id, J.esc(entName(id)), s.n,
          [s.i ? `recebemos ${J.eur(s.i, true)}` : "", s.o ? `pagámos ${J.eur(s.o, true)}` : ""].filter(Boolean).join(" · "))).join("") || `<p class="sub fr-none">Nenhuma entidade.</p>`}</div>
        ${box2("Valor", MINS.map(([k, t]) => opt("min", k, t, k ? count("min", m => m.v >= k) : null)).join(""))}
        ${box2("Onde está escrito", Object.keys(KIND).map(k => [k, count("kinds", m => m.kinds.includes(k))]).filter(([k, n]) => n || st.kinds.includes(k)).map(([k, n]) => opt("kinds", k, KIND[k], n)).join(""))}
        <div class="fs-foot"><button type="button" class="btn" id="fs-clear">Limpar</button><button type="button" class="btn primary" id="fs-go">Ver ${all.filter(m => pass(m)).length} movimentos</button></div>`;
      J.$$(".frow", fs).forEach(b => b.onclick = () => {
        const g = b.dataset.g, k = g === "min" ? +b.dataset.k : b.dataset.k;
        if (g === "min") st.min = st.min === k ? 0 : k; else st[g] = st[g].includes(k) ? st[g].filter(x => x !== k) : st[g].concat(k);
        const y = fs.parentElement.scrollTop; sheet(J.$("#fs-q", fs).value); fs.parentElement.scrollTop = y; draw();
      });
      const inp = J.$("#fs-q", fs);
      inp.oninput = () => { const v = inp.value, pos = inp.selectionStart; sheet(v); const n = J.$("#drawer #fs-q"); n.focus(); n.setSelectionRange(pos, pos); };
      J.$("#fs-clear", fs).onclick = () => { st.types = []; st.kinds = []; st.ents = []; st.min = 0; sheet(""); draw(); };
      J.$("#fs-go", fs).onclick = () => J.sheet(null);
    };
    draw();
  };
  // ---------- DINHEIRO › ANÁLISES: cartões-história (pergunta → resposta → gráfico → números → fonte) ----------
  const perLabel = S => { const a = S.from.slice(0, 4), b = S.to > J.today ? "hoje" : S.to.slice(0, 4); return a === b ? a : `${a}–${b}`; };
  const schip = (st, txt) => `<span class="schip ${st}">${txt}</span>`;
  const story = ({ id, href, tag, chip, head, chart, nums, fact, src, aria, cls }) => `<a class="story${cls ? " " + cls : ""}" id="${id}" href="${href}" aria-label="${J.esc(aria)}">
    <span class="st-h"><span class="tag">${tag}</span>${chip || ""}</span>
    <span class="st-t">${head}</span>
    ${chart ? `<span class="st-c" aria-hidden="true">${chart}</span>` : ""}
    ${nums && nums.length ? `<span class="st-n">${nums.map(([l, v]) => `<span><span class="l">${l}</span> <b class="num">${v}</b></span>`).join('<i aria-hidden="true">·</i>')}</span>` : ""}
    ${fact ? `<span class="st-f">⚑ ${fact}</span>` : ""}
    <span class="st-foot"><span class="src">Fonte: ${src}</span><span class="more">Ver <i aria-hidden="true">→</i></span></span></a>`;

  // Livro do ano: o que as contas dizem que saiu vs o que os documentos mostram
  const livroYear = b => {
    const c = b && b.contas;
    if (!c) return { st: "unk" };
    const contas = c.saidas || 0, docs = Math.min(contas, d3.sum(b.linhas.filter(l => l.direcao === "saida"), l => l.encontrado || 0));
    const gap = Math.max(0, contas - docs);
    return { st: contas && gap / contas < 0.05 ? "ok" : "bad", contas, docs, gap };
  };
  const livroChip = r => r.st === "ok" ? schip("ok", "✓ Contas batem") : r.st === "bad" ? schip("bad", `✕ ${J.eur(r.gap, true)} por explicar`) : schip("unk", "? Sem contas");
  J.livroInfo = (D, S) => {
    const books = (D.dinheiro.livro || []).filter(b => J.inSel(S, `${b.ano}-01-01`, `${b.ano}-12-31`) && `${b.ano}` <= J.today.slice(0, 4))
      .sort((a, b) => a.ano - b.ano);
    // um ano por ano (se houver duas unidades no mesmo ano, fica a que tem contas)
    const byY = new Map(); books.forEach(b => { if (!byY.has(b.ano) || (!byY.get(b.ano).contas && b.contas)) byY.set(b.ano, b); });
    const ys = [...byY.values()].slice(-6);
    return ys.map(b => Object.assign({ b }, livroYear(b)));
  };
  const livroStory = (D, S, st) => {
    const ys = J.livroInfo(D, S);
    if (!ys.length) return null;
    const withC = ys.filter(y => y.st !== "unk");
    const cur = ys.find(y => y.b.ano === st.ly) || withC[withC.length - 1] || ys[ys.length - 1];
    const mx = cur.contas || 1;
    const head = cur.st === "ok" ? "As contas batem certo com o que os documentos mostram."
      : cur.st === "bad" ? `Só ${Math.round(cur.docs / cur.contas * 100)}% do dinheiro que saiu, segundo as contas, aparece nos documentos.`
      : "Ainda não há contas publicadas para este ano.";
    const chart = cur.st === "unk" ? "" : `<span class="lv-bars">
        <span class="lv-r"><span class="l">Contas</span><span class="tr"><i class="c" style="width:100%"></i></span><b class="num">${J.eur(cur.contas, true)}</b></span>
        <span class="lv-r"><span class="l">Documentos</span><span class="tr"><i class="d" style="width:${(cur.docs / mx * 100).toFixed(1)}%"></i>${cur.gap ? `<i class="g" style="width:${(cur.gap / mx * 100).toFixed(1)}%"></i>` : ""}</span><b class="num">${J.eur(cur.docs, true)}</b></span>
        ${cur.gap ? `<span class="lv-gap">↳ ${J.eur(cur.gap, true)} sem rasto</span>` : ""}</span>`;
    const strip = ys.length > 1 ? `<span class="lv-ys">${ys.map(y => `<span role="button" tabindex="0" class="lv-y ${y.st}${y === cur ? " on" : ""}" data-ly="${y.b.ano}">${y.b.ano} ${y.st === "ok" ? "✓" : y.st === "bad" ? "✕" : "?"}</span>`).join("")}</span>` : "";
    return { st: cur.st === "bad" ? 0 : cur.st === "ok" ? 2 : 3, html: story({ id: "st-livro", href: J.href(J.base(D) + "/dinheiro/livro", { tab: "dinheiro", ano: `${cur.b.unidade}:${cur.b.ano}` }),
      tag: `Livro do ano · ${cur.b.ano}`, chip: livroChip(cur), head, chart: chart + strip,
      nums: cur.st === "unk" ? [] : [["Contas", J.eur(cur.contas, true)], ["Documentos", J.eur(cur.docs, true)]],
      src: cur.b.contas ? `Prestação de contas ${cur.b.ano}` : "Documentos publicados", aria: `Livro do ano ${cur.b.ano}. ${head}` }) };
  };

  // Mandatos e dívida: maior dívida referida nos documentos em cada ano, com faixas por mandato
  const debtStory = (D, S, W = 320) => {
    const pts = d3.rollups((D.dinheiro.dividas || []).filter(d => d.tipo === "divida" && d.estado === "em_divida" && d.valor_cent && d.data),
      v => d3.max(v, d => d.valor_cent), d => +d.data.slice(0, 4)).sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) return null;
    const m = S.kind === "m" ? S.m : J.mandateAt(D, S.to > J.today ? J.today : S.to);
    const y0 = pts[0][0], y1 = Math.max(+J.today.slice(0, 4), pts[pts.length - 1][0]);
    const H = 140, pl = 4, pr = 54, pt = 14, pb = 22;
    const x = d3.scaleLinear([y0, y1 + 1], [pl, W - pr]), y = d3.scaleLinear([0, d3.max(pts, p => p[1]) * 1.1], [H - pb, pt]);
    const bands = D.mandatos.filter(mm => +(mm.fim || J.today).slice(0, 4) >= y0).map(mm => {
      const a = Math.max(y0, +mm.inicio.slice(0, 4) + (+mm.inicio.slice(5, 7) - 1) / 12), b = Math.min(y1 + 1, +(mm.fim || J.today).slice(0, 4) + (+(mm.fim || J.today).slice(5, 7) - 1) / 12);
      const on = m && mm.id === m.id;
      return `<rect x="${x(a).toFixed(1)}" y="${pt - 8}" width="${Math.max(0, x(b) - x(a) - 1).toFixed(1)}" height="${H - pb - pt + 8}" fill="${J.partyColor(D.aut, mm.lista)}" class="band${on ? " on" : ""}"/>
        ${mm.lista && x(b) - x(a) > 26 ? `<text x="${((x(a) + x(b)) / 2).toFixed(1)}" y="${H - 6}" class="bl">${J.esc(mm.lista)}</text>` : ""}`;
    }).join("");
    const P = pts.map(([yy, v]) => [x(yy + 0.5), y(v)]);
    const last = P[P.length - 1], lv = pts[pts.length - 1][1];
    const chart = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="debt">${bands}
      <path d="${d3.line().curve(d3.curveMonotoneX)(P)}" class="ln"/>${P.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" class="pt"/>`).join("")}
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="5" class="lp"/><text x="${(last[0] + 8).toFixed(1)}" y="${(last[1] + 4).toFixed(1)}" class="lv">${J.eur(lv, true)}</text>
      <text x="${pl}" y="${H - 6}" class="ax">${y0}</text></svg>`;
    // início e fim do mandato escolhido
    const inM = m ? pts.filter(([yy]) => yy >= +m.inicio.slice(0, 4) && yy <= +(m.fim || J.today).slice(0, 4)) : [];
    let chip = schip("unk", "? Poucos dados"), head = "Há poucos valores de dívida nos documentos deste mandato.", nums = [], st = 3;
    if (inM.length >= 2) {
      const a = inM[0][1], b = inM[inM.length - 1][1], pc = Math.round((b - a) / a * 100);
      nums = [["Início", J.eur(a, true)], ["Fim", J.eur(b, true)], ["", `${pc > 0 ? "+" : ""}${pc}%`]];
      if (Math.abs(pc) <= 5) { chip = schip("unk", "= 0%"); head = "A dívida ficou igual neste mandato."; st = 2; }
      else if (pc < 0) { chip = schip("ok", `✓ ${pc}%`); head = `A dívida desceu ${-pc}% neste mandato.`; st = 2; }
      else { chip = schip("warn", `! +${pc}%`); head = `A dívida subiu ${pc}% neste mandato.`; st = 1; }
    }
    return { st, html: story({ id: "st-divida", href: J.href(J.base(D) + "/dinheiro/mandatos", { tab: "dinheiro" }), tag: "Mandatos e dívida", chip, head, chart, nums,
      src: "dívidas referidas nas atas (maior valor de cada ano)", aria: `Mandatos e dívida. ${head} ${nums.map(n => n.join(" ")).join(", ")}` }) };
  };

  // O meu euro: de cada € 1 gasto, quanto foi para cada tipo de despesa (só o que tem tipo conhecido)
  const EURO_C = ["#0A84FF", "#BF5AF2", "#FF9F0A", "#64D2FF", "#AC8E68"];
  J.euroStory = (D, S, compact) => {
    const outs = J.flowsOf(D).filter(f => f.direcao === "saida" && f.valor_cent != null && !f.coberto && f.tipo_valor !== "previsto" && J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim));
    const known = outs.filter(f => J.CAT[f.categoria] && f.categoria !== "desconhecida");
    const tot = d3.sum(known, f => Math.abs(f.valor_cent));
    if (!tot) return null;
    let cats = d3.rollups(known, v => d3.sum(v, f => Math.abs(f.valor_cent)), f => J.CAT[f.categoria]).sort((a, b) => b[1] - a[1]);
    if (cats.length > 5) cats = cats.slice(0, 4).concat([["Outros", d3.sum(cats.slice(4), c => c[1])]]);
    const ct = v => Math.round(v / tot * 100);
    const name = J.esc(D.aut.nome.replace(/^(Freguesia|Município|União das Freguesias) de /, ""));
    const head = `De cada € 1 gasto em ${name}, ${ct(cats[0][1])} cêntimos foram para ${J.esc(cats[0][0].toLowerCase())}.`;
    const chart = `<span class="eu-bar">${cats.map(([k, v], i) => `<i style="flex:${v};background:${EURO_C[i]}" title="${J.esc(k)} ${ct(v)}c"></i>`).join("")}</span>
      ${compact ? "" : `<span class="eu-leg">${cats.map(([k, v], i) => `<span><i style="background:${EURO_C[i]}"></i>${J.esc(k)} <b class="num">${ct(v)}c</b></span>`).join("")}</span>`}`;
    const fact = !compact && cats.length >= 3 && cats[0][1] > cats[1][1] + cats[2][1] && cats[1][0] !== "Outros" && cats[2][0] !== "Outros"
      ? `${J.esc(cats[0][0])} leva mais do que ${J.esc(cats[1][0].toLowerCase())} e ${J.esc(cats[2][0].toLowerCase())} juntos.` : "";
    const unk = d3.sum(outs, f => Math.abs(f.valor_cent)) - tot;
    return { st: 4, html: story({ id: "st-euro", cls: compact ? "compact" : "", href: J.href(J.base(D) + "/dinheiro/euro", { tab: "dinheiro" }), tag: `O meu euro · ${perLabel(S)}`, head, chart, fact,
      src: `contas e atas${unk > 0 ? ` · não conta ${J.eur(unk, true)} sem tipo` : ""}`, aria: `O meu euro. ${head} ${cats.map(([k, v]) => `${k} ${ct(v)} cêntimos`).join(", ")}` }) };
  };

  // desenha os cartões; os que têm problema (✕) primeiro, depois (!), depois (✓)
  const drawStories = (box, D, S) => {
    const st = J.state.money;
    const render = () => {
      const cards = [livroStory(D, S, st), debtStory(D, S, Math.max(260, Math.round((box.clientWidth || 358) - 40))), J.euroStory(D, S)].filter(Boolean).sort((a, b) => a.st - b.st);
      box.innerHTML = cards.length ? cards.map((c, i) => c.html.replace('class="story', `style="--i:${i}" class="story`)).join("") : none("Ainda não há análises para esta seleção.");
      J.$$(".lv-y", box).forEach(c => {
        const pick = e => { e.preventDefault(); e.stopPropagation(); c.closest(".story").style.viewTransitionName = ""; st.ly = +c.dataset.ly; render(); box.classList.add("no-anim"); };
        c.onclick = pick; c.onkeydown = e => (e.key === "Enter" || e.key === " ") && pick(e);
      });
    };
    render();
  };

  P.dinheiro = (el, D, S, q) => {
    const st = J.state.money || (J.state.money = {});
    if (st.key !== S.key) { st.key = S.key; st.y = null; }
    const agg = J.moneyByPeriod(D, "year", S).filter(p => p.key <= J.today.slice(0, 4));
    const t = J.moneyTotals(D, S);
    const vin = t.in.known + t.in.derived, vout = t.out.known + t.out.derived, saldo = vin - vout;
    const y = st.y;
    const Sy = y ? Object.assign({}, S, { from: S.from > `${y}-01-01` ? S.from : `${y}-01-01`, to: S.to < `${y}-12-31` ? S.to : `${y}-12-31` }) : S;
    const max = d3.max(agg, p => Math.max(p.in.known + p.in.derived + p.in.estimated, p.out.known + p.out.derived + p.out.estimated)) || 1;
    const h = v => (v / max * 100).toFixed(1);
    const col = (s, cls) => `<i class="io-b ${cls}"><b style="height:${h(s.estimated)}%"></b><s style="height:${h(s.known + s.derived)}%"></s></i>`;
    const base = J.base(D), lk = (k, extra) => J.href(base + "/dinheiro/" + k, Object.assign({ tab: "dinheiro" }, extra));
    const liv = J.livroInfo(D, Sy), livCur = liv.filter(r => r.st !== "unk").pop() || liv[liv.length - 1];
    const decs = J.topDecisions(D, Sy, 3), rec = J.topRecipients(D, Sy, 3), recMax = rec.length ? rec[0][1] : 1;
    const obras = (D.obras.obras || []).filter(o => !o.inicio || J.inSel(Sy, o.inicio, o.fim || J.today)).sort((a, b) => (b.custo_executado || b.custo_previsto || 0) - (a.custo_executado || a.custo_previsto || 0)).slice(0, 3);
    const shead = (t, href) => `<div class="shead"><h2 class="tag">${t}</h2>${href ? `<a href="${href}">Ver ${J.ICON.chev}</a>` : ""}</div>`;
    el.innerHTML = `<div class="hstat money-h">
        <div class="hs-row"><span class="hs-v num ${saldo < 0 ? "neg" : "pos"}"${vin || vout ? ` data-count="${saldo}" data-fmt="seur" data-key="m-saldo"` : ""}>${vin || vout ? signed(saldo, true) : "?"}</span>
          ${livCur ? `<button type="button" class="schip-btn" id="m-livchip" aria-label="Ver o Livro do ano">${livroChip(livCur)}</button>` : ""}</div>
        <div class="hlinks"><a class="hlink" href="${lk("entradas")}"><span class="l">Entrou</span><b class="num pos">${J.eur(vin, true)}</b><i aria-hidden="true">›</i></a>
          <a class="hlink" href="${lk("saidas")}"><span class="l">Saiu</span><b class="num neg">${J.eur(vout, true)}</b><i aria-hidden="true">›</i></a></div></div>
      ${agg.length > 1 ? `<div class="card io" role="group" aria-label="Entrou e saiu por ano">${agg.map(p => `<button type="button" class="io-y${y === p.key ? " on" : ""}${y && y !== p.key ? " dim" : ""}" data-y="${p.key}" aria-pressed="${y === p.key}"
          title="${p.key}: entrou ${J.eur(p.in.known + p.in.derived)}, saiu ${J.eur(p.out.known + p.out.derived)}"><span class="io-bars">${col(p.in, "in")}${col(p.out, "out")}</span><span class="io-l num">${p.key}</span></button>`).join("")}</div>
        <p class="hint">${y ? `A mostrar só ${y}. <button type="button" class="linkbtn" id="io-all">Ver todos os anos</button>` : "Toque num ano para ver só esse ano."}</p>` : ""}
      <a class="vlink" href="${lk("mes")}">Ver por mês <i aria-hidden="true">→</i></a>
      <div class="card flow"><div class="tag">De onde veio → para onde foi</div><div id="m-sankey"></div></div>
      <a class="vlink" href="${lk("geral")}">Ver fluxo completo <i aria-hidden="true">→</i></a>
      <div class="card sides" id="m-sides"></div>
      ${shead("Análises")}
      <div id="m-stories" class="stories"></div>
      ${shead("Maiores decisões", J.href(base, { tab: "decisoes" }))}
      ${decs.length ? J.glist(decs.map(p => J.decRow(D, p))) : none("Nenhuma decisão com valor nas atas lidas.")}
      ${shead("Quem mais recebeu", J.href(base + "/explorar/entidades", { tab: "explorar" }))}
      ${rec.length ? `<div class="card rank">${rec.map(([id, v], i) => `<a class="rk" href="${J.href(base + "/entidade/" + id)}"><span class="rk-i num">${i + 1}</span><span class="rk-t">${J.esc((D.entById[id] || {}).nome || id)}</span><b class="num">${J.eur(v, true)}</b>
          <span class="rk-b"><i style="width:${(v / recMax * 100).toFixed(1)}%"></i></span></a>`).join("")}</div>` : none("Sem pagamentos a entidades identificadas.")}
      ${shead("Obras", J.href(base + "/explorar/obras", { tab: "explorar" }))}
      ${obras.length ? J.glist(obras.map(o => ({ href: J.href(base + "/obra/" + o.id), title: J.esc(o.nome), sub: J.esc(o.local_texto || o.estado || ""), value: `<span class="num">${J.eur(o.custo_executado || o.custo_previsto, true)}</span>` }))) : none("Sem obras identificadas nesta seleção.")}
      <div id="m-mov"></div>`;
    // Sankey simples: origens → autarquia → destinos (no máximo 5 de cada lado; o resto junta-se em "Outros")
    const ins = G2.moneySplit(D, Sy, "entrada"), outs = G2.moneySplit(D, Sy, "saida");
    const ORI = d3.rollups(J.flowsOf(D).filter(f => f.direcao === "entrada" && !f.coberto && f.tipo_valor !== "previsto" && f.valor_cent != null && !J.DEBT.has(f.categoria)
      && (f.nivel || "known") === "known" && J.inSel(Sy, f.periodo_inicio || f.data, f.periodo_fim)), v => d3.sum(v, f => f.valor_cent), f => ({ estado: "Estado", municipio: "Câmara", freguesia: "Receitas próprias", ue: "Fundos europeus" })[f.origem] || "Outras origens")
      .sort((a, b) => b[1] - a[1]);
    const top5 = (arr, rest) => arr.length > 5 ? arr.slice(0, 4).concat([[rest, d3.sum(arr.slice(4), x => x[1])]]) : arr;
    const me = J.esc(D.aut.nome.replace(/^(Freguesia|Município|União das Freguesias) de /, ""));
    const links = top5(ORI, "Outras origens").map(([k, v]) => ({ source: k, target: me, value: v, real: v, level: "known", dir: "in" }))
      .concat(ins.gap ? [{ source: "Sem origem conhecida", target: me, value: ins.gap, real: ins.gap, level: "unknown", dir: "in" }] : [])
      .concat(top5(outs.cats, "Outros").map(([k, v]) => ({ source: me, target: k + " ", value: v, real: v, level: "known", dir: "out" })))
      .concat(outs.gap ? [{ source: me, target: "Sem explicação ", value: outs.gap, real: outs.gap, level: "unknown", dir: "out" }] : []);
    J.ch.sankey(J.$("#m-sankey", el), links.filter(l => l.value > 0), { name: "fluxo_dinheiro", compact: true });
    donutSides(J.$("#m-sides", el), D, Sy);
    drawStories(J.$("#m-stories", el), D, Sy);
    if (J.$("#m-livchip", el)) J.$("#m-livchip", el).onclick = () => { const c = J.$("#st-livro", el); if (c) { c.scrollIntoView({ behavior: "smooth", block: "center" }); c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash"); } };
    J.$$(".io-y", el).forEach(b => b.onclick = () => { st.y = st.y === b.dataset.y ? null : b.dataset.y; P.dinheiro(el, D, S, q); });
    if (J.$("#io-all", el)) J.$("#io-all", el).onclick = () => { st.y = null; P.dinheiro(el, D, S, q); };
    J.movements(J.$("#m-mov", el), D, Sy);
  };

  // ---------- painel de filtros genérico (Decisões e Documentos): grupos curtos com contagens ----------
  // spec: { st, all, pass(x, skipGroup), groups: [{ h, g, single?, opts: [[k, label, color?, sub?]] }], noun, clear(), onChange() }
  const isOnF = (st, g, k) => Array.isArray(st[g]) ? st[g].includes(k) : st[g] === k;
  const facetSheet = spec => {
    J.sheet(`<div id="fs"></div>`, { detent: "large" });
    const render = () => {
      const fs = J.$("#drawer #fs"); if (!fs) return;
      const { st, all, pass } = spec;
      const row = (g, [k, t, color, sub, test]) => {
        const on = isOnF(st, g, k), n = test ? all.filter(x => pass(x, g) && test(x)).length : null;
        return `<button type="button" class="frow${on ? " on" : ""}" data-g="${g}" data-k="${J.esc(String(k))}" aria-pressed="${on}"${n === 0 && !on ? " disabled" : ""}>
          ${color ? `<i class="fr-dot" style="background:${color}"></i>` : ""}<span class="fr-t">${J.esc(t)}${sub ? `<span class="fr-s">${sub}</span>` : ""}</span>${n == null ? "" : `<span class="fr-n num">${n}</span>`}<i class="fr-c">${J.ICON.check}</i></button>`;
      };
      fs.innerHTML = `<h2 class="sheet-t">Filtrar</h2>
        ${spec.groups().map(G => G.opts.length ? `${G.h ? `<h3 class="ghead">${G.h}</h3>` : ""}<div class="fgroup">${G.opts.map(o => row(G.g, o)).join("")}</div>` : "").join("")}
        <div class="fs-foot"><button type="button" class="btn" id="fs-clear">Limpar</button><button type="button" class="btn primary" id="fs-go">Ver ${all.filter(x => pass(x)).length} ${spec.noun}</button></div>`;
      J.$$(".frow", fs).forEach(b => b.onclick = () => {
        const g = b.dataset.g, raw = b.dataset.k, k = raw === "true" ? true : raw === "false" ? false : raw;
        if (Array.isArray(st[g])) st[g] = st[g].includes(k) ? st[g].filter(x => x !== k) : st[g].concat(k);
        else st[g] = typeof k === "boolean" ? !st[g] : st[g] === k ? null : k;
        const y = fs.parentElement.scrollTop; render(); fs.parentElement.scrollTop = y; spec.onChange();
      });
      J.$("#fs-clear", fs).onclick = () => { spec.clear(); render(); spec.onChange(); };
      J.$("#fs-go", fs).onclick = () => J.sheet(null);
    };
    render();
  };
  // chips dos filtros escolhidos (cada um com ✕) + "Limpar tudo"
  const activeChips = (items, clearId) => items.length ? `<div class="mov-active">${items.map(([g, k, t]) => `<button type="button" class="fchip" data-g="${g}" data-k="${J.esc(String(k))}" aria-label="Tirar o filtro ${J.esc(t)}">${J.esc(t)} <span aria-hidden="true">✕</span></button>`).join("")}
    <button type="button" class="linkbtn" id="${clearId}">Limpar tudo</button></div>` : "";
  const filtBtn = (id, n) => `<button type="button" class="mov-btn glass${n ? " on" : ""}" id="${id}">${J.ICON.grid}<span>Filtrar${n ? ` <b class="num">${n}</b>` : ""}</span></button>`;
  const dayLabel = dt => dt ? `${+dt.slice(8, 10)} ${MESES[+dt.slice(5, 7) - 1]} ${dt.slice(0, 4)}` : "sem data";

  // cor de cada decisão: pelo tipo; se o tipo for "outro", pelo tipo de documento de onde foi lida
  const DTYPE = { contrato: ["Contrato", "#0A84FF"], apoio: ["Apoio", "#30D158"], pessoal: ["Pessoal", "#BF5AF2"], regulamento: ["Regulamento", "#FF9F0A"],
    aprovacao: ["Aprovação", "#64D2FF"], informacao: ["Informação", "#8E8E93"],
    "doc:ata_junta": ["Ata da Junta", "#AC8E68"], "doc:ata_assembleia": ["Ata da Assembleia", "#FF6482"], "doc:outro": ["Outro documento", "#636366"] };
  const ATA_OK = /(aprova\w*|leitura|votação)\b[^.]{0,30}?\bd?[ao]?s?\s*atas?\b/i;
  J.decKind = (D, d) => {
    if (DTYPE[d.tipo]) return d.tipo;
    const t = ((D.docById || {})[d.doc_id] || {}).tipo;
    return t === "ata_junta" || t === "ata_assembleia" ? "doc:" + t : "doc:outro";
  };
  const VOTE = { unanimidade: "Unanimidade", maioria: "Votação dividida", rejeitada: "Rejeitada", sem_votacao: "Sem votação" };
  const decCard = (D, d) => {
    const k = J.decKind(D, d), [kn, kc] = DTYPE[k];
    return `<a class="vt-card" style="--kc:${kc}" href="${J.href(J.base(D) + "/decisao/" + d.id)}">${d.valor_cent ? `<b class="num ${(d.direcao || "saida") === "entrada" ? "pos" : "neg"}">${(d.direcao || "saida") === "entrada" ? "+" : "−"}${J.eur(d.valor_cent, true)}</b>` : ""}
      <span class="vt-t">${J.esc(d.assunto)}</span><span class="vt-s"><span class="vt-k">${kn}</span>${[J.esc(J.res(d.resultado)), d.votos_contra ? `${d.votos_contra} contra` : "", d.abstencoes ? `${d.abstencoes} abst.` : "", !d.valor_cent && d.tem_dinheiro ? "valor não escrito" : ""].filter(Boolean).map(x => " · " + x).join("")}</span></a>`;
  };

  // ---------- DECISÕES: linha do tempo vertical (cada reunião é um nó; as decisões são cartões) ----------
  P.decisoes = (el, D, S) => {
    if (!D.docById) D.docById = Object.fromEntries((D.documentos.documentos || []).map(x => [x.id, x]));
    const st = J.state.dec || (J.state.dec = { q: "", kind: [], area: [], vote: [], valor: false, atas: false });
    const reus = (D.reunioes.reunioes || []).filter(r => J.inSel(S, r.data));
    const all = (D.reunioes.decisoes || []).filter(d => J.inSel(S, d.data) && (S.kind !== "reu" || d.reuniao_id === S.reuniao.id)).sort((a, b) => (b.data || "").localeCompare(a.data || ""))
      .map(d => Object.assign(d, { _k: J.decKind(D, d), _ata: ATA_OK.test(d.assunto || "") }));
    const atasFalta = (D.documentos.esperado || []).filter(e => ["ata_junta", "ata_assembleia"].includes(e.tipo) && J.inSel(S, `${e.ano}-01-01`, `${e.ano}-12-31`) && !["present", "late", "not_applicable"].includes(e.estado)).length;
    const pass = (d, skip) => (skip === "atas" || st.atas || !d._ata)
      && (skip === "kind" || !st.kind.length || st.kind.includes(d._k))
      && (skip === "area" || !st.area.length || st.area.includes(d.area || "Outro"))
      && (skip === "vote" || !st.vote.length || st.vote.includes(d.resultado))
      && (skip === "valor" || !st.valor || d.valor_cent);
    const nF = () => st.kind.length + st.area.length + st.vote.length + (st.valor ? 1 : 0) + (st.atas ? 1 : 0);
    const clear = () => Object.assign(st, { kind: [], area: [], vote: [], valor: false, atas: false });
    el.innerHTML = `${hstat(all.length, all.length === 1 ? "decisão" : "decisões", `em ${reus.length} ${reus.length === 1 ? "reunião" : "reuniões"}${atasFalta ? ` · <span class="ty-miss">${atasFalta} atas em falta</span>` : ""}`, "", [all.length, "int", "decs"])}
      ${search("x-q", "Procurar assunto ou entidade", st.q)}
      <div id="x-top"></div>
      <div id="x-list"></div>
      ${J.glist([{ href: J.href(J.base(D) + "/decisoes/reunioes", { tab: "decisoes" }), title: "Reuniões", sub: "Atas, presenças, áreas e filtros avançados", value: reus.length }])}`;
    let n = 30;
    const draw = () => {
      const qq = st.q.toLowerCase();
      const rows = all.filter(d => pass(d) && (!qq || `${d.assunto} ${d.resumo} ${d.entidades} ${d.tags}`.toLowerCase().includes(qq)));
      const hidden = st.atas ? 0 : all.filter(d => d._ata && pass(d, "atas")).length;
      const act = st.kind.map(k => ["kind", k, DTYPE[k][0]]).concat(st.area.map(a => ["area", a, a]), st.vote.map(v => ["vote", v, VOTE[v]]),
        st.valor ? [["valor", true, "Com valor"]] : [], st.atas ? [["atas", true, "Com aprovação de atas"]] : []);
      const kinds = [...new Set(rows.map(d => d._k))];
      J.$("#x-top", el).innerHTML = `<div class="mov-head"><h3 class="ghead">Decisões <span class="num">${rows.length}</span></h3><div class="mov-btns">${filtBtn("x-filt", nF())}</div></div>
        ${activeChips(act, "x-clear")}
        ${kinds.length > 1 ? `<div class="klegend">${Object.keys(DTYPE).filter(k => kinds.includes(k)).map(k => `<span><i style="background:${DTYPE[k][1]}"></i>${DTYPE[k][0]}</span>`).join("")}</div>` : ""}
        ${hidden ? `<p class="hint">${hidden} aprovações de atas escondidas. <button type="button" class="linkbtn" id="x-atas">Mostrar</button></p>` : ""}`;
      const groups = d3.groups(rows.slice(0, n), d => d.reuniao_id || d.data);
      J.$("#x-list", el).innerHTML = rows.length ? `<div class="vt">${groups.map(([rid, ds]) => {
        const r = D.reuById[rid], dt = (r && r.data) || ds[0].data || "";
        return `<div class="vt-node"><a class="vt-h" href="${r ? J.href(J.base(D) + "/reuniao/" + r.id) : "javascript:void 0"}"><span class="vt-dot"></span>
            <span class="tag">${dayLabel(dt)}</span><span class="vt-o">${r ? J.org(r.orgao) : ""}${r && r.tipo === "extraordinaria" ? " · extraordinária" : ""}</span></a>
          ${ds.map(d => decCard(D, d)).join("")}</div>`;
      }).join("")}</div>` + (rows.length > n ? `<button class="btn wide more-btn glass" type="button">Mostrar mais (${rows.length - n})</button>` : "")
        : none(all.length ? "Nenhuma decisão com estes filtros." : "Sem decisões lidas nesta seleção. As atas podem não existir ou ainda não terem sido lidas.");
      const b = J.$(".more-btn", el); if (b) b.onclick = () => { n += 60; draw(); };
      J.$$("#x-top .fchip", el).forEach(c => c.onclick = () => { const g = c.dataset.g; if (Array.isArray(st[g])) st[g] = st[g].filter(x => x !== c.dataset.k); else st[g] = false; n = 30; draw(); });
      if (J.$("#x-clear", el)) J.$("#x-clear", el).onclick = () => { clear(); draw(); };
      if (J.$("#x-atas", el)) J.$("#x-atas", el).onclick = () => { st.atas = true; draw(); };
      J.$("#x-filt", el).onclick = () => facetSheet({ st, all, pass, noun: "decisões", clear, onChange: () => { n = 30; draw(); },
        groups: () => [
          { h: "Tipo de decisão", g: "kind", opts: Object.keys(DTYPE).filter(k => all.some(d => d._k === k)).map(k => [k, DTYPE[k][0], DTYPE[k][1], k.startsWith("doc:") ? "sem tipo — cor do documento" : "", d => d._k === k]) },
          { h: "Mostrar", g: "valor", opts: [[true, "Só com valor em €", null, "", d => d.valor_cent]] },
          { h: "", g: "atas", opts: [[true, "Incluir aprovação de atas", null, "“Aprovação da ata anterior” e parecidas", d => d._ata]] },
          { h: "Votação", g: "vote", opts: Object.keys(VOTE).filter(v => all.some(d => d.resultado === v)).map(v => [v, VOTE[v], null, "", d => d.resultado === v]) },
          { h: "Área", g: "area", opts: d3.groups(all, d => d.area || "Outro").sort((a, b) => b[1].length - a[1].length).map(([a]) => [a, a, null, "", d => (d.area || "Outro") === a]) },
        ] });
    };
    J.$("#x-q", el).addEventListener("input", e => { st.q = e.target.value; n = 30; draw(); });
    draw();
  };


  // ---------- ALERTAS: pilhas de cartões (como as notificações agrupadas do iOS) ----------
  const answered = f => !!f.resposta || ["respondido", "resolvido"].includes(f.estado);
  P.alertas = (el, D, S) => {
    const st = J.state.al || (J.state.al = { f: "aberto", open: {} });
    const flags = (D.alertas.alertas || []).filter(f => J.inSel(S, f.periodo_inicio || S.from, f.periodo_fim || f.periodo_inicio || S.to))
      .sort((a, b) => b.severidade - a.severidade || (b.periodo_inicio || "").localeCompare(a.periodo_inicio || ""));
    const n3 = flags.filter(f => f.severidade === 3).length, nA = flags.filter(answered).length;
    el.innerHTML = `<p class="quote-note serif"><em>“Um alerta é uma pergunta, não uma acusação.”</em></p>
      ${hstat(n3, n3 === 1 ? "precisa de explicação" : "precisam de explicação", `${flags.length} alertas no total · ${nA} com resposta`, n3 ? "alert" : "", [n3, "int", "al-n3"])}
      ${seg([["aberto", "Por responder"], ["resp", `Respondidos (${nA})`], ["todos", "Todos"]], st.f, "data-f")}
      <div id="f-list"></div>
      ${J.glist([{ href: J.href(J.base(D) + "/alertas/tipos", { tab: "alertas" }), title: "Ver por tipo e gravidade", sub: "Inclui descarregar em CSV" }, { href: "#/resposta", title: "Como a autarquia pode responder" }])}`;
    J.$$("[data-f]", el).forEach(b => b.onclick = () => { st.f = b.dataset.f; P.alertas(el, D, S); });
    const rows = flags.filter(f => st.f === "todos" || (st.f === "resp") === answered(f));
    const groups = d3.groups(rows, f => f.regra).sort((a, b) => d3.max(b[1], f => f.severidade) - d3.max(a[1], f => f.severidade) || b[1].length - a[1].length);
    const card = f => `<a class="stack-card${answered(f) ? " ok" : ""}" href="${J.href(J.base(D) + "/alerta/" + f.id)}"><span class="sc-t">${J.flagTitle(f)}</span>
      <span class="sc-s">${J.period(f)}${answered(f) ? ' · <b class="ok-t">respondido</b>' : ""}</span></a>`;
    J.$("#f-list", el).innerHTML = groups.length ? groups.map(([r, fs]) => {
      const open = st.open[r] || fs.length === 1;
      return `<div class="stack${open ? " open" : ""}" data-r="${r}" style="--layers:${Math.min(2, fs.length - 1)}">
        <button type="button" class="stack-h"><span class="tag">${J.esc(J.RULE[r] || r)}</span><span class="stack-n num">${fs.length}</span>${fs.length > 1 ? `<span class="stack-tg">${open ? "Juntar" : "Ver todos"}</span>` : ""}</button>
        <div class="stack-cards">${(open ? fs : fs.slice(0, 1)).map(card).join("")}</div></div>`;
    }).join("") : none(st.f === "resp" ? "A autarquia ainda não respondeu a nenhum alerta nesta seleção." : "Sem alertas nesta seleção.");
    J.$$(".stack-h", el).forEach(b => b.onclick = () => { const r = b.parentNode.dataset.r; st.open[r] = !st.open[r]; P.alertas(el, D, S); });
  };

  // ---------- PROCURAR › DOCUMENTOS: folhas de papel (publicado = cheio, em falta = tracejado) ----------
  const OKS = ["present", "late", "present_unreadable", "present_no_numbers"];
  const ICK = '<svg class="ic st-ok" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="M8 12.3l2.8 2.8L16.2 9.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const IMISS = '<svg class="ic st-miss" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.4"/></svg>';
  // ---------- DOCUMENTOS: a mesma linha do tempo, um cartão por documento ----------
  const docColor = (tax, t) => {
    const g = (tax.tipos[t] || {}).grupo || "outro";
    return { eleicoes: "#8E8E93", pedidos: "#8E8E93", outro: "#8E8E93" }[g] || (tax.grupos[g] || {}).cor || "#8E8E93";
  };
  const MES_I = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const slotDate = e => {
    const s = (e.slot || "").toLowerCase(), iso = s.match(/(\d{4})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-28`;
    const m = MES_I.findIndex(x => s.includes(x));
    return m >= 0 ? `${e.ano}-${String(m + 1).padStart(2, "0")}-28` : `${e.ano}-12-31`;
  };
  const LEIT2 = { lido: "Lido", ilegivel: "Ilegível", link: "Só o link" };
  const leitOf = d => d.link_only ? "link" : d.leitura === "unreadable" ? "ilegivel" : "lido";
  P.documentos = (el, D, S) => {
    const tax = D.aut.taxonomia;
    if (!D.docById) D.docById = Object.fromEntries((D.documentos.documentos || []).map(x => [x.id, x]));
    const st = J.state.dtl || (J.state.dtl = { tipo: [], leit: [], falta: false, q: "" });
    const exp = (D.documentos.esperado || []).filter(e => e.estado !== "not_applicable" && J.inSel(S, `${e.ano}-01-01`, `${e.ano}-12-31`) && (S.kind !== "m" || e.unidade === S.unit || !S.unit));
    const found = exp.filter(e => OKS.includes(e.estado)).length;
    const decByDoc = d3.group(D.reunioes.decisoes || [], d => d.doc_id);
    // documentos reais + os que deviam existir e não foram encontrados (só se o filtro "em falta" estiver ligado)
    // data do documento; se faltar, a data da reunião dessa ata, ou o início do período a que se refere
    const reuDate = {}; (D.reunioes.reunioes || []).forEach(r => [r.ata_doc, r.doc_id].forEach(k => k && !reuDate[k] && (reuDate[k] = r.data)));
    const dateOf = d => d.data_doc || reuDate[d.id] || d.periodo_inicio || d.date_hint;
    const docs = (D.documentos.documentos || []).map(d => ({ d, t: d.tipo || "outro", when: dateOf(d), l: leitOf(d), miss: false })).filter(x => x.when && J.inSel(S, x.when));
    const miss = exp.filter(e => !OKS.includes(e.estado)).map(e => ({ e, t: e.tipo, when: slotDate(e), l: null, miss: true }));
    const all = docs.concat(miss);
    const pass = (x, skip) => (skip === "falta" || x.miss === !!st.falta)
      && (skip === "tipo" || !st.tipo.length || st.tipo.includes(x.t))
      && (skip === "leit" || x.miss || !st.leit.length || st.leit.includes(x.l));
    const nF = () => st.tipo.length + st.leit.length + (st.falta ? 1 : 0);
    const clear = () => Object.assign(st, { tipo: [], leit: [], falta: false });
    const tname = t => (tax.tipos[t] || {}).nome || t;
    const types = d3.groups(exp, e => e.tipo).map(([t, es]) => ({ t, es: es.sort((a, b) => (a.slot || "").localeCompare(b.slot || "")), ok: es.filter(e => OKS.includes(e.estado)).length, imp: (tax.tipos[t] || {}).importancia || 0 }))
      .sort((a, b) => (a.ok === a.es.length) - (b.ok === b.es.length) || b.imp - a.imp);
    el.innerHTML = `${hstat(`${found}<small>/${exp.length}</small>`, "publicados", `${exp.length - found} documentos obrigatórios em falta`, "", null)}
      ${search("dt-q", "Procurar no título", st.q)}
      <div id="dt-top"></div><div id="dt-list"></div>
      <details class="fold"><summary>Documentos obrigatórios por tipo</summary><div class="ptypes">${types.map(x => `<button type="button" class="ptype" data-t="${x.t}"><span class="pt-h"><span class="pt-n">${J.esc(tname(x.t))}</span><span class="num">${x.ok}/${x.es.length}</span></span>
        <span class="papers">${x.es.map(e => `<i class="${OKS.includes(e.estado) ? "on" : ""}" title="${J.esc(e.slot || "")}: ${J.esc(J.STATE[e.estado] || e.estado)}"></i>`).join("")}</span></button>`).join("") || none("Sem calendário de documentos para esta seleção.")}</div></details>
      ${J.glist([{ href: J.href(J.base(D) + "/explorar/arquivo", { tab: "explorar" }), title: "Grelha por ano", sub: "O que devia existir e o que existe, ano a ano", value: docs.length }])}`;
    let n = 30;
    const draw = () => {
      const qq = st.q.toLowerCase();
      const rows = all.filter(x => pass(x) && (!qq || (x.miss ? tname(x.t) + " " + (x.e.slot || "") : x.d.titulo || "").toLowerCase().includes(qq)))
        .sort((a, b) => (b.when || "").localeCompare(a.when || ""));
      const act = st.tipo.map(t => ["tipo", t, tname(t)]).concat(st.leit.map(l => ["leit", l, LEIT2[l]]), st.falta ? [["falta", true, "Em falta"]] : []);
      J.$("#dt-top", el).innerHTML = `<div class="mov-head"><h3 class="ghead">${st.falta ? "Em falta" : "Documentos"} <span class="num">${rows.length}</span></h3><div class="mov-btns">${filtBtn("dt-filt", nF())}</div></div>
        ${activeChips(act, "dt-clear")}`;
      const groups = d3.groups(rows.slice(0, n), x => x.miss ? x.when.slice(0, 7) : x.when);
      J.$("#dt-list", el).innerHTML = rows.length ? `<div class="vt">${groups.map(([k, xs]) => `<div class="vt-node"><div class="vt-h"><span class="vt-dot${xs[0].miss ? " miss" : ""}"></span>
          <span class="tag">${xs[0].miss ? `${MESES[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}` : dayLabel(k)}</span></div>
          ${xs.map(x => {
            const c = docColor(tax, x.t);
            if (x.miss) return `<div class="vt-card miss" style="--kc:${c}"><span class="vt-t">${J.esc(tname(x.t))}</span><span class="vt-s"><span class="vt-k">${J.esc(/^\d{4}-\d{2}$/.test(x.e.slot || "") ? `${MES_I[+x.e.slot.slice(5) - 1]} ${x.e.slot.slice(0, 4)}` : x.e.slot || String(x.e.ano))}</span> · ${J.esc(J.STATE[x.e.estado] || x.e.estado)}</span></div>`;
            const ds = decByDoc.get(x.d.id) || [];
            return `<a class="vt-card" style="--kc:${c}" href="${J.href(J.base(D) + "/doc/" + x.d.id)}" data-doc="${x.d.id}"><span class="vt-t">${J.esc(J.sc(x.d.titulo || tname(x.t)))}</span>
              <span class="vt-s"><span class="vt-k">${J.esc(tname(x.t))}</span>${ds.length ? ` · <b>${ds.length} ${ds.length === 1 ? "decisão" : "decisões"}</b>` : ""}${x.l !== "lido" ? ` · ${LEIT2[x.l]}` : ""}${x.d.removed_at ? " · retirado do site" : ""}</span></a>`;
          }).join("")}</div>`).join("")}</div>` + (rows.length > n ? `<button class="btn wide more-btn glass" type="button">Mostrar mais (${rows.length - n})</button>` : "")
        : none("Nenhum documento com estes filtros.");
      const b = J.$("#dt-list .more-btn", el); if (b) b.onclick = () => { n += 60; draw(); };
      // tocar num documento com decisões: mostra as decisões dessa reunião; depois "Abrir documento"
      J.$$("[data-doc]", el).forEach(a => a.onclick = e => {
        const doc = D.docById[a.dataset.doc], ds = (decByDoc.get(doc.id) || []).slice().sort((p, q2) => (p.ordem || 0) - (q2.ordem || 0));
        if (!ds.length) return;
        e.preventDefault();
        ds.forEach(d => d._k = J.decKind(D, d));
        J.sheet(`<div class="tag">${J.esc(tname(doc.tipo))} · ${J.date(dateOf(doc))}</div><h2 class="sheet-t">${J.esc(J.sc(doc.titulo || ""))}</h2>
          <a class="btn wide primary-sec" href="${a.getAttribute("href")}">Abrir documento ›</a>
          <h3 class="ghead">${ds.length} ${ds.length === 1 ? "decisão" : "decisões"} neste documento</h3><div class="vt sheet-vt">${ds.map(d => decCard(D, d)).join("")}</div>`, { detent: "large" });
        J.$$("#drawer a", document).forEach(x => x.addEventListener("click", () => J.sheet(null)));
      });
      J.$$("#dt-top .fchip", el).forEach(c => c.onclick = () => { const g = c.dataset.g; if (Array.isArray(st[g])) st[g] = st[g].filter(x => x !== c.dataset.k); else st[g] = false; n = 30; draw(); });
      if (J.$("#dt-clear", el)) J.$("#dt-clear", el).onclick = () => { clear(); draw(); };
      J.$("#dt-filt", el).onclick = () => facetSheet({ st, all, pass, noun: "documentos", clear, onChange: () => { n = 30; draw(); },
        groups: () => [
          { h: "Mostrar", g: "falta", opts: [[true, "Só os que estão em falta", "#FF453A", "Atas e documentos obrigatórios que não encontrámos", x => x.miss]] },
          { h: "Tipo de documento", g: "tipo", opts: d3.groups(all.filter(x => x.miss === !!st.falta), x => x.t).sort((a, b) => b[1].length - a[1].length).map(([t]) => [t, tname(t), docColor(tax, t), "", x => x.t === t]) },
          { h: "Leitura", g: "leit", opts: st.falta ? [] : Object.keys(LEIT2).map(l => [l, LEIT2[l], null, "", x => x.l === l]) },
        ] });
    };
    J.$("#dt-q", el).addEventListener("input", e => { st.q = e.target.value; n = 30; draw(); });
    J.$$("[data-t]", el).forEach(b => b.onclick = () => { st.tipo = [b.dataset.t]; st.falta = false; J.$("details.fold", el).open = false; draw(); J.$("#dt-top", el).scrollIntoView({ behavior: "smooth" }); });
    draw();
  };

  // ---------- EXPLORAR › PESSOAS ----------
  P.pessoas = (el, D, S) => {
    const A = D.aut, st = J.state.ppl || (J.state.ppl = { q: "" });
    const cargos = (D.pessoas.cargos || []).filter(c => J.inSel(S, c.inicio, c.fim || J.today));
    const reus = new Set((D.reunioes.reunioes || []).filter(r => J.inSel(S, r.data)).map(r => r.id));
    const pres = (D.reunioes.presencas || []).filter(p => reus.has(p.reuniao_id));
    const ids = [...new Set(cargos.map(c => c.pessoa_id).concat(pres.map(p => p.pessoa_id)))];
    const people = ids.map(id => D.pessoaById[id]).filter(Boolean).map(p => {
      const mine = pres.filter(x => x.pessoa_id === p.id), cs = cargos.filter(c => c.pessoa_id === p.id);
      return { p, att: mine.length ? mine.filter(x => x.estado === "presente").length / mine.length : null, cs };
    }).sort((a, b) => a.p.nome.localeCompare(b.p.nome));
    el.innerHTML = `${search("p-q", "Procurar pessoa", st.q)}<div id="p-list"></div>
      ${J.glist([{ href: J.href(J.base(D) + "/explorar/presencas", { tab: "explorar" }), title: "Presenças e votações", sub: "Quem esteve em cada reunião e como votou" }])}`;
    const draw = () => {
      const qq = st.q.toLowerCase();
      glistMore(J.$("#p-list", el), people.filter(x => !qq || x.p.nome.toLowerCase().includes(qq)).map(x => {
        const c = x.cs[x.cs.length - 1];
        return { href: J.href(J.base(D) + "/pessoa/" + x.p.id), icon: `<i class="pdot" style="background:${c && c.lista ? J.partyColor(A, c.lista) : "var(--unread)"}"></i>`, title: J.esc(x.p.nome),
          sub: [...new Set(x.cs.map(c => [c.funcao, c.lista].filter(Boolean).join(" · ")))].map(J.esc).join("; ") || "sem cargo registado",
          value: x.att == null ? "" : `<span title="Presenças">${J.pct(x.att)}</span>` };
      }), "Ninguém identificado nesta seleção.", 40);
    };
    J.$("#p-q", el).addEventListener("input", e => { st.q = e.target.value; draw(); });
    draw();
  };

  // ---------- EXPLORAR › ENTIDADES ----------
  P.entidades = (el, D, S) => {
    const st = J.state.ent || (J.state.ent = { q: "" });
    const by = {};
    J.flowsOf(D).filter(f => f.direcao === "saida" && f.entidade_id && J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim)).forEach(f => {
      const b = by[f.entidade_id] = by[f.entidade_id] || { id: f.entidade_id, total: 0, n: 0, unk: 0 };
      b.n++; if (f.valor_cent == null) b.unk++; else b.total += f.valor_cent;
    });
    const list = Object.values(by).map(b => Object.assign(b, { e: D.entById[b.id] || { nome: b.id } })).sort((a, b) => b.total - a.total);
    el.innerHTML = `${search("e-q", "Procurar nome ou NIF", st.q)}<div id="e-list"></div>
      ${J.glist([{ href: J.href(J.base(D) + "/explorar/graficos", { tab: "explorar" }), title: "Gráficos e evolução", sub: "Quem recebe mais e paragens bruscas" }])}`;
    const draw = () => {
      const qq = st.q.toLowerCase();
      glistMore(J.$("#e-list", el), list.filter(b => !qq || `${b.e.nome} ${b.e.nif || ""}`.toLowerCase().includes(qq)).map(b => ({ href: J.href(J.base(D) + "/entidade/" + b.id),
        title: J.esc(b.e.nome), sub: [b.e.tipo, b.e.nif ? "NIF " + b.e.nif : "", `${b.n} ${b.n === 1 ? "movimento" : "movimentos"}`].filter(Boolean).map(J.esc).join(" · "),
        value: b.total ? `<span class="num">${J.eur(b.total)}</span>` : `<span class="badge unk">valor ?</span>` })), "Sem pagamentos a entidades nesta seleção.", 40);
    };
    J.$("#e-q", el).addEventListener("input", e => { st.q = e.target.value; draw(); });
    draw();
  };

  // ---------- EXPLORAR: lista agrupada, como as Definições do iOS ----------
  P.explorar = (el, D, S, q = {}) => {
    const st = J.state.find || (J.state.find = { q: "" });
    if (q.find != null) st.q = q.find;   // vindo de um nome sem página (ex.: entidade de uma decisão)
    const exp = (D.documentos.esperado || []).filter(e => e.estado !== "not_applicable" && J.inSel(S, `${e.ano}-01-01`, `${e.ano}-12-31`) && (S.kind !== "m" || e.unidade === S.unit || !S.unit));
    const found = exp.filter(e => ["present", "late", "present_unreadable", "present_no_numbers"].includes(e.estado)).length;
    const people = new Set((D.pessoas.cargos || []).filter(c => J.inSel(S, c.inicio, c.fim || J.today)).map(c => c.pessoa_id)).size;
    const ents = new Set(J.flowsOf(D).filter(f => f.direcao === "saida" && f.entidade_id && J.inSel(S, f.periodo_inicio || f.data, f.periodo_fim)).map(f => f.entidade_id)).size;
    const obras = (D.obras.obras || []).filter(o => J.inSel(S, o.inicio || o.criado, o.fim)).length;
    const go = k => J.href(J.base(D) + "/explorar/" + k, { tab: "explorar" });
    // entradas rápidas (mosaico) + pesquisa em tudo
    const quick = [["documentos", "Documentos", "doc", `${found}/${exp.length}`], ["pessoas", "Pessoas", "people", people], ["entidades", "Entidades", "building", ents],
      ["obras", "Obras", "crane", obras], ["eleicoes", "Eleições", "ballot", ""], ["nota", "Como é calculado", "gauge", ""]];
    el.innerHTML = `${search("s-q", "Procurar documentos, pessoas, entidades, decisões", st.q)}
      <div id="s-res"></div>
      <div id="s-home"><div class="quick">${quick.map(([k, t, i, v]) => `<a class="qk" href="${go(k)}">${J.ICON[i]}<span class="qk-t">${t}</span>${v !== "" ? `<span class="qk-v num">${v}</span>` : ""}</a>`).join("")}</div>
      ${J.glist([
        ...(J.mobile() ? [] : [{ href: go("linha"), title: "Linha do tempo detalhada", sub: "Todos os documentos, alertas e dinheiro" }]),
        { href: `#/comparar?a=${D.aut.id}`, title: "Comparar com outras autarquias" },
        { href: J.href(J.base(D) + "/pedidos", { tab: "explorar" }), title: "Pedidos de documentos" },
        { href: "#/metodologia", title: "Metodologia" },
        { href: "#/sobre", title: "Sobre a Janela Cívica" }], "Mais")}</div>`;
    const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const draw = () => {
      const qq = norm(st.q.trim());
      J.$("#s-home", el).hidden = !!qq;
      if (qq.length < 2) { J.$("#s-res", el).innerHTML = ""; return; }
      const hit = t => norm(t).includes(qq);
      const sec = (title, rows) => rows.length ? J.glist(rows.slice(0, 6), `${title} · ${rows.length}`) : "";
      const html = sec("Decisões", (D.reunioes.decisoes || []).filter(d => hit(d.assunto) || hit(d.entidades)).sort((a, b) => (b.data || "").localeCompare(a.data || ""))
          .map(d => ({ href: J.href(J.base(D) + "/decisao/" + d.id), title: J.esc(d.assunto), sub: J.date(d.data), value: d.valor_cent ? J.money(d.valor_cent, d.direcao || "saida") : "" })))
        + sec("Entidades", (D.entidades.entidades || []).filter(e => hit(e.nome) || hit(e.nif) || (e.aliases || []).some(hit)).map(e => ({ href: J.href(J.base(D) + "/entidade/" + e.id), title: J.esc(e.nome), sub: J.esc([e.tipo, e.nif ? "NIF " + e.nif : ""].filter(Boolean).join(" · ")) })))
        + sec("Pessoas", (D.pessoas.pessoas || []).filter(p => hit(p.nome) || (p.aliases || []).some(hit)).map(p => ({ href: J.href(J.base(D) + "/pessoa/" + p.id), title: J.esc(p.nome) })))
        + sec("Documentos", (D.documentos.documentos || []).filter(d => hit(d.titulo)).sort((a, b) => (b.data_doc || "").localeCompare(a.data_doc || ""))
          .map(d => ({ href: J.href(J.base(D) + "/doc/" + d.id), title: J.esc(d.titulo), sub: J.date(d.data_doc) })));
      J.$("#s-res", el).innerHTML = html || none(`Nada encontrado para «${J.esc(st.q)}».`);
    };
    J.$("#s-q", el).addEventListener("input", e => { st.q = e.target.value; draw(); });
    draw();
  };

  // ---------- ELEIÇÕES (todas, mais recentes primeiro) ----------
  P.eleicoes = (el, D) => {
    const all = D.mandatos.slice().reverse().flatMap(m => (m.eleicoes || []).map(e => ({ m, e })));
    el.innerHTML = all.map(({ m, e }) => `<h3 class="ghead">${J.date(e.data)}</h3>${J.timeline.electionHtml(D, m, e)}`).join("") || empty("Resultados das eleições ainda não recolhidos.");
  };

  // ---------- LINHA DO TEMPO DETALHADA (todas as faixas; ecrã largo) ----------
  P.linha = (el, D, S) => { el.innerHTML = `<section class="tlwrap"><div id="tl"></div></section>`; J.timeline.render(J.$("#tl"), D, S); };
})();

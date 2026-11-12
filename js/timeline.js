/* Linha do tempo principal: eleições, quem governa, assembleia, transparência, documentos (por grupo), alertas, dinheiro, pedidos.
   Selecionar na linha do tempo = selecionar nos menus. Roda do rato = zoom. Arrastar no eixo = intervalo. */
(function () {
  const J = window.J, d3 = window.d3;
  const T = (J.timeline = {});
  const GROUPS = ["planeamento", "contas", "reunioes", "saidas", "entradas", "pessoas", "regras", "narrativa"];
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  let full = false;
  try { full = localStorage.getItem("jc-tl-full") === "1"; } catch (e) { /* sem armazenamento: começa resumida */ }
  const state = { off: new Set(), status: "", q: "", zoom: null, full, help: false };

  T.render = (el, D, S) => {
    const A = D.aut, tax = A.taxonomia;
    const mobile = false;
    const docs = D.documentos.documentos || [], exp = D.documentos.esperado || [];
    const first = d3.min([...D.mandatos.map(m => m.inicio), ...docs.map(d => d.data_doc).filter(Boolean)]) || "2013-01-01";
    const t0 = new Date(Math.max(new Date(first.slice(0, 4) + "-01-01"), new Date("2009-01-01"))), t1 = new Date();
    const compact = mobile || !state.full;   // por omissão: 3 faixas (Junta, Documentos, Alertas)
    el.innerHTML = `
      ${compact ? "" : `<div class="tlbar">
        <input type="search" id="tl-q" placeholder="Procurar na linha do tempo (documentos, decisões, entidades)…" value="${J.esc(state.q)}" aria-label="Procurar">
        <select id="tl-status" aria-label="Estado"><option value="">Todos os estados</option><option value="falta">Só o que falta</option><option value="present">Só publicados</option><option value="unread">Ilegíveis / sem números</option></select>
        <div class="chips" id="tl-chips">${GROUPS.map(g => `<button class="chip ${state.off.has(g) ? "off" : ""}" data-g="${g}"><i style="background:${tax.grupos[g].cor}"></i>${tax.grupos[g].nome}</button>`).join("")}</div>
      </div>`}
      <div class="tlbox" id="tl-box" tabindex="0" aria-label="Linha do tempo. Setas mudam o ano selecionado."></div>
      <div class="tlhint"><span class="state s-present"><i></i>publicado</span><span class="state s-not_found_yet"><i></i>em falta</span><span title="Uma marca por ano: o número diz quantos documentos esperados não encontrámos nesse ano"><span class="legend-n">12</span> = documentos em falta nesse ano</span><span class="state s-present_unreadable"><i></i>ilegível</span><span class="sev sev3">alerta</span>
        <button class="help" id="tl-help" type="button" aria-label="Como usar a linha do tempo" aria-expanded="${state.help}">?</button>
        ${mobile ? "" : `<button class="btn tlmore" id="tl-full" type="button">${state.full ? "Ver resumo (3 faixas)" : "Ver detalhe (todas as faixas)"}</button>`}</div>
      ${state.help ? `<p class="tlhelp">Passe o rato para ver o detalhe. Clique num mandato ou num ano para o selecionar. Arraste no eixo dos anos para escolher um intervalo. Use a roda do rato para aproximar; duplo clique para voltar.</p>` : ""}`;
    if (!compact) J.$("#tl-status", el).value = state.status;
    const box = J.$("#tl-box", el);
    const W = Math.max(340, box.clientWidth), L = mobile ? 70 : 118, R = 10;
    // faixas
    const rows = []; let y = 22;
    const add = (key, h, label, sub) => { rows.push({ key, y, h, label, sub }); y += h + 4; };
    if (!compact) add("eleicoes", 14, "Eleições");
    add("governo", 24, A.tipo === "municipio" ? "Câmara" : "Junta");
    if (!compact) add("assembleia", 14, "Assembleia");
    if (!compact) add("score", 14, "Transparência");
    const groups = compact ? [] : GROUPS.filter(g => !state.off.has(g));
    if (compact) add("densidade", 18, "Documentos");
    else groups.forEach(g => add("g:" + g, 16, tax.grupos[g].nome));
    add("flags", 16, "Alertas");
    if (!compact && (D.reunioes.eventos || []).length) add("eventos", 14, "Eventos");
    if (!compact) add("dinheiro", 34, "Dinheiro", "entrou / saiu");
    if (!compact && (D.alertas.pedidos || []).length) add("pedidos", 12, "Pedidos de documentos");
    if (!compact && A.tipo === "municipio") add("transf", 12, "Para freguesias");
    const H = y + 22;
    const x0 = d3.scaleTime().domain([t0, t1]).range([L, W - R]);
    let x = state.zoom ? state.zoom.rescaleX(x0) : x0;
    const svg = d3.select(box).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);
    const defs = svg.append("defs");
    const pat = defs.append("pattern").attr("id", "hatch-grey").attr("patternUnits", "userSpaceOnUse").attr("width", 4).attr("height", 4).attr("patternTransform", "rotate(45)");
    pat.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 4).attr("stroke", css("--unread")).attr("stroke-width", 2);
    defs.append("clipPath").attr("id", "tl-clip").append("rect").attr("x", L).attr("y", 0).attr("width", W - L - R).attr("height", H);
    rows.forEach(r => {
      svg.append("text").attr("class", "tl-lab" + (r.key === "governo" ? " b" : "")).attr("x", 6).attr("y", r.sub ? r.y + 12 : r.y + r.h / 2 + 4).text(r.label);
      if (r.sub) svg.append("text").attr("class", "tl-lab").attr("x", 6).attr("y", r.y + 26).style("font-size", "12px").text(r.sub);
    });
    const gAxis = svg.append("g").attr("class", "tl-axis").attr("transform", `translate(0,${H - 18})`);
    const plot = svg.append("g").attr("clip-path", "url(#tl-clip)");
    const row = k => rows.find(r => r.key === k);

    // índice de pesquisa
    const q = J.norm ? J.norm(state.q) : state.q.toLowerCase();
    const match = d => !q || (d.titulo || "").toLowerCase().includes(q) || (D.reunioes.decisoes || []).some(x => x.doc_id === d.id && ((x.assunto || "") + " " + (x.entidades || "")).toLowerCase().includes(q));

    function draw() {
      plot.selectAll("*").remove();
      gAxis.call(d3.axisBottom(x).ticks(Math.max(3, Math.floor((W - L) / 70))).tickSizeOuter(0));
      gAxis.selectAll("text").on("click", (e, d) => J.setQ({ sel: "a:" + d.getFullYear() }));
      // grelha de anos
      x.ticks(d3.timeYear).forEach(t => plot.append("line").attr("class", "tl-grid").attr("x1", x(t)).attr("x2", x(t)).attr("y1", 18).attr("y2", H - 18));
      // seleção
      const sx0 = x(new Date(S.from)), sx1 = x(new Date(S.to));
      plot.append("rect").attr("class", "tl-sel").attr("x", sx0).attr("y", 16).attr("width", Math.max(2, sx1 - sx0)).attr("height", H - 34);
      plot.append("line").attr("class", "tl-selline").attr("x1", sx0).attr("x2", sx0).attr("y1", 16).attr("y2", H - 18);
      plot.append("line").attr("class", "tl-selline").attr("x1", sx1).attr("x2", sx1).attr("y1", 16).attr("y2", H - 18);
      // eleições
      const re = row("eleicoes");
      if (re) [...new Set(D.mandatos.map(m => m.inicio))].forEach(d => {
        const m = D.mandatos.find(mm => mm.inicio === d);
        const el_ = (m.eleicoes || [])[0];
        plot.append("path").attr("d", d3.symbol(d3.symbolDiamond, 60)()).attr("transform", `translate(${x(new Date(d))},${re.y + 6})`).attr("fill", css("--text"))
          .on("mousemove", e => J.tip(e, `<b>Eleições ${J.date(d)}</b>` + (el_ ? `<br>Inscritos ${el_.inscritos || "?"} · votantes ${el_.votantes || "?"}` +
            (el_.listas || []).map(l => `<div class="row"><span>${J.esc(l.lista)}</span><span>${l.votos || "?"} votos · ${l.mandatos ?? "?"} lugares</span></div>`).join("") : "<br>Resultados não recolhidos"))).on("mouseleave", J.hideTip);
      });
      // quem governa
      const rg = row("governo");
      D.mandatos.forEach(m => {
        const a = x(new Date(m.inicio)), b = x(new Date(m.fim && m.fim < J.today ? m.fim : J.today));   // um mandato em curso acaba hoje
        const g = plot.append("g").attr("class", "tl-band").on("click", () => J.setQ({ sel: "m:" + m.id }))
          .on("mousemove", e => J.tip(e, T.card(D, m))).on("mouseleave", J.hideTip);
        g.append("rect").attr("x", a + 1).attr("y", rg.y).attr("width", Math.max(1, b - a - 2)).attr("height", rg.h).attr("rx", 4)
          .attr("fill", J.partyColor(A, m.lista)).attr("stroke", S.kind === "m" && S.m.id === m.id ? css("--text") : "none").attr("stroke-width", 2);
        const pn = (m.presidente || "").split(" ").filter(Boolean);
        const opts = m.presidente ? [`${pn[0]} ${pn[pn.length - 1]}${m.lista ? " · " + m.lista : ""}`, `${pn[0][0]}. ${pn[pn.length - 1]}`, pn[pn.length - 1]] : ["Presidente desconhecido", "Desconhecido", "?"];
        const label = opts.find(t => b - a - 10 > t.length * 7);   // o maior texto que cabe; o nome completo está na dica
        if (label) g.append("text").attr("x", a + 6).attr("y", rg.y + 16).text(label);
      });
      // assembleia
      const ra = row("assembleia");
      if (ra) D.mandatos.forEach(m => {
        const ls = ((m.assembleia || {}).listas || []).filter(l => l.mandatos);
        const tot = d3.sum(ls, l => l.mandatos);
        if (!tot) return;
        let a = x(new Date(m.inicio)); const span = x(new Date(m.fim || J.today)) - a;
        ls.forEach(l => { const w = span * l.mandatos / tot; plot.append("rect").attr("x", a + 1).attr("y", ra.y).attr("width", Math.max(0, w - 1)).attr("height", ra.h).attr("fill", J.partyColor(A, l.partido))
          .on("mousemove", e => J.tip(e, `<b>Assembleia ${m.inicio.slice(0, 4)}–${(m.fim || "hoje").slice(0, 4)}</b>` + ls.map(z => `<div class="row"><span>${J.esc(z.lista)}</span><span>${z.mandatos} lugares</span></div>`).join(""))).on("mouseleave", J.hideTip); a += w; });
      });
      // transparência
      const rs = row("score");
      if (rs) Object.entries(A.score || {}).forEach(([yy, s]) => {
        const a = x(new Date(`${yy}-01-01`)), b = x(new Date(`${yy}-12-31`));
        plot.append("rect").attr("x", a).attr("y", rs.y).attr("width", Math.max(1, b - a - 1)).attr("height", rs.h)
          .attr("fill", d3.interpolateRgb(css("--unread"), css("--ok"))((s.total || 0) / 100))
          .on("mousemove", e => J.tip(e, `<b>Transparência ${yy}: ${Math.round(s.total || 0)}/100</b>` + ["contas", "planeamento", "reunioes", "dinheiro", "pessoas", "regras", "acesso"].map(k => `<div class="row"><span>${J.DIM[k]}</span><span>${Math.round((s[k] ?? 0) * 10) / 10}</span></div>`).join("")))
          .on("mouseleave", J.hideTip).style("cursor", "pointer").on("click", () => J.setQ({ sel: "a:" + yy }));
      });
      // documentos por grupo (agrupados por mês)
      const byKey = new Map();
      const push = (g, ym, item) => { const k = g + "|" + ym; if (!byKey.has(k)) byKey.set(k, { g, ym, docs: [], exp: [] }); byKey.get(k)[item.kind].push(item.o); };
      docs.forEach(d => { const g = (tax.tipos[d.tipo] || {}).grupo; if (g && d.data_doc && match(d)) push(g, d.data_doc.slice(0, 7), { kind: "docs", o: d }); });
      // o que falta: uma só marca por ano (e por faixa) com o número, em vez de muitas marcas por mês
      const missY = new Map();
      exp.filter(e => !["present", "late", "not_applicable"].includes(e.estado)).forEach(e => {
        const g = (tax.tipos[e.tipo] || {}).grupo; if (!g) return;
        const lane = compact ? "densidade" : "g:" + g, k = lane + "|" + e.ano;
        if (!missY.has(k)) missY.set(k, { lane, g, ano: e.ano, ym: String(e.ano), docs: [], exp: [] });
        missY.get(k).exp.push(e);
      });
      const mw = Math.max(2, x(new Date("2001-02-01")) - x(new Date("2001-01-01")));
      for (const c of byKey.values()) {
        const r = compact ? row("densidade") : row("g:" + c.g);
        if (!r) continue;
        if (state.status === "falta" && !c.exp.some(e => ["not_found_yet", "missing"].includes(e.estado))) continue;
        if (state.status === "present" && !c.docs.length) continue;
        const unread = c.docs.some(d => ["unreadable"].includes(d.leitura)) || c.exp.some(e => ["present_unreadable", "present_no_numbers"].includes(e.estado));
        if (state.status === "unread" && !unread) continue;
        const imp = d3.max([...c.docs, ...c.exp], o => (tax.tipos[o.tipo] || {}).importancia || 0) || 0;
        const cx = x(new Date(c.ym + "-15"));
        const h = 5 + imp * 3, w = Math.max(3, Math.min(mw - 1, 8));
        const miss = c.exp.some(e => e.estado === "missing"), nf = c.exp.some(e => e.estado === "not_found_yet");
        const cls = "tick" + (c.docs.length ? (unread ? " unread" : "") : (miss ? " miss" : nf ? " nf" : " unread"));
        const g = plot.append("g").attr("transform", `translate(${cx},${r.y + r.h / 2})`).attr("class", "tick-g");
        g.append("rect").attr("class", cls).attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h).attr("rx", 1.5).attr("fill", tax.grupos[c.g].cor);
        if (c.docs.length && c.exp.length) g.append("rect").attr("x", w / 2 + 1).attr("y", -h / 2).attr("width", 2).attr("height", h).attr("fill", css("--nf"));
        g.append("rect").attr("x", -6).attr("y", -7).attr("width", 12).attr("height", 14).attr("fill", "transparent").style("cursor", "pointer")
          .on("mousemove", e => J.tip(e, T.tickCard(D, c))).on("mouseleave", J.hideTip)
          .on("click", () => T.openTick(D, c));
      }
      if (state.status !== "present") for (const c of missY.values()) {
        const r = row(c.lane); if (!r) continue;
        const unreadOnly = c.exp.every(e => ["present_unreadable", "present_no_numbers"].includes(e.estado));
        if (state.status === "falta" && unreadOnly) continue;
        if (state.status === "unread" && !c.exp.some(e => ["present_unreadable", "present_no_numbers"].includes(e.estado))) continue;
        const a = x(new Date(`${c.ano}-01-01`)), b = x(new Date(`${c.ano}-12-31`)), cx = (a + b) / 2;
        const miss = c.exp.some(e => e.estado === "missing");
        const col = unreadOnly ? css("--unread") : miss ? css("--miss") : css("--nf");
        const label = String(c.exp.length), w = Math.min(Math.max(16, label.length * 7 + 8), Math.max(10, b - a - 4)), h = Math.min(r.h, 14);
        const g = plot.append("g").attr("transform", `translate(${cx},${r.y + r.h / 2})`).style("cursor", "pointer")
          .on("mousemove", e => J.tip(e, T.tickCard(D, Object.assign({}, c, { g: c.g, ym: String(c.ano) })))).on("mouseleave", J.hideTip)
          .on("click", () => T.openTick(D, c));
        g.append("rect").attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h).attr("rx", h / 2)
          .attr("fill", css("--card")).attr("stroke", col).attr("stroke-width", 1.5).attr("stroke-dasharray", miss ? null : "3 2");
        if (w >= 14) g.append("text").attr("text-anchor", "middle").attr("y", 4).attr("font-size", 12).attr("font-weight", 700).attr("fill", col).text(label);
      }
      // alertas
      const rf = row("flags");
      (D.alertas.alertas || []).forEach(f => {
        const d = f.periodo_inicio || f.primeira_vez; if (!d) return;
        const size = [0, 30, 50, 80][f.severidade];
        plot.append("path").attr("d", d3.symbol(d3.symbolTriangle, size)()).attr("transform", `translate(${x(new Date(d.slice(0, 10)))},${rf.y + 7})`)
          .attr("fill", css("--sev" + f.severidade)).style("cursor", "pointer")
          .on("mousemove", e => J.tip(e, `${J.sevTag(f.severidade)}<br><b>${J.flagTitle(f)}</b><br>${J.esc(f.texto)}`)).on("mouseleave", J.hideTip)
          .on("click", () => location.hash = J.href(J.base(D) + "/alerta/" + f.id));
      });
      // eventos (festas, assinaturas, visitas, consultas públicas…)
      const rv = row("eventos");
      if (rv) (D.reunioes.eventos || []).forEach(ev => plot.append("circle").attr("cx", x(new Date(ev.data))).attr("cy", rv.y + 7).attr("r", 3.5)
        .attr("fill", css("--accent")).attr("opacity", .8).style("cursor", "pointer")
        .on("mousemove", e => J.tip(e, `<b>${J.esc(ev.nome)}</b><br>${J.date(ev.data)}`)).on("mouseleave", J.hideTip)
        .on("click", () => location.hash = J.href(J.base(D) + "/doc/" + ev.doc_id)));
      // dinheiro (por ano)
      const rm = row("dinheiro");
      if (rm) {
        const agg = J.moneyByPeriod(D, "year", null);
        const max = d3.max(agg, p => Math.max(p.in.known + p.in.derived + p.in.estimated, p.out.known + p.out.derived + p.out.estimated)) || 1;
        const mid = rm.y + rm.h / 2;
        agg.forEach(p => {
          const a = x(new Date(p.key + "-01-01")), b = x(new Date(p.key + "-12-31")), w = Math.max(2, (b - a) / 2 - 2);
          const hIn = (rm.h / 2 - 1) * (p.in.known + p.in.derived) / max, hInE = (rm.h / 2 - 1) * p.in.estimated / max;
          const hOut = (rm.h / 2 - 1) * (p.out.known + p.out.derived) / max, hOutE = (rm.h / 2 - 1) * p.out.estimated / max;
          plot.append("rect").attr("x", a + 1).attr("y", mid - hIn).attr("width", w).attr("height", hIn).attr("fill", css("--in"));
          plot.append("rect").attr("x", a + 1).attr("y", mid - hIn - hInE).attr("width", w).attr("height", hInE).attr("fill", "url(#hatch-grey)").attr("stroke", css("--in"));
          plot.append("rect").attr("x", a + w + 3).attr("y", mid).attr("width", w).attr("height", hOut).attr("fill", css("--out"));
          plot.append("rect").attr("x", a + w + 3).attr("y", mid + hOut).attr("width", w).attr("height", hOutE).attr("fill", "url(#hatch-grey)").attr("stroke", css("--out"));
          if (!hIn && !hOut && !hInE && !hOutE) plot.append("rect").attr("x", a + 1).attr("y", mid - 5).attr("width", b - a - 2).attr("height", 10).attr("fill", "none").attr("stroke", css("--miss")).attr("stroke-dasharray", "2 2");
          plot.append("rect").attr("x", a).attr("y", rm.y).attr("width", b - a).attr("height", rm.h).attr("fill", "transparent")
            .on("mousemove", e => J.tip(e, `<b>Dinheiro ${p.key}</b><div class="row"><span>Entrou</span><span>${J.eur(p.in.known + p.in.derived)}${p.in.estimated ? " + ~" + J.eur(p.in.estimated) : ""}</span></div><div class="row"><span>Saiu</span><span>${J.eur(p.out.known + p.out.derived)}${p.out.estimated ? " + ~" + J.eur(p.out.estimated) : ""}</span></div>${p.in.unknown_n + p.out.unknown_n ? `<div>${p.in.unknown_n + p.out.unknown_n} movimentos sem valor</div>` : ""}${!hIn && !hOut ? "<div>Sem nenhum valor conhecido neste ano.</div>" : ""}`))
            .on("mouseleave", J.hideTip);
        });
        plot.append("line").attr("class", "tl-grid").attr("x1", L).attr("x2", W - R).attr("y1", mid).attr("y2", mid);
      }
      // pedidos LADA
      const rp = row("pedidos");
      if (rp) (D.alertas.pedidos || []).forEach(p => plot.append("circle").attr("cx", x(new Date(p.data_envio))).attr("cy", rp.y + 6).attr("r", 4)
        .attr("fill", p.resultado === "respondido" ? css("--ok") : css("--miss"))
        .on("mousemove", e => J.tip(e, `<b>Pedido de documentos (LADA) ${J.date(p.data_envio)}</b><br>${J.esc((p.documentos || "").slice(0, 160))}<br>Prazo: ${J.date(p.prazo)} · ${J.esc(p.resultado || "à espera")}`)).on("mouseleave", J.hideTip));
      // transferências para freguesias (vista da Câmara)
      const rt = row("transf");
      if (rt) (D.dinheiro.instrumentos || []).filter(i => i.lado === "camara").forEach(i => plot.append("rect")
        .attr("x", x(new Date(`${i.ano || 2000}-06-15`)) - 3).attr("y", rt.y).attr("width", 6).attr("height", rt.h).attr("fill", css("--in"))
        .on("mousemove", e => J.tip(e, `<b>${J.esc(i.freguesia)}</b><br>${J.esc(i.tipo)} · ${J.esc(i.tarefa || "")}<br>${J.eur(i.valor_cent)} · ${i.ano}`)).on("mouseleave", J.hideTip));
    }
    draw();

    // zoom (roda) e intervalo (arrastar no eixo)
    const zoom = d3.zoom().scaleExtent([1, 60]).translateExtent([[L, 0], [W - R, H]]).extent([[L, 0], [W - R, H]])
      .filter(e => e.type === "wheel" ? !e.shiftKey : e.type === "dblclick")
      .on("zoom", e => { state.zoom = e.transform; x = e.transform.rescaleX(x0); draw(); });
    svg.call(zoom).on("dblclick.zoom", () => { state.zoom = null; svg.call(zoom.transform, d3.zoomIdentity); });
    if (state.zoom) svg.call(zoom.transform, state.zoom);
    const brush = d3.brushX().extent([[L, H - 30], [W - R, H - 2]]).on("end", e => {
      if (!e.selection || !e.sourceEvent) return;
      const [a, b] = e.selection.map(v => x.invert(v).toISOString().slice(0, 10));
      if (a !== b) J.setQ({ sel: `r:${a}..${b}` });
    });
    svg.append("g").attr("class", "tl-brush").call(brush);

    // controlos
    J.$("#tl-help", el).addEventListener("click", () => { state.help = !state.help; T.render(el, D, S); });
    if (J.$("#tl-full", el)) J.$("#tl-full", el).addEventListener("click", () => {
      state.full = !state.full; state.zoom = null;
      try { localStorage.setItem("jc-tl-full", state.full ? "1" : "0"); } catch (e) { /* ignora */ }
      T.render(el, D, S);
    });
    if (compact) { box.addEventListener("keydown", keys); return; }
    J.$("#tl-q", el).addEventListener("input", e => { state.q = e.target.value; clearTimeout(T._t); T._t = setTimeout(() => T.render(el, D, S), 250); });
    J.$("#tl-status", el).addEventListener("change", e => { state.status = e.target.value; T.render(el, D, S); });
    J.$("#tl-chips", el).addEventListener("click", e => { const g = e.target.closest(".chip"); if (!g) return; state.off.has(g.dataset.g) ? state.off.delete(g.dataset.g) : state.off.add(g.dataset.g); T.render(el, D, S); });
    box.addEventListener("keydown", keys);
    function keys(e) {
      const yy = S.kind === "a" ? S.year : J.year(S.to) || new Date().getFullYear();
      if (e.key === "ArrowLeft") J.setQ({ sel: "a:" + (yy - 1) });
      if (e.key === "ArrowRight") J.setQ({ sel: "a:" + Math.min(new Date().getFullYear(), yy + 1) });
      if (e.key === "Enter" && S.kind === "a") J.setQ({ tab: "documentos" });
    }
  };

  /* Faixa da linha do tempo (estilo Fotos / Bolsa do iOS): uma barra por ano ou por mandato, altura = pontuação.
     Desliza para o lado para ver mandatos antigos; tocar numa barra escolhe-a. */
  // anos de um mandato: o ano pertence ao mandato que governava a meio do ano
  T.yearsOf = (D, m) => {
    const out = [], yNow = new Date().getFullYear();
    for (let y = +m.inicio.slice(0, 4); y <= Math.min(yNow, +(m.fim || J.today).slice(0, 4)); y++) { const at = J.mandateAt(D, `${y}-06-30`); if (at && at.id === m.id) out.push(y); }
    return out;
  };
  const DIAMOND = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 11 6 6 11 1 6z" fill="currentColor"/></svg>';
  // uma só faixa: todos os anos, agrupados por mandato. Tocar num ano = escolher o ano; tocar no nome do mandato = escolher o mandato.
  T.hero = (el, D, S, opt = {}) => {
    el.innerHTML = `<div class="strip" aria-label="Linha do tempo. Toque numa barra para escolher o ano, ou no fundo do mandato para escolher o mandato."></div>`;
    T.strip(J.$(".strip", el), D, S, opt);
  };
  T.strip = (box, D, S, opt = {}) => {
    const A = D.aut;
    const ms = D.mandatos.filter(m => T.yearsOf(D, m).length);
    const pick = sel => opt.onPick ? opt.onPick(sel) : J.setQ({ sel });
    box.classList.toggle("has-sel", S.kind === "m" || S.kind === "a");
    box.innerHTML = ms.map((m, i) => {
      const mSel = S.kind === "m" && S.m.id === m.id;
      const yIn = S.kind === "a" && J.mandateAt(D, `${S.year}-06-30`) === m;
      const pc = m.lista ? J.partyColor(A, m.lista) : "var(--unread)";   // cor do partido que governava
      const pres = (m.presidente || "").split(" ").filter(Boolean);
      const name = pres.length ? `${pres[0]} ${pres[pres.length - 1]}` : "presidente desconhecido";
      const bars = T.yearsOf(D, m).map(y => {
        const sc = J.scoreOf(D, `${y}-01-01`, `${y}-12-31`), on = S.kind === "a" && S.year === y;
        return `<button type="button" class="sb${on ? " on" : ""}" data-sel="a:${y}" aria-pressed="${on}" aria-label="Ano ${y}, pontuação ${sc == null ? "desconhecida" : sc}"
          style="--h:${sc == null ? 4 : Math.max(4, sc)};--c:${sc == null ? "var(--unread)" : pc}"><span class="sb-n">${sc == null ? "?" : sc}</span><span class="sb-b"></span><span class="sb-y">${y}</span></button>`;
      }).join("");
      const el_ = (m.eleicoes || [])[0];
      return `<div class="sg${mSel ? " msel" : ""}${yIn ? " in-sel" : ""}" style="--pc:${pc}" role="button" tabindex="0" data-sel="m:${m.id}" aria-pressed="${mSel}" aria-label="Escolher o mandato ${m.inicio.slice(0, 4)}–${m.fim && m.fim < J.today ? m.fim.slice(0, 4) : "hoje"}, ${J.esc(m.lista || "partido desconhecido")}, ${J.esc(name)}">
        ${i && el_ ? `<button type="button" class="sg-el" data-el="${m.id}" aria-label="Eleições de ${J.date(el_.data)}">${DIAMOND}</button>` : ""}
        <div class="sg-bars">${bars}</div>
        <span class="sg-lab" aria-hidden="true"><i class="pdot" style="background:${pc}"></i><b>${J.esc(m.lista || "?")}</b></span></div>`;
    }).join("");
    J.$$(".sg", box).forEach(g => g.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.click(); } });
    J.$$("[data-sel]", box).forEach(b => b.onclick = e => {
      e.stopPropagation();   // barra = ano; fundo do grupo = mandato
      b.classList.add("tick");
      if (navigator.vibrate) try { navigator.vibrate(4); } catch (e) { /* sem vibração */ }
      pick(b.dataset.sel);
    });
    J.$$(".sg-el", box).forEach(b => b.onclick = e => { e.stopPropagation(); const m = D.mandatos.find(x => x.id === b.dataset.el); J.sheet(`<h2 class="sheet-t">Eleições</h2>${T.electionHtml(D, m, m.eleicoes[0])}`); });
    // mostrar a escolha ao centro (o mandato inteiro, ou o ano); sem escolha, o mais recente
    const center = () => {
      const t = J.$(".sg.msel", box) || J.$(".sb.on", box) || J.$$(".sg", box).pop();
      if (t) { const a = box.getBoundingClientRect(), r = t.getBoundingClientRect(); box.scrollLeft += r.left - a.left - a.width / 2 + r.width / 2; }
    };
    requestAnimationFrame(center);
    setTimeout(center, 420);   // dentro do painel: centrar de novo quando a animação de abrir acabar
  };
  // resultado de uma eleição (barra de votos + lista)
  T.electionHtml = (D, m, e) => {
    const A = D.aut;
    return `<div class="card"><p class="sub">${J.org(e.orgao)} · ${J.date(e.data)}${e.inscritos && e.votantes ? ` · ${Math.round(100 * e.votantes / e.inscritos)}% votaram (${J.int(e.votantes)} de ${J.int(e.inscritos)})` : ""}</p>
      <div class="elbar">${(e.listas || []).filter(l => l.votos).map(l => `<div title="${J.esc(l.partido || l.lista)}: ${J.int(l.votos)} votos" style="flex:${l.votos};background:${J.partyColor(A, l.partido)}">${J.esc(l.partido || l.lista)}</div>`).join("")}</div>
      <ul class="plain">${(e.listas || []).map(l => `<li>${J.partyTag(A, l.partido)} ${l.votos ? J.int(l.votos) : "?"} votos · ${l.mandatos ?? "?"} lugares</li>`).join("")}</ul>
      <p class="sub">Mandato ${m.inicio.slice(0, 4)}–${m.fim && m.fim < J.today ? m.fim.slice(0, 4) : "hoje"}${m.presidente ? " · Presidente: " + J.esc(m.presidente) : ""}</p></div>`;
  };


  T.card = (D, m) => {
    const A = D.aut;
    const ins = J.moneyTotals(D, { from: m.inicio, to: m.fim || J.today });
    const docs = (D.documentos.documentos || []).filter(d => J.inSel({ from: m.inicio, to: m.fim || J.today }, d.data_doc)).length;
    const flags = (D.alertas.alertas || []).filter(f => J.inSel({ from: m.inicio, to: m.fim || J.today }, f.periodo_inicio, f.periodo_fim)).length;
    const years = Object.entries(A.score || {}).filter(([y]) => y >= m.inicio.slice(0, 4) && y <= (m.fim || J.today).slice(0, 4)).map(([, s]) => s.total || 0);
    const members = (m.membros || []).filter(x => x.orgao !== "assembleia_freguesia" && x.orgao !== "assembleia_municipal").slice(0, 6);
    const seats = ((m.assembleia || {}).listas || []).filter(l => l.mandatos).map(l => `${l.lista} ${l.mandatos}`).join(" · ");
    return `<b>${J.esc(m.nome_unidade || A.nome)}</b><br>${m.inicio.slice(0, 4)}–${(m.fim || "hoje").slice(0, 4)} · ${m.lista || "lista desconhecida"}<br>
      Presidente: ${J.esc(m.presidente || "não identificado nos documentos")}
      ${members.length ? "<br>" + members.map(x => `${J.esc(x.funcao || "")}: ${J.esc(x.nome)}`).join("<br>") : ""}
      ${seats ? `<br>Assembleia: ${J.esc(seats)}` : ""}
      <br>Transparência: ${years.length ? Math.round(d3.mean(years)) + "/100" : "?"}
      <br>Entrou ${J.eur(ins.in.known + ins.in.derived, true)} · saiu ${J.eur(ins.out.known + ins.out.derived, true)}${ins.in.unknown_n + ins.out.unknown_n ? ` · ${ins.in.unknown_n + ins.out.unknown_n} sem valor` : ""}
      <br>${docs} documentos · ${flags} alertas`;
  };

  T.tickCard = (D, c) => {
    const tax = D.aut.taxonomia;
    const lines = c.docs.slice(0, 5).map(d => `• ${J.esc((tax.tipos[d.tipo] || {}).nome || d.tipo)}: ${J.esc((d.titulo || "").slice(0, 70))}${d.leitura === "unreadable" ? " (ilegível)" : ""}${d.link_only ? " (só link)" : ""}`);
    const miss = c.exp.slice(0, 5).map(e => `• <b>Falta</b> ${J.esc((tax.tipos[e.tipo] || {}).nome || e.tipo)} (${J.esc(e.slot)}) — ${J.STATE[e.estado]}`);
    return `<b>${c.lane === "densidade" ? "Documentos" : tax.grupos[c.g].nome} · ${J.date(c.ym)}</b>${c.docs.length ? "" : ` — ${c.exp.length} em falta`}<br>${lines.concat(miss).join("<br>")}${c.docs.length + c.exp.length > 10 ? "<br>…" : ""}`;
  };

  T.openTick = (D, c) => {
    const tax = D.aut.taxonomia;
    J.drawer(`<h2>${c.lane === "densidade" ? "Documentos" : tax.grupos[c.g].nome} — ${J.date(c.ym || String(c.ano))}${c.docs.length ? "" : ": o que falta"}</h2>` +
      c.docs.map(d => `<div class="card" style="margin-bottom:8px"><div class="sub">${J.esc((tax.tipos[d.tipo] || {}).nome || d.tipo)} · ${J.date(d.data_doc)}</div>
        <b>${J.esc(d.titulo)}</b><div class="sub">${d.leitura === "unreadable" ? "Documento ilegível (digitalizado sem texto)" : d.link_only ? "Só temos o link (o site não deixa descarregar)" : ""}</div>
        <a class="btn" href="${J.href(J.base(D) + "/doc/" + d.id)}" onclick="J.drawer(null)">Abrir documento</a></div>`).join("") +
      c.exp.map(e => `<div class="card" style="margin-bottom:8px;border-color:var(--nf)">${J.stateTag(e.estado)}<br><b>${J.esc((tax.tipos[e.tipo] || {}).nome || e.tipo)} — ${J.esc(e.slot)}</b>
        <p class="sub">${J.esc(e.motivo || "")}</p><p class="sub">Devido até: ${e.devido_ate ? J.date(e.devido_ate) : "—"} · Pedido LADA: ${e.pedido_id ? "enviado" : "ainda não enviado"}</p></div>`).join(""));
  };
})();

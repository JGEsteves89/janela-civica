/* Gráficos (D3). Regra: conhecido = cheio; estimado = tracejado diagonal; desconhecido = contorno cinzento com "?";
   ausente = contorno vermelho pontilhado. Cada gráfico tem "ver como tabela", CSV e imagem. */
(function () {
  const J = window.J, d3 = window.d3;
  const ch = (J.ch = {});
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  let uid = 0;

  // anel (como o Fitness do iOS): parte cheia = pontuação; cor pela escala 0–39 / 40–69 / 70–100
  ch.ring = (v, max = 100) => {
    const r = 30, c = 2 * Math.PI * r, f = v == null ? 0 : Math.max(0, Math.min(1, v / max));
    return `<svg class="ring" viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="${r}" fill="none" stroke="var(--fill)" stroke-width="8"/>
      <circle cx="36" cy="36" r="${r}" fill="none" stroke="${v == null ? "var(--unread)" : J.scoreColor(f)}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(f * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 36 36)"/></svg>`;
  };

  ch.defs = (svg, colors) => {
    const defs = svg.append("defs");
    const add = (id, c) => defs.append("pattern").attr("id", id).attr("patternUnits", "userSpaceOnUse").attr("width", 5).attr("height", 5)
      .attr("patternTransform", "rotate(45)").call(p => { p.append("rect").attr("width", 5).attr("height", 5).attr("fill", "none");
        p.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 5).attr("stroke", c).attr("stroke-width", 2.2); });
    const ids = {};
    Object.entries(colors).forEach(([k, c]) => { ids[k] = `h${++uid}`; add(ids[k], c); });
    return ids;
  };

  /* Moldura: título acessível, alternar tabela, CSV e PNG */
  ch.frame = (el, name, rows, summary) => {
    el.classList.add("chart");
    el.setAttribute("role", "figure");
    if (summary) el.setAttribute("aria-label", summary);
    // redesenhar não pode duplicar a barra
    while (el.nextElementSibling && (el.nextElementSibling.classList.contains("chartbar") || el.nextElementSibling.classList.contains("charttbl"))) el.nextElementSibling.remove();
    el.hidden = false;
    const bar = document.createElement("details");
    bar.className = "chartbar more";
    bar.innerHTML = `<summary class="btn" aria-label="Opções do gráfico">⋯</summary><div class="menu"><button data-a="t">Ver como tabela</button><button data-a="c">Descarregar CSV</button>${el.querySelector("svg") ? `<button data-a="p">Descarregar imagem</button>` : ""}</div>`;
    el.after(bar);
    let tbl;
    bar.onclick = e => {
      const a = e.target.dataset.a;
      if (a) bar.open = false;
      if (a === "c") J.csv(name, rows);
      if (a === "p") ch.png(el, name);
      if (a === "t") {
        if (tbl) { tbl.remove(); tbl = null; el.hidden = false; e.target.textContent = "Ver como tabela"; return; }
        tbl = document.createElement("div"); tbl.className = "tablewrap charttbl";
        const cols = rows.length ? Object.keys(rows[0]) : [];
        tbl.innerHTML = `<table><tr>${cols.map(c => `<th>${J.esc(c)}</th>`).join("")}</tr>${rows.map(r => `<tr>${cols.map(c => `<td>${J.esc(r[c])}</td>`).join("")}</tr>`).join("")}</table>`;
        bar.after(tbl); el.hidden = true; e.target.textContent = "Ver gráfico";
      }
    };
  };
  ch.png = (el, name) => {
    const svg = el.querySelector("svg");
    if (!svg) return;
    const clone = svg.cloneNode(true);
    const st = document.createElement("style");
    st.textContent = `text{font:11px system-ui;fill:${css("--muted")}}`;
    clone.prepend(st);
    const w = svg.viewBox.baseVal.width || svg.clientWidth, h = (svg.viewBox.baseVal.height || svg.clientHeight) + 24;
    clone.setAttribute("height", h);
    const foot = document.createElementNS("http://www.w3.org/2000/svg", "text");
    foot.setAttribute("x", 4); foot.setAttribute("y", h - 6);
    foot.textContent = `Fonte: Janela Cívica (documentos públicos) — ${location.href}`;
    clone.appendChild(foot);
    const data = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = w * 2; c.height = h * 2;
      const x = c.getContext("2d"); x.fillStyle = css("--card"); x.fillRect(0, 0, c.width, c.height); x.scale(2, 2); x.drawImage(img, 0, 0, w, h);
      const a = document.createElement("a"); a.download = name + ".png"; a.href = c.toDataURL("image/png"); a.click();
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data);
  };

  /* Barras horizontais ordenadas. items: {label, known, est, unk, href, stack:[{k, v, color}]} */
  ch.bars = (el, items, opt = {}) => {
    el.innerHTML = "";
    if (!items.length) { el.innerHTML = `<div class="empty">${opt.empty || "Sem dados nesta seleção."}</div>`; return; }
    // ecrã estreito: o nome fica numa linha por cima da barra (nunca cortado ao meio)
    const W = Math.max(280, el.clientWidth || 600), narrow = W < 520, rowH = narrow ? 42 : 28, labW = narrow ? 0 : Math.min(240, W * 0.38), valW = narrow ? 0 : 110, H = items.length * rowH + 4;
    const max = d3.max(items, d => (d.known || 0) + (d.est || 0) + d3.sum(d.stack || [], s => s.v)) || 1;
    const x = d3.scaleLinear().domain([0, max]).range([0, W - labW - valW]);
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
    const col = opt.color || css("--in");
    const hid = ch.defs(svg, { c: col });
    const g = svg.selectAll("g").data(items).join("g").attr("transform", (d, i) => `translate(0,${i * rowH})`).style("cursor", d => d.href ? "pointer" : "default")
      .on("click", (e, d) => d.href && (location.hash = d.href))
      .on("mousemove", (e, d) => J.tip(e, `<b>${J.esc(d.label)}</b><br>${d.known ? "conhecido " + J.eur(d.known) : ""}${d.est ? "<br>estimado ~" + J.eur(d.est) : ""}${d.unk ? `<br>${d.unk} sem valor` : ""}${(d.stack || []).map(s => `<br>${J.esc(s.k)}: ${J.eur(s.v)}`).join("")}`))
      .on("mouseleave", J.hideTip);
    const maxCh = narrow ? (W - 90) / 7.2 : labW / 7;
    g.append("text").attr("class", "lab").attr("x", 0).attr("y", narrow ? 14 : rowH / 2 + 4).text(d => d.label.length > maxCh ? d.label.slice(0, maxCh - 1) + "…" : d.label);
    const by = narrow ? 20 : 6, bh = narrow ? 14 : rowH - 12;
    g.each(function (d) {
      const gg = d3.select(this); let x0 = labW;
      (d.stack || [{ v: d.known || 0, color: col }]).forEach(s => { gg.append("rect").attr("x", x0).attr("y", by).attr("height", bh).attr("width", Math.max(0, x(s.v))).attr("fill", s.color || col).attr("rx", 2); x0 += x(s.v); });
      if (d.est) { gg.append("rect").attr("x", x0).attr("y", by).attr("height", bh).attr("width", x(d.est)).attr("fill", `url(#${hid.c})`).attr("stroke", col); x0 += x(d.est); }
      if (d.unk) gg.append("text").attr("x", x0 + 4).attr("y", by + bh - 2).attr("class", "val").text(`+${d.unk} ?`);
      gg.append("text").attr("class", "val").attr("x", W).attr("text-anchor", "end").attr("y", narrow ? 14 : rowH / 2 + 4)
        .text(J.eur(((d.known || 0) + d3.sum(d.stack || [], s => s.v)) || 0, true) + (d.est ? " + ~" + J.eur(d.est, true) : ""));
    });
    ch.frame(el, opt.name || "dados", items.map(d => ({ nome: d.label, conhecido_eur: ((d.known || 0) + d3.sum(d.stack || [], s => s.v)) / 100, estimado_eur: (d.est || 0) / 100, sem_valor: d.unk || 0 })),
      opt.summary || `Gráfico de barras com ${items.length} linhas. Maior: ${items[0].label}.`);
  };

  /* Entradas vs saídas por período. periods: [{key, label, in:{known,derived,estimated,unknown_n}, out:{...}, expected:bool}] */
  ch.periods = (el, periods, opt = {}) => {
    el.innerHTML = "";
    if (!periods.length) { el.innerHTML = `<div class="empty">Sem dados de dinheiro nesta seleção.</div>`; return; }
    const W = Math.max(320, el.clientWidth || 700), H = 240, m = { t: 10, r: 8, b: 36, l: 56 };
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
    const cin = css("--in"), cout = css("--out"), grey = css("--unread"), red = css("--miss");
    const hid = ch.defs(svg, { in: cin, out: cout });
    const tot = s => (s.known || 0) + (s.derived || 0) + (s.estimated || 0);
    const max = d3.max(periods, p => Math.max(tot(p.in || {}), tot(p.out || {}))) || 1;
    const x = d3.scaleBand().domain(periods.map(p => p.key)).range([m.l, W - m.r]).padding(0.2);
    const xi = d3.scaleBand().domain(["in", "out"]).range([0, x.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear().domain([0, max]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("class", "ax").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(v => J.eur(v, true)));
    const every = Math.ceil(periods.length / Math.max(1, Math.floor((W - m.l) / 48)));
    svg.append("g").attr("class", "ax").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((k, i) => i % every ? "" : (periods[i].label || k)));
    periods.forEach(p => {
      ["in", "out"].forEach(dir => {
        const s = p[dir] || {}, x0 = x(p.key) + xi(dir), w = xi.bandwidth(), c = dir === "in" ? cin : cout;
        let y0 = y(0);
        const seg = (v, fill, stroke) => { if (!v) return; const h = y(0) - y(v); svg.append("rect").attr("x", x0).attr("y", y0 - h).attr("width", w).attr("height", h).attr("fill", fill).attr("stroke", stroke || "none"); y0 -= h; };
        seg((s.known || 0) + (s.derived || 0), c);
        seg(s.estimated || 0, `url(#${hid[dir]})`, c);
        if (s.unknown_n) svg.append("text").attr("x", x0 + w / 2).attr("y", y0 - 3).attr("text-anchor", "middle").attr("class", "val").attr("fill", grey).text("?");
        if (!tot(s) && !s.unknown_n && p.expected) svg.append("rect").attr("x", x0).attr("y", y(0) - 18).attr("width", w).attr("height", 18).attr("fill", "none").attr("stroke", red).attr("stroke-dasharray", "2 2");
      });
      svg.append("rect").attr("x", x(p.key)).attr("y", m.t).attr("width", x.bandwidth()).attr("height", H - m.b - m.t).attr("fill", "transparent")
        .on("mousemove", e => J.tip(e, `<b>${J.esc(p.label || p.key)}</b>` + ["in", "out"].map(dir => { const s = p[dir] || {};
          return `<div class="row"><span>${dir === "in" ? "Entrou" : "Saiu"}</span><span>${J.eur((s.known || 0) + (s.derived || 0))}${s.estimated ? " + ~" + J.eur(s.estimated) + " est." : ""}${s.unknown_n ? ` · ${s.unknown_n} sem valor` : ""}</span></div>`; }).join("")
          + (opt.method ? `<div class="muted">${J.esc(opt.method)}</div>` : "")))
        .on("mouseleave", J.hideTip);
    });
    ch.frame(el, opt.name || "entradas_saidas", periods.map(p => ({ periodo: p.label || p.key,
      entrou_conhecido: ((p.in || {}).known || 0) / 100, entrou_calculado: ((p.in || {}).derived || 0) / 100, entrou_estimado: ((p.in || {}).estimated || 0) / 100, entrou_sem_valor: (p.in || {}).unknown_n || 0,
      saiu_conhecido: ((p.out || {}).known || 0) / 100, saiu_calculado: ((p.out || {}).derived || 0) / 100, saiu_estimado: ((p.out || {}).estimated || 0) / 100, saiu_sem_valor: (p.out || {}).unknown_n || 0 })),
      `Entradas e saídas em ${periods.length} períodos.`);
  };

  /* Bullet: previsto (fino) vs executado (grosso); cinzento = sem conta */
  ch.bullet = (el, items, opt = {}) => {
    el.innerHTML = "";
    if (!items.length) { el.innerHTML = `<div class="empty">${opt.empty || "Sem orçamento e contas para comparar nesta seleção."}</div>`; return; }
    const W = Math.max(280, el.clientWidth || 600), narrow = W < 520, rowH = narrow ? 44 : 30, labW = narrow ? 0 : Math.min(220, W * 0.36), valW = narrow ? 0 : 120, H = items.length * rowH;
    const max = d3.max(items, d => Math.max(d.planned || 0, d.executed || 0)) || 1;
    const x = d3.scaleLinear().domain([0, max]).range([0, W - labW - valW]);
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
    const g = svg.selectAll("g").data(items).join("g").attr("transform", (d, i) => `translate(0,${i * rowH})`)
      .on("mousemove", (e, d) => J.tip(e, `<b>${J.esc(d.label)}</b><br>Previsto: ${J.eur(d.planned)}<br>Executado: ${d.executed == null ? "sem conta publicada" : J.eur(d.executed)}`)).on("mouseleave", J.hideTip);
    const ty = narrow ? 14 : rowH / 2 + 4, by = narrow ? 20 : 7, bh = narrow ? 16 : rowH - 14;
    g.append("text").attr("class", "lab").attr("y", ty).text(d => d.label.slice(0, narrow ? (W - 120) / 7 : labW / 7));
    g.append("rect").attr("x", labW).attr("y", by + bh / 2 - 2).attr("height", 4).attr("width", d => x(d.planned || 0)).attr("fill", css("--muted"));
    g.append("rect").attr("x", labW).attr("y", by).attr("height", bh).attr("width", d => x(d.executed || 0)).attr("fill", d => d.executed == null ? "none" : css("--out"))
      .attr("stroke", d => d.executed == null ? css("--unread") : "none").attr("opacity", .85);
    g.append("text").attr("class", "val").attr("x", W).attr("text-anchor", "end").attr("y", ty)
      .text(d => d.executed == null ? `${J.eur(d.planned, true)} / ?` : `${J.eur(d.executed, true)} de ${J.eur(d.planned, true)}`);
    ch.frame(el, opt.name || "previsto_executado", items.map(d => ({ linha: d.label, previsto_eur: (d.planned || 0) / 100, executado_eur: d.executed == null ? "" : d.executed / 100 })),
      "Previsto contra executado.");
  };

  /* Sankey: origens → autarquia → destinos */
  ch.sankey = (el, links, opt = {}) => {
    el.innerHTML = "";
    if (!links.length || !d3.sankey) { el.innerHTML = `<div class="empty">Sem fluxos de dinheiro com origem e destino nesta seleção.</div>`; return; }
    const W = Math.max(300, el.clientWidth || 700), H = Math.max(240, links.length * 34);
    const names = [...new Set(links.flatMap(l => [l.source, l.target]))];
    const graph = d3.sankey().nodeId(d => d.name).nodeWidth(10).nodePadding(16).extent([[4, 24], [W - 4, H - 6]])
      ({ nodes: names.map(n => ({ name: n })), links: links.map(l => Object.assign({}, l)) });
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
    const hid = ch.defs(svg, { in: css("--in"), out: css("--out") });
    svg.append("g").selectAll("path").data(graph.links).join("path").attr("d", d3.sankeyLinkHorizontal())
      .attr("fill", "none").attr("stroke-width", d => Math.max(1.5, d.width))
      .attr("stroke", d => d.level === "unknown" ? css("--unread") : d.level === "estimated" ? `url(#${hid[d.dir]})` : (d.dir === "in" ? css("--in") : css("--out")))
      .attr("stroke-opacity", d => d.level === "unknown" ? .35 : .55)
      .on("mousemove", (e, d) => J.tip(e, `<b>${J.esc(d.source.name)} → ${J.esc(d.target.name)}</b><br>${J.eur(d.real)} ${J.LEVEL[d.level] || ""}`)).on("mouseleave", J.hideTip);
    const n = svg.append("g").selectAll("g").data(graph.nodes).join("g");
    n.append("rect").attr("x", d => d.x0).attr("y", d => d.y0).attr("height", d => Math.max(1, d.y1 - d.y0)).attr("width", d => d.x1 - d.x0).attr("fill", css("--text"));
    // rótulos: à esquerda das colunas da direita, à direita da coluna da esquerda; a coluna do meio leva o nome por cima
    const maxD = d3.max(graph.nodes, d => d.depth);
    const lab = n.append("text").attr("class", "lab");
    const big = d => d.y1 - d.y0 >= 30;
    lab.filter(d => (d.depth === 0 || d.depth === maxD) && !big(d)).attr("x", d => d.depth === 0 ? d.x1 + 6 : d.x0 - 6).attr("y", d => (d.y0 + d.y1) / 2 + 4)
      .attr("text-anchor", d => d.depth === 0 ? "start" : "end").attr("class", "lab small").text(d => `${d.name.trim()} · ${J.eur(d.value, true)}`);
    lab.filter(d => (d.depth === 0 || d.depth === maxD) && big(d)).attr("x", d => d.depth === 0 ? d.x1 + 6 : d.x0 - 6).attr("y", d => (d.y0 + d.y1) / 2 - 2)
      .attr("text-anchor", d => d.depth === 0 ? "start" : "end")
      .call(t => { t.append("tspan").text(d => d.name.trim()); t.append("tspan").attr("class", "val").attr("x", function (d) { return d.depth === 0 ? d.x1 + 6 : d.x0 - 6; }).attr("dy", 14).text(d => J.eur(d.value, true)); });
    lab.filter(d => d.depth > 0 && d.depth < maxD).attr("class", "lab mid").attr("x", d => (d.x0 + d.x1) / 2).attr("y", d => d.y0 - 8).attr("text-anchor", "middle").text(d => d.name);
    ch.frame(el, opt.name || "fluxo_dinheiro", links.map(l => ({ de: l.source, para: l.target, eur: l.real / 100, nivel: J.LEVEL[l.level] || l.level })),
      `Fluxo do dinheiro com ${names.length} pontos.`);
  };

  /* Treemap com descida por níveis. tree: {name, children:[...], value, level} */
  ch.treemap = (el, tree, opt = {}) => {
    el.innerHTML = "";
    const stack = [tree];
    const draw = () => {
      el.innerHTML = "";
      const node = stack[stack.length - 1];
      const crumbs = document.createElement("div"); crumbs.className = "sub";
      crumbs.innerHTML = stack.map((s, i) => i === stack.length - 1 ? `<b>${J.esc(s.name)}</b>` : `<a href="javascript:void 0" data-i="${i}">${J.esc(s.name)}</a>`).join(" › ");
      crumbs.onclick = e => { if (e.target.dataset.i != null) { stack.length = +e.target.dataset.i + 1; draw(); } };
      el.appendChild(crumbs);
      if (!node.children || !node.children.length) { el.insertAdjacentHTML("beforeend", `<div class="empty">Sem detalhe.</div>`); return; }
      const W = Math.max(300, el.clientWidth || 600), H = Math.min(420, Math.max(220, W * 0.5));
      const root = d3.hierarchy(node).sum(d => d.children ? 0 : Math.max(0, d.value || 0)).sort((a, b) => b.value - a.value);
      d3.treemap().size([W, H]).paddingInner(2).round(true)(root);
      const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
      const color = d3.scaleOrdinal(d3.schemeTableau10);
      const hid = ch.defs(svg, { e: css("--out") });
      const leaves = svg.selectAll("g").data(root.children || []).join("g").attr("transform", d => `translate(${d.x0},${d.y0})`)
        .style("cursor", d => d.data.children ? "pointer" : "default")
        .on("click", (e, d) => { if (d.data.children) { stack.push(d.data); draw(); } else if (d.data.href) location.hash = d.data.href; })
        .on("mousemove", (e, d) => J.tip(e, `<b>${J.esc(d.data.name)}</b><br>${J.eur(d.value)} (${(d.value / root.value * 100).toFixed(1)}%)${d.data.level && d.data.level !== "known" ? "<br>" + J.LEVEL[d.data.level] : ""}`))
        .on("mouseleave", J.hideTip);
      leaves.append("rect").attr("width", d => d.x1 - d.x0).attr("height", d => d.y1 - d.y0)
        .attr("fill", (d, i) => d.data.level === "estimated" ? `url(#${hid.e})` : d.data.level === "unknown" ? "none" : color(i))
        .attr("stroke", d => d.data.level === "unknown" ? css("--unread") : "none").attr("opacity", .9);
      leaves.append("text").attr("x", 5).attr("y", 15).attr("fill", "#fff").style("font-size", "12px").style("font-weight", 600)
        .text(d => (d.x1 - d.x0) > 60 && (d.y1 - d.y0) > 18 ? d.data.name.slice(0, (d.x1 - d.x0) / 7) : "");
      leaves.append("text").attr("x", 5).attr("y", 29).attr("fill", "#fff").style("font-size", "12px")
        .text(d => (d.x1 - d.x0) > 60 && (d.y1 - d.y0) > 32 ? `${J.eur(d.value, true)} · ${(d.value / root.value * 100).toFixed(0)}%` : "");
    };
    draw();
    const flat = []; const walk = (n, p) => (n.children || []).forEach(c => { if (c.children) walk(c, p.concat(c.name)); else flat.push({ caminho: p.concat(c.name).join(" › "), eur: (c.value || 0) / 100 }); });
    walk(tree, []);
    ch.frame(el, opt.name || "mapa", flat, "Mapa de blocos com as despesas.");
  };

  /* Donut por origem */
  ch.donut = (el, items, opt = {}) => {
    el.innerHTML = "";
    const tot = d3.sum(items, d => d.v);
    if (!tot) { el.innerHTML = `<div class="empty">Sem valores.</div>`; return; }
    const W = Math.min(el.clientWidth || 300, 320), R = W / 2;
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${W}`).append("g").attr("transform", `translate(${R},${R})`);
    const color = d3.scaleOrdinal(d3.schemeTableau10);
    const arcs = d3.pie().value(d => d.v).sort(null)(items);
    svg.selectAll("path").data(arcs).join("path").attr("d", d3.arc().innerRadius(R * .58).outerRadius(R - 2))
      .attr("fill", (d, i) => d.data.k === "Desconhecido" ? "none" : color(i)).attr("stroke", d => d.data.k === "Desconhecido" ? css("--unread") : css("--card"))
      .on("mousemove", (e, d) => J.tip(e, `<b>${J.esc(d.data.k)}</b><br>${J.eur(d.data.v)} (${(d.data.v / tot * 100).toFixed(0)}%)`)).on("mouseleave", J.hideTip);
    svg.append("text").attr("text-anchor", "middle").attr("dy", 4).attr("class", "lab").text(J.eur(tot, true));
    const lg = document.createElement("div"); lg.className = "legend";
    lg.innerHTML = items.map((d, i) => `<span><i style="background:${d.k === "Desconhecido" ? "transparent;border:1px solid " + css("--unread") : color(i)}"></i>${J.esc(d.k)} ${(d.v / tot * 100).toFixed(0)}%</span>`).join("");
    el.appendChild(lg);
    ch.frame(el, opt.name || "origem", items.map(d => ({ origem: d.k, eur: d.v / 100 })), "Origem do dinheiro.");
  };

  /* Mapa de calor: linhas × colunas */
  ch.heat = (el, rows, cols, cell, opt = {}) => {
    el.innerHTML = "";
    if (!rows.length || !cols.length) { el.innerHTML = `<div class="empty">${opt.empty || "Sem dados."}</div>`; return; }
    const narrow = J.mobile(), cw = narrow ? 20 : 16, rh = narrow ? 26 : 20, labW = narrow ? 118 : 170, W = labW + cols.length * cw + 10, H = rows.length * rh + 40;
    const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).style("max-width", "none");
    el.style.overflowX = "auto";
    rows.forEach((r, i) => {
      const nm = r.label.split(" ").filter(Boolean), short = narrow && nm.length > 1 ? `${nm[0]} ${nm[nm.length - 1]}` : r.label;
      svg.append("text").attr("class", "lab").attr("x", 0).attr("y", 40 + i * rh + rh / 2 + 4).text(short.slice(0, narrow ? 16 : 26));
      cols.forEach((c, j) => {
        const v = cell(r, c);
        const fill = { presente: css("--ok"), ausente: css("--miss"), justificada: css("--nf"), favor: css("--ok"), contra: css("--miss"), abstencao: css("--nf") }[v];
        svg.append("rect").attr("x", labW + j * cw).attr("y", 40 + i * rh + 2).attr("width", cw - 3).attr("height", rh - 4).attr("rx", 2)
          .attr("fill", fill || "none").attr("stroke", fill ? "none" : css("--line"))
          .on("mousemove", e => J.tip(e, `<b>${J.esc(r.label)}</b><br>${J.esc(c.label)}: ${v || "sem registo"}`)).on("mouseleave", J.hideTip)
          .on("click", () => c.href && (location.hash = c.href)).style("cursor", c.href ? "pointer" : "default");
      });
    });
    cols.forEach((c, j) => { if (j % 3 === 0) svg.append("text").attr("class", "val").attr("transform", `translate(${labW + j * cw + 8},34) rotate(-50)`).text(c.short || ""); });
    const data = rows.map(r => Object.assign({ nome: r.label }, Object.fromEntries(cols.map(c => [c.label, cell(r, c) || ""]))));
    ch.frame(el, opt.name || "matriz", data, opt.summary || "Matriz.");
  };

  /* Pequenos múltiplos: uma linha por entidade ao longo dos anos */
  ch.multiples = (el, series, years, opt = {}) => {
    el.innerHTML = "";
    if (!series.length) { el.innerHTML = `<div class="empty">Sem dados.</div>`; return; }
    const box = document.createElement("div"); box.className = "grid g4"; el.appendChild(box);
    series.forEach(s => {
      const c = document.createElement("div"); c.className = "card"; box.appendChild(c);
      c.innerHTML = `<div class="sub" style="margin-bottom:4px"><a href="${s.href || "#"}">${J.esc(s.label)}</a></div>`;
      const W = 200, H = 60, max = d3.max(s.points, p => p.v) || 1;
      const x = d3.scalePoint().domain(years).range([4, W - 4]), y = d3.scaleLinear().domain([0, max]).range([H - 4, 4]);
      const svg = d3.select(c).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
      svg.append("path").attr("fill", "none").attr("stroke", css("--in")).attr("stroke-width", 2)
        .attr("d", d3.line().x(p => x(p.y)).y(p => y(p.v || 0))(years.map(yy => ({ y: yy, v: (s.points.find(p => p.y === yy) || {}).v || 0 }))));
      svg.selectAll("circle").data(years).join("circle").attr("cx", yy => x(yy)).attr("cy", yy => y((s.points.find(p => p.y === yy) || {}).v || 0)).attr("r", 2.5)
        .attr("fill", yy => (s.points.find(p => p.y === yy) || {}).v ? css("--in") : css("--miss"))
        .on("mousemove", (e, yy) => J.tip(e, `${yy}: ${J.eur((s.points.find(p => p.y === yy) || {}).v || 0)}`)).on("mouseleave", J.hideTip);
      c.insertAdjacentHTML("beforeend", `<div class="sub">${years[0]}–${years[years.length - 1]} · total ${J.eur(d3.sum(s.points, p => p.v), true)}</div>`);
    });
    ch.frame(el, opt.name || "evolucao", series.flatMap(s => s.points.map(p => ({ entidade: s.label, ano: p.y, eur: p.v / 100 }))), "Evolução por entidade.");
  };
})();

/* Janela Cívica — núcleo: estado no URL, dados, utilitários. */
(function () {
  const J = (window.J = {});
  J.cache = {};
  J.state = {};

  // ---------- utilitários ----------
  J.esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  J.$ = (sel, root) => (root || document).querySelector(sel);
  J.$$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  J.html = (el, s) => { el.innerHTML = s; return el; };
  // milhares sempre com espaço (o pt-PT não separa números de 4 algarismos: 1890 → "1 890")
  J.int = v => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  J.eur = (c, short) => {
    if (c == null) return "?";
    const v = c / 100;
    if (short) {
      const a = Math.abs(v);
      if (a >= 1e6) return "€ " + (v / 1e6).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " M";
      if (a >= 1e3) return "€ " + J.int(v / 1e3) + " k";
    }
    return "€ " + (v < 0 ? "−" : "") + J.int(Math.abs(v));
  };
  J.eur2 = c => c == null ? "?" : "€ " + (c / 100).toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  J.date = s => { if (!s) return "sem data"; const [y, m, d] = s.slice(0, 10).split("-"); return d ? `${+d} ${MES[+m - 1]} ${y}` : (m ? `${MES[+m - 1]} ${y}` : y); };
  J.year = s => s ? +s.slice(0, 4) : null;
  J.today = new Date().toISOString().slice(0, 10);
  J.pct = v => (v == null ? "?" : Math.round(v * 100) + "%");

  // estados dos documentos
  J.STATE = {
    present: "Publicado", late: "Publicado com atraso", present_unreadable: "Publicado, mas ilegível",
    present_no_numbers: "Publicado, sem números", not_found_yet: "Não encontrado (sem pedido formal ainda)",
    missing: "Em falta (confirmado)", not_applicable: "Não se aplica"
  };
  J.stateTag = s => `<span class="state s-${s}"><i></i>${J.STATE[s] || s}</span>`;
  J.LEVEL = { known: "conhecido", derived: "calculado", estimated: "estimado", unknown: "desconhecido", absent: "sem informação" };
  J.levelBadge = l => l === "known" ? "" : `<span class="badge ${l === "estimated" ? "est" : "unk"}">${l === "estimated" ? "est." : l === "derived" ? "calc." : "?"}</span>`;
  // nomes dos órgãos e das dimensões da pontuação (nunca mostrar chaves internas)
  J.ORG = { junta: "Junta de Freguesia", assembleia_freguesia: "Assembleia de Freguesia", camara: "Câmara Municipal",
    assembleia_municipal: "Assembleia Municipal", publica: "Sessão pública" };
  J.org = k => J.ORG[k] || (k ? String(k).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : "Órgão desconhecido");
  J.DIM = { contas: "Contas", planeamento: "Planeamento", reunioes: "Reuniões", dinheiro: "Dinheiro", pessoas: "Pessoas", regras: "Regras", acesso: "Acesso" };
  // escala única da pontuação: 0–39 vermelho, 40–69 âmbar, 70–100 verde
  // gradiente coral (0) → âmbar → menta (100)
  J.scoreColor = f => { f = Math.max(0, Math.min(1, +f || 0)); const ip = window.d3 && d3.interpolateRgb;
    if (!ip) return f < 0.4 ? "#FF6B5A" : f < 0.7 ? "#FFB020" : "#00C7BE";
    return f < .5 ? ip("#FF6B5A", "#FFB020")(f * 2) : ip("#FFB020", "#00C7BE")((f - .5) * 2); };
  J.SEV = { 3: "Precisa de explicação", 2: "Atenção", 1: "Informação" };
  // MAIÚSCULAS → frase normal
  J.sc = t => { t = String(t || ""); const L = t.replace(/[^A-Za-zÀ-ÿ]/g, ""); return L && L.replace(/[^A-ZÀ-Þ]/g, "").length / L.length > 0.7 ? t.charAt(0) + t.slice(1).toLowerCase() : t; };
  // nome curto de uma unidade (freguesia antiga, união, freguesia nova), com os anos
  J.unitName = (D, u) => {
    const h = ((D.aut || {}).historia || []).find(x => x.id === u);
    if (!h) return u ? J.esc(u) : "";
    const n = h.nome.replace("União das Freguesias de ", "União de ");
    return J.esc(`${n} (${h.de ? String(h.de).slice(0, 4) : "…"}–${h.ate ? String(h.ate).slice(0, 4) : "hoje"})`);
  };
  J.unitShort = (D, u) => { const h = ((D.aut || {}).historia || []).find(x => x.id === u); return h ? h.nome.replace(/^(Freguesia|Município|União das Freguesias) de /, "") : (u || ""); };
  // nomes curtos das regras (o código fica na dica)
  J.RULE = { F00: "Documento retirado do site", F01: "Documento importante em falta", F02: "Documento em falta", F03: "Publicado mas ilegível ou sem números",
    F04: "Publicado fora do prazo", F05: "Executado longe do previsto", F08: "Decisão sem valor", F09: "Contrato sem decisão nas atas",
    F10: "Apoios sem regulamento", F11: "Apoios concentrados", F12: "Contratos concentrados num fornecedor", F13: "Possível divisão de contratos",
    F14: "Só um concorrente", F15: "Preço igual ao preço base", F16: "Contrato subiu mais de 10%", F17: "Pouco concurso público",
    F19: "Faltas a reuniões", F20: "Apoios que param", F21: "Câmara e Junta dão valores diferentes", F24: "Sessão anunciada em cima da hora" };
  // período: só o ano quando o alerta é de um ano inteiro
  J.period = f => { const a = f.periodo_inicio || "", b = f.periodo_fim || ""; return a.slice(5, 10) === "01-01" && b.slice(5, 10) === "12-31" && a.slice(0, 4) === b.slice(0, 4) ? a.slice(0, 4) : (a === b || !b ? J.date(a) : `${J.date(a)} → ${J.date(b)}`); };
  // títulos de alertas em linguagem simples: "Orçamento 2026 — em falta"
  J.flagTitle = f => J.esc(J.sc(String(f.titulo || "")).replace(/(: )(.+)$/, (m, a, b) => a + J.sc(b)).replace(/:\s*1 (em falta|não encontrado\(s\))$/, " — em falta").replace(/:\s*(\d+) não encontrado\(s\)$/, " — $1 em falta").replace(/:\s*(\d+) em falta$/, " — $1 em falta"));
  J.res = r => ({ sem_votacao: "sem votação", unanimidade: "unanimidade", maioria: "maioria", aprovada: "aprovada", rejeitada: "rejeitada" }[r] || String(r || "").replace(/_/g, " "));
  J.fstate = s => ({ aberto: "Aberto", respondido: "Com resposta", resolvido: "Resolvido", por_rever: "Por rever", publicado: "Publicado" }[s] || J.esc(s || ""));
  J.sevTag = s => `<span class="sev sev${s}">${J.SEV[s]}</span>`;
  J.ORIGIN = { estado: "Estado", municipio: "Câmara Municipal", freguesia: "Própria (Junta)", ue: "Fundos europeus", outra_autarquia: "Outra autarquia",
    entidade_privada: "Empresas e associações", pessoal: "Pessoal", banco: "Banco / dívida", desconhecido: "Desconhecido" };
  J.CAT = { transferencias_estado: "Transferências do Estado (FFF)", transferencias_municipio: "Transferências do Município", fundos_europeus: "Fundos europeus",
    taxas: "Taxas e licenças", vendas: "Venda de bens e serviços", rendas: "Rendas", emprestimos: "Empréstimos", saldo_anterior: "Saldo do ano anterior",
    outras_receitas: "Outras receitas", desconhecida: "Desconhecida", pessoal: "Pessoal", bens_servicos: "Bens e serviços", apoios: "Apoios a entidades",
    obras: "Obras e investimento", juros_divida: "Juros e dívida", amortizacao: "Pagamento de empréstimos", outras_despesas: "Outras despesas" };
  J.DEBT = new Set(["emprestimos", "amortizacao"]);   // regra R2: empréstimo não é receita; pagar empréstimo não é despesa nova
  J.AREAS = ["Finanças", "Pessoal", "Apoios", "Obras e espaço público", "Educação e juventude", "Ação social", "Cultura e festas", "Desporto",
    "Ambiente e limpeza", "Urbanismo e licenças", "Mobilidade", "Regulamentos e governação", "Outro"];

  // glossário (tooltip em cada termo técnico)
  J.GLOSS = {
    "Junta de Freguesia": "O executivo da freguesia (presidente + vogais). Toma as decisões do dia a dia.",
    "Assembleia de Freguesia": "O 'parlamento' eleito da freguesia. Aprova orçamento e contas e fiscaliza a Junta.",
    "Câmara Municipal": "O executivo do município (presidente + vereadores).",
    "Assembleia Municipal": "O 'parlamento' do município. Inclui por direito todos os presidentes de Junta.",
    "Mandato": "Um período de 4 anos entre eleições autárquicas.",
    "Orçamento": "O plano anual: quanto se prevê receber e gastar.",
    "GOP": "Grandes Opções do Plano: investimentos (PPI) e atividades (PPA) planeados para o ano.",
    "Prestação de contas": "As contas do ano: o que aconteceu de facto. Votadas até 30 de abril.",
    "Ata": "O registo escrito de uma reunião: quem esteve, o que se decidiu e como se votou.",
    "Edital": "Aviso público: convocatória de uma sessão ou publicação de decisões.",
    "FFF": "Fundo de Financiamento das Freguesias: dinheiro que o Estado dá a cada freguesia, todos os meses.",
    "Delegação de competências": "A Câmara passa uma tarefa (e o dinheiro) para a Junta, por contrato.",
    "Portal BASE": "O portal nacional onde são publicados os contratos públicos.",
    "LADA": "Lei de acesso aos documentos administrativos. Permite pedir documentos que não estão publicados.",
    "Ajuste direto": "Contratação sem concurso aberto: a entidade convida diretamente um fornecedor.",
    "NIF": "Número de identificação fiscal de uma empresa, associação ou autarquia."
  };
  J.gloss = text => {
    let s = J.esc(text);
    for (const [k, v] of Object.entries(J.GLOSS)) {
      const rx = new RegExp(`\\b(${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`);
      s = s.replace(rx, `<abbr class="g" title="${J.esc(v)}">$1</abbr>`);
    }
    return s;
  };

  // ecrã pequeno (telemóvel) e ecrã de toque
  J.mobile = () => window.matchMedia("(max-width: 719px)").matches;
  J.wide = () => window.matchMedia("(min-width: 900px)").matches;   // barra lateral e linha do tempo sempre aberta
  J.touch = window.matchMedia("(hover: none)").matches;

  // tooltip. No toque: um toque mostra a dica num cartão fixo em baixo (com ✕); outro toque fora fecha.
  let tip, tipAt = 0;
  J.tip = (e, html) => {
    if (!tip) {
      tip = document.createElement("div"); tip.className = "tip"; document.body.appendChild(tip);
      if (J.touch) document.addEventListener("touchstart", ev => { if (!tip.hidden && !tip.contains(ev.target) && Date.now() - tipAt > 300) tip.hidden = true; }, { passive: true });
    }
    if (!html) { tip.hidden = true; return; }
    if (J.touch) {
      tipAt = Date.now();
      tip.className = "tip tip-sheet";
      tip.innerHTML = `<button class="tip-x" type="button" aria-label="Fechar" onclick="J.hideTip(true)">✕</button>` + html;
      tip.hidden = false; tip.style.left = ""; tip.style.top = "";
      return;
    }
    tip.innerHTML = html; tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  };
  // no toque, o "mouseleave" que o navegador simula não fecha a dica (só o ✕, um toque fora ou mudar de página)
  J.hideTip = force => { if (!tip) return; if (J.touch && force !== true && Date.now() - tipAt < 600) return; tip.hidden = true; };

  // lista com "Mostrar mais": evita páginas enormes. rows → html de cada linha.
  J.list = (el, rows, render, opt = {}) => {
    const step = opt.page || 20; let n = step;
    const draw = () => {
      el.innerHTML = rows.length ? `<div class="${opt.cls || "items"}">${rows.slice(0, n).map(render).join("")}</div>` +
        (rows.length > n ? `<button class="btn more-btn" type="button">Mostrar mais (${rows.length - n} restantes)</button>` : "")
        : `<div class="empty">${opt.empty || "Nada para mostrar."}</div>`;
      const b = el.querySelector(".more-btn"); if (b) b.onclick = () => { n += step * 2; draw(); };
    };
    draw();
  };
  // filtros: a pesquisa fica à vista; o resto dobra-se em "Filtros" no telemóvel
  J.filters = (search, rest) => `<div class="filters">${search || ""}${rest ? `<details class="fmore" ${J.mobile() ? "" : "open"}><summary class="btn">Filtros</summary><div class="filters-in">${rest}</div></details>` : ""}</div>`;

  // CSV
  J.csv = (name, rows) => {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const blob = new Blob(["﻿" + [cols.map(q).join(";"), ...rows.map(r => cols.map(c => q(r[c])).join(";"))].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name + ".csv"; a.click();
  };

  // ---------- partidos ----------
  J.partyColor = (aut, k) => (aut && aut.partidos && aut.partidos[k] && aut.partidos[k].cor) || (k ? "#7b8a99" : "#b9b9b2");
  J.partyTag = (aut, k) => k ? `<span class="party" style="--pc:${J.partyColor(aut, k)}">${J.esc(k)}</span>` : `<span class="badge">lista ?</span>`;

  // ---------- URL / estado ----------
  J.parse = () => {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, qs] = h.split("?");
    const parts = path.split("/").filter(Boolean);
    const q = Object.fromEntries(new URLSearchParams(qs || ""));
    return { parts, q };
  };
  J.go = (path, q) => {
    const s = new URLSearchParams(Object.entries(q || {}).filter(([, v]) => v != null && v !== "")).toString();
    location.hash = "#/" + path + (s ? "?" + s : "");
  };
  J.setQ = patch => {
    const { parts, q } = J.parse();
    J.go(parts.join("/"), Object.assign({}, q, patch));
  };
  J.href = (path, patch) => {
    const { q } = J.parse();
    const keep = { sel: q.sel, tab: q.tab };
    const s = new URLSearchParams(Object.entries(Object.assign(keep, patch || {})).filter(([, v]) => v != null && v !== "")).toString();
    return "#/" + path + (s ? "?" + s : "");
  };

  // ---------- dados ----------
  J.get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); };
  J.load = async aid => {
    if (J.cache[aid]) return J.cache[aid];
    const names = ["base", "documentos", "reunioes", "pessoas", "entidades", "dinheiro", "obras", "alertas"];
    const parts = await Promise.all(names.map(n => J.get(`data/${aid}/${n}.json`).catch(() => ({}))));
    const D = Object.assign({}, ...parts.map((p, i) => ({ [names[i]]: p })));
    const A = D.base;
    D.aut = A;
    D.docById = Object.fromEntries((D.documentos.documentos || []).map(d => [d.id, d]));
    D.entById = Object.fromEntries((D.entidades.entidades || []).map(e => [e.id, e]));
    D.pessoaById = Object.fromEntries((D.pessoas.pessoas || []).map(p => [p.id, p]));
    D.reuById = Object.fromEntries((D.reunioes.reunioes || []).map(r => [r.id, r]));
    D.decById = Object.fromEntries((D.reunioes.decisoes || []).map(r => [r.id, r]));
    D.flagById = Object.fromEntries((D.alertas.alertas || []).map(r => [r.id, r]));
    D.conById = Object.fromEntries((D.dinheiro.contratos || []).map(r => [r.id, r]));
    D.mandatos = (A.mandatos || []).filter(m => (m.fim || "9999") >= "2009" && m.inicio <= J.today);   // sem mandatos futuros
    J.cache[aid] = D;
    return D;
  };

  // ---------- seleção (mandato / ano / intervalo / reunião) ----------
  J.selection = (D, sel) => {
    const ms = D.mandatos;
    const cur = ms.filter(m => m.inicio <= J.today).slice(-1)[0] || ms[ms.length - 1];
    if (!sel) sel = cur ? "m:" + cur.id : "a:" + new Date().getFullYear();
    const [k, v] = [sel.slice(0, sel.indexOf(":")), sel.slice(sel.indexOf(":") + 1)];
    if (k === "m") {
      const m = ms.find(x => x.id === v) || cur;
      return { kind: "m", key: "m:" + m.id, m, from: m.inicio, to: m.fim || J.today,
        label: `Mandato ${m.inicio.slice(0, 4)}–${(m.fim || "hoje").slice(0, 4)}`, unit: m.unidade };
    }
    if (k === "a") return { kind: "a", key: sel, from: `${v}-01-01`, to: `${v}-12-31`, label: `Ano ${v}`, year: +v };
    if (k === "r") { const [a, b] = v.split(".."); return { kind: "r", key: sel, from: a, to: b, label: `${J.date(a)} → ${J.date(b)}` }; }
    if (k === "reu") {
      const r = D.reuById[v];
      return { kind: "reu", key: sel, from: r ? r.data : J.today, to: r ? r.data : J.today, reuniao: r, label: r ? `Reunião de ${J.date(r.data)}` : "Reunião" };
    }
    return J.selection(D, null);
  };
  // pontuação média dos anos de um período (a mesma conta em todo o site)
  J.scoreOf = (D, from, to) => {
    const ys = Object.entries(D.aut.score || {}).filter(([y]) => y >= from.slice(0, 4) && y <= to.slice(0, 4));
    return ys.length ? Math.round(ys.reduce((a, [, s]) => a + (s.total || 0), 0) / ys.length) : null;
  };
  J.inSel = (S, a, b) => { a = a || b; b = b || a; if (!a) return false; return a.slice(0, 10) <= S.to && b.slice(0, 10) >= S.from; };
  J.mandateAt = (D, date) => D.mandatos.filter(m => m.inicio <= date && (!m.fim || m.fim > date)).slice(-1)[0];

  // ---------- fonte de um valor ----------
  J.src = (D, aid, p, label) => {
    if (!p || !p.doc_id) return "";
    const d = D.docById[p.doc_id];
    const t = J.esc((p.excerto || "").slice(0, 200));
    return `<a class="srclink" href="${J.href(J.base(D) + "/doc/" + p.doc_id, { pag: p.pagina, q: (p.excerto || "").slice(0, 60) })}" title="Fonte: ${J.esc(d ? d.titulo : p.doc_id)}${p.pagina ? ", p. " + p.pagina : ""} — «${t}»">${label || "fonte"}</a>`;
  };
  J.base = D => (D.aut.tipo === "municipio" ? "m/" : "f/") + D.aut.id;
  J.ent = (D, id) => { const e = D.entById[id]; return e ? `<a href="${J.href(J.base(D) + "/entidade/" + id)}">${J.esc(e.nome)}</a>` : "—"; };

  // ---------- ícones (traço, estilo SF Symbols) ----------
  const svg = (p, cls) => `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  J.ICON = {
    house: svg('<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.8 9.6V20h4.4v-5.6h3.6V20h4.4V9.6"/>'),
    euro: svg('<circle cx="12" cy="12" r="9"/><path d="M15.6 8.4a4.6 4.6 0 1 0 0 7.2"/><path d="M7.4 10.8h6.2M7.4 13.2h6.2"/>'),
    seal: svg('<path d="M12 2.8l2.1 1.5 2.6-.2.9 2.4 2.3 1.3-.6 2.5 1 2.4-1.9 1.8-.2 2.6-2.5.7-1.4 2.2-2.5-.8-2.4 1-1.8-1.9-2.6-.2-.7-2.5-2.2-1.4.8-2.5-1-2.4 1.9-1.8.2-2.6 2.5-.7L9.8 3.5z"/><path d="M8.6 12.2l2.3 2.3 4.6-4.7"/>'),
    bubble: svg('<path d="M6.5 4h11A2.5 2.5 0 0 1 20 6.5v7.5a2.5 2.5 0 0 1-2.5 2.5H11l-4.6 3.6v-3.6A2.5 2.5 0 0 1 4 14V6.5A2.5 2.5 0 0 1 6.5 4z"/><path d="M12 7v4.4"/><path d="M12 13.7v.1" stroke-width="2.2"/>'),
    grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
    search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/>'),
    doc: svg('<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z" transform="translate(-.5 0)"/><path d="M13.5 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>'),
    people: svg('<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.5 14.2c2.4-.3 4.4 1.2 5 4.3"/>'),
    building: svg('<path d="M4 20.5h16"/><path d="M6 20.5V8l6-4 6 4v12.5"/><path d="M9.5 11h1M13.5 11h1M9.5 14.5h1M13.5 14.5h1"/>'),
    crane: svg('<path d="M5 20.5V5.5h10l4 3"/><path d="M5 9h9"/><path d="M15 5.5V12"/><path d="M13 12h4v3h-4z"/><path d="M3 20.5h6"/>'),
    ballot: svg('<rect x="4" y="11" width="16" height="9.5" rx="2"/><path d="M8 11V5.5h8V11"/><path d="M10 8.5l1.5 1.5L14.5 7"/>'),
    gauge: svg('<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l3.5-4.5"/><circle cx="12" cy="16" r="1"/>'),
    back: svg('<path d="M15 4.5 7.5 12l7.5 7.5"/>', "ic-back"),
    chev: svg('<path d="M9.5 6l6 6-6 6"/>', "ic-chev"),
    down: svg('<path d="M6.5 9.5 12 15l5.5-5.5"/>', "ic-down"),
    more: svg('<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', "ic-check"),
    close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>')
  };

  // ---------- moldura: botões de vidro em cima, barra de separadores de vidro em baixo ----------
  // o: { back: {href, label}, center: html, tabs: [[key, label, icon, badge, href]], tab, search: href, menu: fn, sec }
  const SITE = [["#/", "Autarquias"], ["#/comparar", "Comparar"], ["#/metodologia", "Metodologia"], ["#/sobre", "Sobre"], ["#/resposta", "Direito de resposta"]];
  J.siteMenu = () => J.sheet(`<h2 class="sheet-t">Janela Cívica</h2>${J.glist(SITE.map(([h, t]) => ({ href: h, title: t })))}`);
  J.chrome = o => {
    const nav = J.$("#navbar"), tb = J.$("#tabbar");
    J._chrome = o;
    document.body.dataset.sec = o.sec || "inicio";
    nav.innerHTML = `<div class="nb-l">${o.back ? `<a class="nb-c glass" href="${o.back.href}" id="nb-back" aria-label="${J.esc(o.back.label)}">${J.ICON.back}</a>` : `<a class="nb-brand" href="#/">Janela Cívica</a>`}</div>
      <div class="nb-m">${o.center || ""}</div>
      <div class="nb-r"><button class="nb-c glass" id="nb-more" type="button" aria-label="Mais opções">${J.ICON.more}</button></div>`;
    J.$("#nb-more").onclick = o.menu || J.siteMenu;
    const b = J.$("#nb-back");
    // voltar = voltar no histórico quando viemos de dentro do site; senão, ir para o ecrã de cima
    if (b) b.onclick = e => { if (J._stack.length > 1) { e.preventDefault(); history.back(); } };
    const tabs = o.tabs || [];
    const keys = tabs.map(t => t[0]).join(",");
    const i = Math.max(0, tabs.findIndex(t => t[0] === o.tab));
    // a barra só é desenhada de novo quando mudam os separadores; assim a "gota" desliza até ao novo separador
    if (tb.dataset.keys !== keys) {
      tb.dataset.keys = keys;
      tb.innerHTML = `<a class="sb-brand" href="#/">Janela Cívica</a>
        <div class="tb glass"><span class="tb-drop" aria-hidden="true"></span>${tabs.map(([k]) => `<a data-tab="${k}"></a>`).join("")}</div>
        <a class="tb-search glass" aria-label="Procurar"></a>
        <div class="sb-site">${SITE.map(([h, t]) => `<a href="${h}">${t}</a>`).join("")}</div>`;
    }
    const bar = J.$(".tb", tb);
    if (bar) {
      bar.style.setProperty("--n", tabs.length); bar.style.setProperty("--i", i);
      bar.classList.toggle("none", !tabs.some(t => t[0] === o.tab));
      tabs.forEach(([k, label, icon, badge, href]) => {
        const a = J.$(`[data-tab="${k}"]`, bar), on = o.tab === k;
        a.href = href; a.className = on ? "on" : ""; on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
        a.innerHTML = `${icon}<span>${label}</span>${badge ? `<b class="tb-badge">${badge}</b>` : ""}`;
        // tocar no separador ativo: voltar ao topo (como no iOS)
        a.onclick = e => { if (on && o.atRoot) { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); } };
      });
      const s = J.$(".tb-search", tb);
      s.href = o.search || "#/"; s.classList.toggle("on", o.tab === "explorar");
      s.innerHTML = `${J.ICON.search}<span>Procurar</span>`;
    }
    document.body.classList.toggle("has-tabs", tabs.length > 0);
  };
  // o título grande dá lugar à pílula da barra de cima quando sai do ecrã
  J.largeTitle = () => {
    if (J._lto) J._lto.disconnect();
    document.body.classList.remove("nb-scrolled", "hero-out");
    const h = J.$("#app .lt h1"), hero = J.$("#hero");
    if (!window.IntersectionObserver) { document.body.classList.add("nb-scrolled", "hero-out"); return; }
    J._lto = new IntersectionObserver(es => es.forEach(e => {
      if (e.target === h) document.body.classList.toggle("nb-scrolled", !e.isIntersecting);
      if (e.target === hero) document.body.classList.toggle("hero-out", !e.isIntersecting);
    }), { rootMargin: "-64px 0px 0px 0px" });
    if (h) J._lto.observe(h); else document.body.classList.add("nb-scrolled");
    if (hero) J._lto.observe(hero); else document.body.classList.add("hero-out");
  };
  // lista agrupada: [{ href|id|sel|data, title, sub, value, icon }]
  J.glist = (rows, head) => `${head ? `<h3 class="ghead">${head}</h3>` : ""}<div class="glist">${rows.map(r => {
    const inner = `${r.icon ? `<span class="g-ic">${r.icon}</span>` : ""}<span class="g-main"><span class="g-t">${r.title}</span>${r.sub ? `<span class="g-s">${r.sub}</span>` : ""}</span>${r.value != null && r.value !== "" ? `<span class="g-v">${r.value}</span>` : ""}${r.check ? J.ICON.check : r.href || r.id || r.sel || r.data ? J.ICON.chev : ""}`;
    return r.href ? `<a class="grow" href="${r.href}"${r.ext ? ' target="_blank" rel="noopener"' : ""}>${inner}</a>`
      : r.id || r.sel || r.data ? `<button class="grow" type="button"${r.id ? ` id="${r.id}"` : ""}${r.sel ? ` data-sel="${r.sel}"` : ""}${r.data ? " " + r.data : ""}>${inner}</button>` : `<div class="grow${r.cls ? " " + r.cls : ""}">${inner}</div>`;
  }).join("")}</div>`;

  // ---------- números que contam até ao valor (e rolam quando a seleção muda) ----------
  // <span data-count="12345" data-fmt="eur|seur|int" data-key="...">
  J._cnt = {};
  const FMT = { int: v => J.int(v), eur: v => J.eur(v, true), seur: v => (v < 0 ? "−" : "+") + J.eur(Math.abs(v), true) };
  J.countUp = root => {
    const els = J.$$("[data-count]", root);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    els.forEach(el => {
      const to = +el.dataset.count, f = FMT[el.dataset.fmt] || FMT.int, k = el.dataset.key || el.dataset.fmt;
      const from = J._cnt[k] != null ? J._cnt[k] : 0;
      J._cnt[k] = to;
      if (reduce || from === to || !isFinite(to)) { el.textContent = f(to); return; }
      const t0 = performance.now(), dur = 700;
      const step = t => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = f(Math.round(from + (to - from) * e)); if (p < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  };

  // ---------- folha (sheet): cresce a partir do botão tocado ----------
  let lastTap = null;
  document.addEventListener("pointerdown", e => { lastTap = { x: e.clientX, y: e.clientY }; }, true);
  J.sheet = (html, opt = {}) => {
    const dlg = J.$("#sheet"), body = J.$("#drawer");
    if (!html) {
      if (dlg.open && !dlg.classList.contains("closing")) {
        dlg.classList.add("closing");
        setTimeout(() => { dlg.classList.remove("closing"); dlg.style.transform = ""; if (dlg.open) dlg.close(); }, 240);
      }
      document.body.classList.remove("sheet-open");
      return;
    }
    dlg.classList.remove("closing", "morph"); dlg.style.transform = "";
    body.innerHTML = html;
    dlg.dataset.detent = opt.detent || "medium";
    const wasOpen = dlg.open;
    if (!wasOpen) dlg.showModal();
    body.scrollTop = 0;
    // a folha cresce do sítio onde se tocou
    if (!wasOpen && lastTap) {
      const r = dlg.getBoundingClientRect();
      dlg.style.transformOrigin = `${lastTap.x - r.left}px ${lastTap.y - r.top}px`;
      void dlg.offsetWidth; dlg.classList.add("morph");
    }
    document.body.classList.add("sheet-open");
    J.hideTip(true);
    if (J.countUp) J.countUp(body);
  };
  J.drawer = J.sheet;
  const sheetSetup = () => {
    const dlg = J.$("#sheet"), grab = J.$(".sheet-grab", dlg);
    dlg.addEventListener("cancel", e => { e.preventDefault(); J.sheet(null); });
    dlg.addEventListener("click", e => { if (e.target === dlg) J.sheet(null); });   // toque fora da folha
    // arrastar a pega: para cima = folha grande; para baixo = folha média ou fechar
    let y0 = null;
    grab.addEventListener("pointerdown", e => { y0 = e.clientY; grab.setPointerCapture(e.pointerId); dlg.style.transition = "none"; dlg.classList.remove("morph"); });
    grab.addEventListener("pointermove", e => { if (y0 == null) return; const dy = e.clientY - y0; dlg.style.transform = dy > 0 ? `translateY(${dy}px)` : ""; });
    const end = e => {
      if (y0 == null) return;
      const dy = e.clientY - y0; y0 = null; dlg.style.transition = ""; dlg.style.transform = "";
      if (dy < -30) dlg.dataset.detent = "large";
      else if (dy > 60) { if (dlg.dataset.detent === "large" && dy < 220) dlg.dataset.detent = "medium"; else J.sheet(null); }
      else if (Math.abs(dy) < 6) dlg.dataset.detent = dlg.dataset.detent === "large" ? "medium" : "large";
    };
    grab.addEventListener("pointerup", end); grab.addEventListener("pointercancel", end);
  };

  // ---------- transições: o cartão tocado "abre" no ecrã seguinte (zoom); o resto esbate ----------
  const canVT = () => document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let zoomFrom = null;
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("#app a[href^='#/'], #app button.bc");
    if (!a || !canVT()) return;
    J.$$("[style*='view-transition-name']").forEach(x => x.style.viewTransitionName = "");
    if (a.matches(".bc, .cc, .tile, .vt-card, .stack-card, .ptype, .story")) { a.style.viewTransitionName = "zoom"; zoomFrom = a; }
  }, true);

  // ---------- arranque ----------
  J._stack = []; J._scroll = {};
  const draw = async () => {
    J.hideTip(true);
    J.sheet(null);
    const { parts, q } = J.parse();
    const app = J.$("#app");
    // posição de leitura guardada por ecrã (o mesmo ecrã com outra seleção mantém a posição)
    const key = parts.join("/") + "|" + (q.tab || "");
    const prev = J._cur;
    if (prev) J._scroll[prev.key] = window.scrollY;
    const h = location.hash;
    if (J._stack.length > 1 && J._stack[J._stack.length - 2] === h) J._stack.pop(); else if (J._stack[J._stack.length - 1] !== h) J._stack.push(h);
    J._cur = { key, parts, sel: q.sel };
    try {
      if (!parts.length) await J.pages.home(app);
      else if (parts[0] === "comparar") await J.pages.compare(app, q);
      else if (parts[0] === "metodologia") await J.pages.method(app);
      else if (parts[0] === "sobre") await J.pages.about(app);
      else if (parts[0] === "resposta") await J.pages.reply(app);
      else if (parts[0] === "f" || parts[0] === "m") {
        const D = await J.load(parts[1]);
        await J.pages.autarquia(app, D, parts.slice(2), q);
      } else app.innerHTML = `<div class="empty">Página não encontrada.</div>`;
      if (!(parts[0] === "f" || parts[0] === "m")) J.chrome({ sec: "inicio" });
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="empty">Não foi possível carregar os dados (${J.esc(e.message)}). Foi corrido <code>python run.py publicar</code>?</div>`;
    }
    // o ecrã novo recebe o mesmo nome do cartão tocado: o navegador anima um no outro
    if (zoomFrom) { const t = J.$("#app .dh, #app .lt"); if (t) t.style.viewTransitionName = "zoom"; zoomFrom = null; }
    J.largeTitle();
    document.body.classList.toggle("has-pill", !!J.$("#pill"));
    window.scrollTo(0, J._scroll[key] || 0);
    J.countUp(app);
  };
  J.render = () => {
    if (!canVT() || !J._cur) return draw();
    const t = document.startViewTransition(draw);
    t.finished.finally(() => J.$$("[style*='view-transition-name']").forEach(x => x.style.viewTransitionName = ""));
    return t.updateCallbackDone;
  };
  J.start = () => {
    sheetSetup();
    window.addEventListener("hashchange", J.render);
    // a barra de separadores encolhe ao descer e volta ao subir
    let lastY = 0;
    window.addEventListener("scroll", () => {
      const y = window.scrollY, d = y - lastY;
      if (Math.abs(d) > 6) { document.body.classList.toggle("tb-compact", d > 0 && y > 120); lastY = y; }
    }, { passive: true });
    // ao passar de telemóvel para ecrã largo (ou rodar o telemóvel), desenhar outra vez
    const size = () => `${J.mobile()}|${J.wide()}`;
    let was = size();
    window.addEventListener("resize", () => { clearTimeout(J._rz); J._rz = setTimeout(() => { if (size() !== was) { was = size(); J.render(); } }, 200); });
    J.render();
  };
})();

"""Contratos do Portal BASE a partir dos dados abertos (dados.gov.pt, IMPIC): um Excel por ano.

Lê cada ficheiro uma só vez e guarda os contratos de todas as entidades com fontes `base` na configuração.
Cada contrato fica como um documento JSON no mesmo formato da página de detalhe do BASE,
com o mesmo URL, para não haver duplicados se o BASE voltar a responder.
"""
import json
import re
from datetime import date, datetime

from ..common import DATA, autarquias, log, norm, now
from .web import end_crawl, register, start_crawl

API = "https://dados.gov.pt/api/1/datasets/contratos-publicos-portal-base-impic-contratos-de-2012-a-2026/"
PAGE = "https://dados.gov.pt/pt/datasets/contratos-publicos-portal-base-impic-contratos-de-2012-a-2026/"
CACHE = DATA / "cache" / "base-abertos"

# coluna do Excel (normalizada, sem espaços) -> campo no formato do BASE
COLS = {
    "id": ["idcontrato", "id"],
    "contracting": ["adjudicantes", "adjudicante"],
    "contracted": ["adjudicatarios", "adjudicatario"],
    "objectBriefDescription": ["objectocontrato", "objetocontrato", "objeto", "objecto"],
    "contractingProcedureType": ["tipoprocedimento"],
    "contractTypes": ["tipocontrato"],
    "publicationDate": ["datapublicacao"],
    "signingDate": ["datacelebracaocontrato", "datacelebracao"],
    "initialContractualPrice": ["precocontratual"],
    "estimatedBasePrice": ["precobaseprocedimento", "precobase"],
    "totalEffectivePrice": ["precototalefetivo", "precototalefectivo"],
    "closeDate": ["datafechocontrato"],
    "endOfContractType": ["tipofimcontrato"],
    "cpvs": ["cpv"],
    "executionDeadline": ["prazoexecucao"],
    "executionPlace": ["localexecucao"],
    "directAwardFundamentationType": ["fundamentacao"],
    "contestants": ["concorrentes"],
    "observations": ["observacoes"],
    "description": ["desccontrato"],
    "causesDeadlineChange": ["causasalteraprazo"],
    "causesPriceChange": ["causasalterapreco"],
    "contractStatus": ["estadocontrato"],
    "documentsLink": ["linkpecasproc"],
}
# formato real: "nifEntContrato=501510184|descEntContrato=ISCTE ...|codPaisEntContrato=PRT|..."
PARTY_KV = re.compile(r"nifEntContrato=([^|;\n]*)\|descEntContrato=([^|;\n]*)")
PARTY = re.compile(r"(\d{9})\s*-\s*([^|;\n]+)")


def _key(s):
    return re.sub(r"[^a-z0-9]", "", norm(str(s or "")))


def _date(v):
    if isinstance(v, (datetime, date)):
        return v.strftime("%d-%m-%Y")
    s = str(v or "").strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    m = re.match(r"(\d{2})[-/](\d{2})[-/](\d{4})", s)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else (s or None)


def _price(v):
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return f"{v:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")
    return str(v)


def _parties(v):
    txt = str(v or "")
    found = PARTY_KV.findall(txt) or PARTY.findall(txt)
    out = [{"nif": n.strip() or None, "description": d.strip()} for n, d in found]
    return out or ([{"nif": None, "description": str(v).strip()}] if v else [])


def _targets():
    """Todas as fontes `base` da configuração: por NIF, ou por nome exato com data limite."""
    by_nif, by_name = {}, []
    for aid, rec in autarquias().items():
        for s in rec.get("fontes", []):
            if s["tipo"] != "base":
                continue
            t = dict(s, autarquia=aid)
            if s.get("nif"):
                by_nif[str(s["nif"])] = t
            else:
                by_name.append(t)
    return by_nif, by_name


def _resources(f):
    r = f.get(API)
    if r is None or r.status_code != 200:
        return []
    out = []
    for res in r.json().get("resources", []):
        m = re.fullmatch(r"contratos(\d{4})\.xlsx", res.get("title", ""))
        if m:
            out.append((int(m.group(1)), res["url"], res.get("last_modified") or res.get("created_at") or ""))
    return sorted(out)


def _download(f, year, url, stamp):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"contratos{year}.xlsx"
    tag = CACHE / f"contratos{year}.versao"
    if path.exists() and tag.exists() and tag.read_text() == stamp:
        return path
    log(f"  a descarregar contratos{year}.xlsx …")
    r = f.get(url, stream=True)
    if r is None or r.status_code != 200:
        log(f"  falhou o download de {year}")
        return path if path.exists() else None
    tmp = path.with_suffix(".parcial")
    with open(tmp, "wb") as out:
        for chunk in r.iter_content(1 << 20):
            out.write(chunk)
    tmp.replace(path)
    tag.write_text(stamp)
    return path


def _rows(path):
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    header = [_key(h) for h in next(it)]
    idx = {}
    for field, names in COLS.items():
        for n in names:
            if n in header:
                idx[field] = header.index(n)
                break
    if "contracting" not in idx:
        wb.close()
        raise ValueError(f"colunas desconhecidas em {path.name}: {header}")
    for i, row in enumerate(it, 2):
        yield i, idx, row
    wb.close()


def run(con, f, src, aut):
    """Fonte `base_abertos`: percorre os ficheiros anuais e guarda os contratos das entidades configuradas."""
    crawl_id, _ = start_crawl(con, src, aut)
    by_nif, by_name = _targets()
    names = {norm(t["nome_pesquisa"]): t for t in by_name}
    resources = _resources(f)
    if not resources:
        end_crawl(con, crawl_id, erros=1, nota="dados.gov.pt não respondeu")
        log("  dados.gov.pt não respondeu")
        return
    years = src.get("anos")
    found = new = 0
    for year, url, stamp in resources:
        if years and year not in years:
            continue
        path = _download(f, year, url, stamp)
        if not path:
            continue
        log(f"  a ler contratos{year}.xlsx …")
        n_year = 0
        for line, idx, row in _rows(path):
            raw_adj = row[idx["contracting"]]
            if not raw_adj:
                continue
            adj = _parties(raw_adj)
            target = next((by_nif[a["nif"]] for a in adj if a["nif"] in by_nif), None)
            if not target:
                hit = next((names[norm(a["description"])] for a in adj if norm(a["description"]) in names), None)
                if hit:
                    d = {k: row[i] for k, i in idx.items()}
                    sd = _date(d.get("signingDate")) or _date(d.get("publicationDate")) or ""
                    iso = f"{sd[6:10]}-{sd[3:5]}-{sd[:2]}" if len(sd) == 10 else ""
                    if not hit.get("ate") or (iso and iso < str(hit["ate"])):
                        target = hit
            if not target:
                continue
            d = {k: row[i] for k, i in idx.items()}
            cid = str(d.get("id") or f"{year}-{line}")
            rec = {
                "id": cid,
                "contracting": adj,
                "contracted": _parties(d.get("contracted")),
                "objectBriefDescription": str(d.get("objectBriefDescription") or "").strip(),
                "contractingProcedureType": d.get("contractingProcedureType"),
                "contractTypes": d.get("contractTypes"),
                "publicationDate": _date(d.get("publicationDate")),
                "signingDate": _date(d.get("signingDate")),
                "closeDate": _date(d.get("closeDate")),
                "initialContractualPrice": _price(d.get("initialContractualPrice")),
                "estimatedBasePrice": _price(d.get("estimatedBasePrice")),
                "totalEffectivePrice": _price(d.get("totalEffectivePrice")),
                "endOfContractType": d.get("endOfContractType"),
                "cpvs": str(d.get("cpvs") or ""),
                "executionDeadline": str(d.get("executionDeadline") or ""),
                "executionPlace": d.get("executionPlace"),
                "directAwardFundamentationType": d.get("directAwardFundamentationType"),
                "contestants": _parties(d.get("contestants")) if d.get("contestants") else [],
                "observations": d.get("observations"),
                "description": d.get("description"),
                "causesDeadlineChange": d.get("causesDeadlineChange"),
                "causesPriceChange": d.get("causesPriceChange"),
                "contractStatus": d.get("contractStatus"),
                "documentsLink": d.get("documentsLink"),
                "_origem": {"ficheiro": f"contratos{year}.xlsx", "linha": line, "url": url, "versao": stamp},
            }
            sd = rec["signingDate"] or ""
            content = json.dumps(rec, ensure_ascii=False, indent=1, default=str).encode()
            _, is_new = register(
                con, url=f"https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id={cid}",
                fonte=src["id"], autarquia=target["autarquia"], unidade=target.get("unidade"),
                content=content, mime="application/json",
                titulo=f"Contrato: {rec['objectBriefDescription'][:200]}",
                found_on=PAGE, link_text=f"contratos{year}.xlsx, linha {line}",
                date_hint=f"{sd[6:10]}-{sd[3:5]}-{sd[:2]}" if len(sd) == 10 else None,
                meta={"base_id": cid, "tipo_fonte": "base", "via": "dados_abertos"})
            found += 1
            n_year += 1
            new += is_new
        con.commit()
        log(f"  {year}: {n_year} contratos das entidades configuradas")
    end_crawl(con, crawl_id, paginas=len(resources), novos=new,
              nota=f"{found} contratos (todas as entidades) nos dados abertos")
    log(f"  dados abertos: {found} contratos ({new} novos)")

"""Fontes com API: Portal BASE (contratos), SGMAI (eleições), INE (população)."""
import json
import re

from ..common import log, norm, now
from .web import end_crawl, register, start_crawl

BASE_URL = "https://www.base.gov.pt/Base4/pt/resultados/"
BASE_SEARCH = "https://www.base.gov.pt/Base4/pt/pesquisa/?type=contratos"


def _base_version(f):
    r = f.get(BASE_SEARCH)
    if r is not None:
        m = re.search(r"version['\"]?\s*[:=]\s*['\"]?(\d+\.\d+)", r.text)
        if m:
            return m.group(1)
    return "142.0"


class Bloqueado(Exception):
    pass


def _base_post(f, data):
    r = f.get(BASE_URL, method="POST", data=data, headers={
        "X-Requested-With": "XMLHttpRequest", "Referer": BASE_SEARCH,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"})
    if r is not None and ("WebKnight" in r.text[:2000] or r.status_code == 999):
        raise Bloqueado()
    if r is None or r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


def run_base(con, f, src, aut):
    """Contratos públicos de uma entidade adjudicante. Cada contrato é guardado como um documento JSON."""
    crawl_id, t0 = start_crawl(con, src, aut)
    try:
        _run_base(con, f, src, aut, crawl_id)
    except Bloqueado:
        end_crawl(con, crawl_id, erros=1, nota="o firewall do Portal BASE bloqueou o acesso; tentar mais tarde")
        log("  AVISO: o Portal BASE bloqueou o acesso (firewall). Tente de novo daqui a umas horas.")


def _run_base(con, f, src, aut, crawl_id):
    version = _base_version(f)
    query = f"tipo=0&tipocontrato=0&adjudicante={src['nome_pesquisa']}&pais=0&distrito=0&concelho=0"
    ids, page = [], 0
    while True:
        res = _base_post(f, {"type": "search_contratos", "version": version, "query": query,
                             "sort": "-publicationDate", "page": str(page), "size": "50"})
        if not res or not res.get("items"):
            break
        ids += [(i["id"], i.get("contracting", ""), i.get("signingDate")) for i in res["items"]]
        page += 1
        if len(ids) >= res.get("total", 0) or page > 100:
            break
    new = kept = 0
    for cid, contracting, signing in ids:
        url = f"https://www.base.gov.pt/Base4/pt/detalhe/?type=contratos&id={cid}"
        if con.execute("SELECT 1 FROM url WHERE url=?", (url,)).fetchone():
            con.execute("UPDATE url SET last_seen=?, removed_at=NULL WHERE url=?", (now(), url))
            kept += 1
            continue
        d = _base_post(f, {"type": "detail_contratos", "version": version, "id": str(cid)})
        if not d:
            continue
        nifs = [c.get("nif") for c in d.get("contracting") or []]
        names = [norm(c.get("description")) for c in d.get("contracting") or []]
        if src.get("nif"):
            if src["nif"] not in nifs:
                continue
        else:   # entidade antiga sem NIF conhecido: nome exato e data limite
            if norm(src["nome_pesquisa"]) not in names:
                continue
            sd = d.get("signingDate") or ""
            if src.get("ate") and sd and f"{sd[6:10]}-{sd[3:5]}-{sd[:2]}" >= str(src["ate"]):
                continue
        content = json.dumps(d, ensure_ascii=False, indent=1).encode()
        sd = d.get("signingDate") or ""
        date_hint = f"{sd[6:10]}-{sd[3:5]}-{sd[:2]}" if len(sd) == 10 else None
        _, is_new = register(con, url=url, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"),
                             content=content, mime="application/json",
                             titulo=f"Contrato: {d.get('objectBriefDescription', '')[:200]}",
                             found_on=BASE_SEARCH, link_text=d.get("objectBriefDescription"),
                             date_hint=date_hint, meta={"base_id": cid, "tipo_fonte": "base"})
        new += is_new
        kept += 1
        if new % 20 == 0:
            con.commit()
    end_crawl(con, crawl_id, paginas=len(ids), novos=new, nota=f"{kept} contratos desta entidade em {len(ids)} resultados")
    log(f"  {src['id']}: {kept} contratos ({new} novos) em {len(ids)} resultados da pesquisa")


def run_sgmai(con, f, src, aut):
    """Resultados oficiais das autárquicas (site do MAI), por território e órgão."""
    crawl_id, t0 = start_crawl(con, src, aut)
    base = src["url"].rstrip("/") + "/assets/static/"
    get = lambda p: (lambda r: r.json() if r is not None and r.status_code == 200 else None)(f.get(base + p))
    election = get("election/data-electionId=1.json")
    if not election:
        end_crawl(con, crawl_id, erros=1, nota="site de resultados inacessível")
        log("  eleições: site inacessível", base)
        return
    organs = {"CM": 4, "AM": 5, "AF": 6}
    for oid, key in re.findall(r'"id":\s*(\d+),\s*"key":\s*"(CM|AM|AF)"', json.dumps(election)):
        organs[key] = int(oid)
    tid, path = 1, []
    for name in src["territorio"]:
        kids = (get(f"territory/children-electionId=1-territoryId={tid}.json") or {}).get("data") or []
        hit = next((k for k in kids if norm(k.get("descriptionShort")) == norm(name)), None)
        if not hit:
            end_crawl(con, crawl_id, erros=1, nota=f"território não encontrado: {name}")
            log("  eleições: território não encontrado:", name)
            return
        tid = hit["id"]
        path.append(hit["descriptionShort"])
    wanted = ["AF"] if len(src["territorio"]) == 3 else ["CM", "AM"]
    new = 0
    for key in wanted:
        oid = organs.get(key)
        for kind, p in (("resultados", f"result/territory-electionId=1-territoryId={tid}-organId={oid}.json"),
                        ("candidatos", f"candidate/candidates-electionId=1-territoryId={tid}-organId={oid}.json")):
            data = get(p)
            if not data:
                continue
            _, n = register(con, url=base + p, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"),
                            content=json.dumps(data, ensure_ascii=False, indent=1).encode(), mime="application/json",
                            titulo=f"Autárquicas {src['eleicao']}: {kind} {key} {' / '.join(path)}",
                            found_on=src["url"], link_text=f"{kind} {key}", date_hint=str(src["eleicao"]),
                            meta={"tipo_fonte": "sgmai", "orgao": key, "eleicao": str(src["eleicao"]), "conteudo": kind})
            new += n
    end_crawl(con, crawl_id, paginas=len(wanted) * 2, novos=new)
    log(f"  {src['id']}: {new} ficheiros de resultados novos")


INE_URL = "https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd={var}&Dim1=S7A{ano}&Dim2={geo}&lang=PT"


def run_ine(con, f, src, aut, receita):
    """População residente (Censos). Se a API não responder, fica registado para preencher à mão."""
    crawl_id, t0 = start_crawl(con, src, aut)
    geo = receita.get("dicofre")
    new = 0
    for ano, var in ((2021, "0011609"), (2011, "0011609")):
        url = INE_URL.format(var=var, ano=ano, geo=geo)
        r = f.get(url)
        if r is None or r.status_code != 200 or "Dados" not in r.text:
            continue
        _, n = register(con, url=url, fonte=src["id"], autarquia=aut, unidade=src.get("unidade"),
                        content=r.content, mime="application/json", titulo=f"INE: população residente {ano}",
                        found_on="https://www.ine.pt", link_text=f"População {ano}", date_hint=f"{ano}-04-19",
                        meta={"tipo_fonte": "ine", "ano": ano})
        new += n
    end_crawl(con, crawl_id, paginas=2, novos=new, nota=None if new else "API do INE não respondeu; preencher população à mão")
    log(f"  {src['id']}: {new} ficheiros do INE")

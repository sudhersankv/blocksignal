import os, sys, json, requests
from datetime import datetime, timedelta
from elasticsearch import Elasticsearch, helpers
from mistralai import Mistral

ES_URL = os.environ["ES_URL"]
ES_API_KEY = os.environ["ES_API_KEY"]
MISTRAL_API_KEY = os.environ["MISTRAL_API_KEY"]

es = Elasticsearch(ES_URL, api_key=ES_API_KEY)
mistral = Mistral(api_key=MISTRAL_API_KEY)
MODEL = os.environ.get("MISTRAL_MODEL", "mistral-large-latest")
VAC, BIZ, OPS = "vacant-spaces", "sf-businesses", "sf-311"
HELP = ["Encampments", "Encampment", "Well-Being Check"]
NAICS3 = {"722": "restaurants/cafes", "311": "food production (bakeries)", "445": "grocery/food stores",
          "812": "salons/personal services", "448": "clothing", "458": "clothing", "446": "pharmacy/health store",
          "456": "pharmacy/health store", "713": "fitness/recreation", "541": "professional services",
          "531": "real estate", "621": "health care", "611": "education", "459": "misc retail",
          "453": "misc retail", "451": "books/hobby", "711": "arts/entertainment"}


def neighborhoods():
    r = es.search(index=VAC, size=0, aggs={"n": {"terms": {"field": "neighborhood", "size": 50}}})
    return [b["key"] for b in r["aggregations"]["n"]["buckets"]]


def street_conditions(loc):
    try:
        r = es.search(index=OPS, size=0,
            query={"geo_distance": {"distance": "300m", "location": loc}},
            aggs={"by_type": {"terms": {"field": "service", "size": 6}}})
        return {b["key"]: b["doc_count"] for b in r["aggregations"]["by_type"]["buckets"]}
    except Exception:
        return {}


def block_gap(neighborhood, keywords, naics_prefixes, n=25):
    spaces = es.search(index=VAC, size=n, query={"term": {"neighborhood": neighborhood}})["hits"]["hits"]
    same_type = {"bool": {"minimum_should_match": 1, "should":
        [{"match": {"dba_name": " ".join(keywords)}}] +
        [{"prefix": {"naics": p}} for p in naics_prefixes]}}
    out = []
    for s in spaces:
        loc = s["_source"]["location"]
        r = es.search(index=BIZ, size=0,
            query={"geo_distance": {"distance": "300m", "location": loc}},
            aggs={"same_type": {"filter": same_type, "aggs": {"examples": {"top_hits": {
                      "size": 3, "_source": ["dba_name"]}}}},
                  "mix": {"terms": {"field": "naics3", "size": 8}},
                  "corridor": {"terms": {"field": "corridor", "size": 1}}})
        a = r["aggregations"]
        out.append({
            "address": s["_source"]["address"], "location": loc,
            "businesses_within_300m": r["hits"]["total"]["value"],
            "same_type_within_300m": a["same_type"]["doc_count"],
            "same_type_examples": [h["_source"]["dba_name"] for h in a["same_type"]["examples"]["hits"]["hits"]],
            "nearby_mix": {NAICS3.get(b["key"], b["key"]): b["doc_count"] for b in a["mix"]["buckets"]},
            "corridor": (a["corridor"]["buckets"] or [{"key": None}])[0]["key"],
            "street_conditions_300m": street_conditions(loc)})
    out.sort(key=lambda x: (x["same_type_within_300m"], -x["businesses_within_300m"]))
    return out[:10]


def hotspots(neighborhood):
    r = es.search(index=OPS, size=0, query={"bool": {"filter": [
            {"term": {"neighborhood": neighborhood}}, {"terms": {"service": HELP}}]}},
        aggs={"hotspots": {"geotile_grid": {"field": "location", "precision": 16, "size": 5},
                "aggs": {"center": {"geo_centroid": {"field": "location"}},
                         "outcomes": {"terms": {"field": "notes.raw", "size": 5}}}}})
    return [{"reports": b["doc_count"], "center": b["center"]["location"],
             "crew_outcomes": {o["key"]: o["doc_count"] for o in b["outcomes"]["buckets"]}}
            for b in r["aggregations"]["hotspots"]["buckets"]]


def ask_json(system, user):
    r = mistral.chat.complete(model=MODEL, response_format={"type": "json_object"},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
    return json.loads(r.choices[0].message.content)


def parse(question):
    return ask_json(
        "Turn the user's request into JSON with: business_type (English), "
        "name_keywords (6-10 words likely to appear in SF business names for this type, in English plus "
        "Spanish/Chinese/Vietnamese/Filipino where relevant), "
        "naics_prefixes (2-4 NAICS code prefixes, e.g. '311811', '722515'), "
        f"neighborhood (pick exactly one from: {neighborhoods()}), "
        "language (the language the user wrote in).", question)


def explain(question, prefs, spaces):
    return ask_json(
        f"You help people open small businesses in San Francisco. The user wants a {prefs['business_type']}. "
        "These are storefronts reported vacant in the latest SF Commercial Vacancy Tax filing, with what is "
        "within 300m, plus recent 311 street-condition reports nearby. Pick the best 3: few or zero same-type "
        "competitors but an active block. Mention street conditions neutrally. Use ONLY the numbers given. "
        f"Reply in {prefs['language']} as JSON: summary, top3 [address, why, competitors_nearby, "
        "what_the_block_is_missing, street_conditions].",
        f"Question: {question}\nData: {json.dumps(spaces)}")


def brief(neighborhood, spots):
    return ask_json(
        "You write briefings for SF outreach charities and the Mayor's Office. Using ONLY this data "
        f"(block-level 311 well-being and encampment reports in {neighborhood}, with crew status notes), "
        "say where help is most needed and what the crew notes suggest. Focus on services, never "
        "enforcement. Never invent numbers. JSON: summary, priority_areas [location, reports, "
        "what_notes_suggest, suggested_action].", json.dumps(spots))


def blockgap_json(question):
    prefs = parse(question)
    spaces = block_gap(prefs["neighborhood"], prefs["name_keywords"], prefs["naics_prefixes"])
    return {"parsed": prefs, "spaces": spaces, "answer": explain(question, prefs, spaces)}


def outreach_json(neighborhood):
    spots = hotspots(neighborhood)
    return {"neighborhood": neighborhood, "spots": spots, "brief": brief(neighborhood, spots)}


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "outreach":
        res = outreach_json(" ".join(a[1:]) or "Tenderloin")
        print("ELASTIC HOTSPOTS:", json.dumps(res["spots"], indent=2))
        print("MISTRAL BRIEFING:", json.dumps(res["brief"], ensure_ascii=False, indent=2))
    else:
        res = blockgap_json(" ".join(a) or "I want to open a South Indian coffee shop in the Mission")
        print("MISTRAL PARSED:", json.dumps(res["parsed"], ensure_ascii=False, indent=2))
        print("ELASTIC TOP GAPS:", json.dumps(res["spaces"][:3], indent=2))
        print("MISTRAL ANSWER:", json.dumps(res["answer"], ensure_ascii=False, indent=2))

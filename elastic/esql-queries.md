# BlockSignal demo queries (Kibana Dev Tools)

Paste these into **Dev Tools > Console**. Indices: `sf311-encampments` (reports) and `sf-pitstops` (help locations).

## 1. Hotspot grid with outcome mix (ES|QL, geo)

```
POST /_query?format=txt
{
  "query": """
FROM sf311-encampments
| WHERE location IS NOT NULL AND requested >= NOW() - 7 days AND district == "6"
| EVAL cell_lat = FLOOR(ST_Y(location) / 0.003) * 0.003, cell_lon = FLOOR(ST_X(location) / 0.004) * 0.004
| STATS reports = COUNT(*),
        centroid = ST_CENTROID_AGG(location),
        declined = SUM(CASE(outcome == "declined", 1, 0)),
        not_found = SUM(CASE(outcome == "not_found", 1, 0)),
        neighborhoods = VALUES(neighborhood)
  BY cell_lat, cell_lon
| SORT reports DESC
| LIMIT 10
"""
}
```

## 2. Week-over-week trend by neighborhood (ES|QL)

```
POST /_query?format=txt
{
  "query": """
FROM sf311-encampments
| WHERE requested >= NOW() - 14 days AND neighborhood IS NOT NULL
| EVAL is_last7 = CASE(requested >= NOW() - 7 days, 1, 0),
       is_prev7 = CASE(requested <  NOW() - 7 days, 1, 0)
| STATS last7 = SUM(is_last7), prev7 = SUM(is_prev7) BY neighborhood
| EVAL delta = last7 - prev7, pct = ROUND(100.0 * delta / GREATEST(prev7, 1), 1)
| SORT delta DESC
| LIMIT 15
"""
}
```

## 3. Nearest Pit Stops to a hotspot, open at 9pm (ES|QL, ST_DISTANCE)

```
POST /_query?format=txt
{
  "query": """
FROM sf-pitstops
| EVAL distance_m = ROUND(ST_DISTANCE(location, TO_GEOPOINT("POINT(-122.4128 37.7835)")))
| EVAL minute = 1260
| EVAL open_now = CASE(hours.is24h == true, true,
                       hours.overnight == true, minute >= hours.open_min OR minute < hours.close_min,
                       minute >= hours.open_min AND minute < hours.close_min)
| KEEP name, address, hoursRaw, open_now, distance_m
| SORT distance_m
| LIMIT 5
"""
}
```

## 4. Semantic search on crew notes (semantic_text + Mistral embeddings)

```
POST /_query?format=txt
{
  "query": """
FROM sf311-encampments METADATA _score
| WHERE MATCH(notes_semantic, "person refused shelter and services")
| KEEP requested, address, neighborhood, outcome, notes, _score
| SORT _score DESC
| LIMIT 10
"""
}
```

Here's the same search in Query DSL:

```
GET sf311-encampments/_search
{
  "size": 5,
  "_source": ["address", "neighborhood", "outcome", "notes"],
  "query": { "semantic": { "field": "notes_semantic", "query": "medical emergency, ambulance needed" } }
}
```

## 5. Outcome mix per district (aggregation)

```
POST /_query?format=txt
{
  "query": """
FROM sf311-encampments
| WHERE requested >= NOW() - 30 days
| STATS reports = COUNT(*) BY district, outcome
| SORT district, reports DESC
"""
}
```

## 6. Hotspots via Query DSL (geotile_grid + geo_centroid), as the app uses them

```
GET sf311-encampments/_search
{
  "size": 0,
  "query": { "bool": { "filter": [
    { "term": { "district": "6" } },
    { "range": { "requested": { "gte": "now-7d/d" } } }
  ] } },
  "aggs": {
    "tiles": {
      "geotile_grid": { "field": "location", "precision": 17, "size": 20 },
      "aggs": { "centroid": { "geo_centroid": { "field": "location" } } }
    }
  }
}
```

## 7. Service gap: busy cells with no Pit Stop within 800 m (geo_distance)

Take a hotspot centroid from query 1 or 6, then run:

```
GET sf-pitstops/_search
{
  "size": 3,
  "_source": ["name", "hoursRaw"],
  "query": { "geo_distance": { "distance": "800m", "location": { "lat": 37.7835, "lon": -122.4128 } } },
  "sort": [{ "_geo_distance": { "location": { "lat": 37.7835, "lon": -122.4128 }, "order": "asc", "unit": "m" } }]
}
```

If there are zero hits, that cell is a **service gap**. Pitch it as "complaints are not need".

## Setup checks

```
GET _inference/text_embedding/mistral-embeddings
GET sf311-encampments/_mapping
GET sf311-encampments/_count
GET sf-pitstops/_count
```

On 9.1+ you can try the tech-preview grid functions instead of FLOOR math:
`EVAL tile = ST_GEOTILE(location, 17) | STATS reports = COUNT(*) BY tile`.

// BlockSignal Shop Opener sample answer. Used when the server is in mock mode, or with ?mockshop=1.
// Same shape as GET /api/blockgap (server/py/blockgap.py blockgap_json). Sample numbers, not real filings.
// Locations deliberately use different Elasticsearch geo_point forms so the front end's parser is exercised.
(function () {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const MISSION = {
    parsed: {
      business_type: "South Indian coffee shop",
      name_keywords: ["coffee", "cafe", "café", "dosa", "chai", "filter coffee", "madras", "idli", "cafetería"],
      naics_prefixes: ["722515", "722513", "7225"],
      neighborhood: "Mission",
      language: "English",
    },
    spaces: [
      { address: "2798 Mission St", location: { lat: 37.75262, lon: -122.41855 }, businesses_within_300m: 214, same_type_within_300m: 0, same_type_examples: [],
        nearby_mix: { "restaurants/cafes": 61, "misc retail": 34, "salons/personal services": 22, "grocery/food stores": 17, "professional services": 14, clothing: 9 },
        corridor: "Mission Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 48, Encampments: 11, "Graffiti": 9, "Damaged Property": 3 } },
      { address: "3109 24th St", location: [-122.41958, 37.75226], businesses_within_300m: 187, same_type_within_300m: 1, same_type_examples: ["Philz Coffee"],
        nearby_mix: { "restaurants/cafes": 55, "misc retail": 29, "salons/personal services": 18, "grocery/food stores": 15, "arts/entertainment": 8 },
        corridor: "24th Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 39, Encampments: 7, "Graffiti": 12 } },
      { address: "2889 Mission St", location: "37.75093,-122.41822", businesses_within_300m: 162, same_type_within_300m: 1, same_type_examples: ["La Taza Café"],
        nearby_mix: { "restaurants/cafes": 44, "misc retail": 27, "grocery/food stores": 19, "salons/personal services": 16, "health care": 7 },
        corridor: "Mission Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 41, Encampments: 9, "Graffiti": 6 } },
      { address: "3250 24th St", location: { type: "Point", coordinates: [-122.42063, 37.75203] }, businesses_within_300m: 140, same_type_within_300m: 3, same_type_examples: ["Haus Coffee", "Ritual Coffee", "Café La Bohème"],
        nearby_mix: { "restaurants/cafes": 39, "misc retail": 21, "salons/personal services": 12 },
        corridor: "24th Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 22, Encampments: 3 } },
      { address: "2700 Mission St", location: "POINT (-122.41878 37.75355)", businesses_within_300m: 198, same_type_within_300m: 4, same_type_examples: ["Café de Olla", "Coffee Bar", "Muddy's"],
        nearby_mix: { "restaurants/cafes": 58, "misc retail": 31, "grocery/food stores": 14 },
        corridor: "Mission Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 52, Encampments: 14, "Graffiti": 10 } },
    ],
    answer: {
      summary: "Three vacant storefronts near 24th & Mission look strong for a South Indian coffee shop. Each has a busy block with many restaurants and shops, but almost no coffee shops within 300 m, and none serving South Indian coffee or snacks.",
      top3: [
        { address: "2798 Mission St", why: "Right by the 24th St BART plaza, with 214 businesses within 300 m and heavy foot traffic.", competitors_nearby: "0 coffee shops within 300 m.",
          what_the_block_is_missing: "A sit-down coffee shop. The block has 61 restaurants and cafes, but none focused on coffee, and no South Indian food.", street_conditions: "48 street cleaning and 11 encampment reports within 300 m recently, typical for a busy transit corner." },
        { address: "3109 24th St", why: "On the 24th Street corridor with 187 businesses within 300 m and many food shops that draw visitors.", competitors_nearby: "1 coffee shop within 300 m (Philz Coffee).",
          what_the_block_is_missing: "A breakfast and snack option beyond tacos and pastries; no dosa or idli places nearby.", street_conditions: "39 street cleaning and 7 encampment reports within 300 m." },
        { address: "2889 Mission St", why: "Steady Mission Street traffic with 162 businesses within 300 m and 19 grocery stores that bring daily shoppers.", competitors_nearby: "1 cafe within 300 m (La Taza Café).",
          what_the_block_is_missing: "A coffee shop with seating for people between errands.", street_conditions: "41 street cleaning and 9 encampment reports within 300 m." },
      ],
    },
  };

  const EXCELSIOR = {
    parsed: {
      business_type: "Mexican bakery",
      name_keywords: ["panaderia", "panadería", "bakery", "pan dulce", "pasteleria", "conchas", "bread", "bánh"],
      naics_prefixes: ["311811", "445291", "722515"],
      neighborhood: "Excelsior",
      language: "Spanish",
    },
    spaces: [
      { address: "4688 Mission St", location: { lat: 37.72652, lon: -122.43566 }, businesses_within_300m: 118, same_type_within_300m: 0, same_type_examples: [],
        nearby_mix: { "restaurants/cafes": 27, "salons/personal services": 21, "misc retail": 19, "grocery/food stores": 11 },
        corridor: "Mission Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 31, Encampments: 2, "Graffiti": 8 } },
      { address: "4791 Mission St", location: [-122.43664, 37.72531], businesses_within_300m: 104, same_type_within_300m: 1, same_type_examples: ["Excelsior Bakery"],
        nearby_mix: { "restaurants/cafes": 22, "salons/personal services": 18, "misc retail": 15 },
        corridor: "Mission Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 27, "Graffiti": 5 } },
      { address: "4500 Mission St", location: "37.72902,-122.43301", businesses_within_300m: 96, same_type_within_300m: 1, same_type_examples: ["Pan Lido"],
        nearby_mix: { "restaurants/cafes": 19, "misc retail": 17, "health care": 9 },
        corridor: "Mission Street", street_conditions_300m: { "Street and Sidewalk Cleaning": 22, Encampments: 1 } },
    ],
    answer: {
      summary: "Tres locales vacíos en Mission Street, en el Excelsior, son buenos para una panadería mexicana. Las cuadras tienen mucho comercio y casi ninguna panadería a menos de 300 m.",
      top3: [
        { address: "4688 Mission St", why: "Cuadra activa con 118 negocios a menos de 300 m.", competitors_nearby: "0 panaderías a menos de 300 m.",
          what_the_block_is_missing: "Pan dulce fresco por la mañana; hay 27 restaurantes pero ninguna panadería.", street_conditions: "31 reportes de limpieza y 2 de campamentos a menos de 300 m." },
        { address: "4791 Mission St", why: "104 negocios cerca y mucho paso de peatones hacia Geneva Ave.", competitors_nearby: "1 panadería (Excelsior Bakery).",
          what_the_block_is_missing: "Una panadería mexicana con café para llevar.", street_conditions: "27 reportes de limpieza a menos de 300 m." },
        { address: "4500 Mission St", why: "96 negocios cerca y clínicas que traen visitantes todo el día.", competitors_nearby: "1 panadería (Pan Lido).",
          what_the_block_is_missing: "Un lugar para desayunar algo rápido.", street_conditions: "22 reportes de limpieza y 1 de campamentos a menos de 300 m." },
      ],
    },
  };

  window.BS_SHOP_MOCK = {
    async blockgap(q) {
      await wait(6500); // the real engine takes 10-40 s; long enough here to see the progress steps
      const spanish = /\b(quiero|abrir|panader|tienda|negocio|excelsior)/i.test(q || "");
      return JSON.parse(JSON.stringify(spanish ? EXCELSIOR : MISSION));
    },
  };
})();

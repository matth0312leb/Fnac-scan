// Serveur de l'appli « Scan produit » (Cloudflare Worker, offre gratuite)
// Adresses :
//   /test?ean=...     diagnostic : montre ce que chaque site répond
//   /livre?isbn=...   fiche livre (BnF, swisscovery, Google Books, Open Library) + résumé IA
//   /produit?ean=...  fiche produit (base de codes-barres UPCitemdb) + résumé IA pour conseiller
//   /comparer?a=...&b=...  comparaison de 2 articles par l'IA
//   POST /photo {image: dataURL}  identification par photo (couverture / boîte) avec l'IA vision
//   Jeux vidéo : /produit détecte un jeu et ajoute les infos Wikidata (PEGI, sortie, modes, genre, plateformes, studio)
// Les sites Fnac ne sont pas interrogés : leur anti-robot bloque le serveur (403, testé le 30.10.2026).

const SITE = "https://matth0312leb.github.io";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const HDRS = { "User-Agent": UA, "Accept": "application/json,application/xml,text/xml;q=0.9,*/*;q=0.8", "Accept-Language": "fr-CH,fr;q=0.9" };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin === SITE ? SITE : "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const code = (url.searchParams.get("ean") || url.searchParams.get("isbn") || "").replace(/\D/g, "");
    const send = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: cors });
    // cache Cloudflare : un même code n'est recalculé qu'une fois par jour (économise le quota IA)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (/^\/(livre|produit|comparer)$/.test(url.pathname)) {
      const hit = await cache.match(cacheKey);
      if (hit) { const r = new Response(hit.body, hit); r.headers.set("Access-Control-Allow-Origin", cors["Access-Control-Allow-Origin"]); return r; }
    }
    const sendCache = async (o, ctx) => {
      const r = send(o);
      if (o && o.trouve) { const c = r.clone(); c.headers.set("Cache-Control", "public, max-age=86400"); await cache.put(cacheKey, c); }
      return r;
    };
    try {
      if (url.pathname === "/photo" && req.method === "POST") {
        let body; try { body = await req.json(); } catch (e) { return send({ trouve: false, erreur: "image attendue" }, 400); }
        return send(await photo(String(body.image || ""), env));
      }
      if (url.pathname === "/livre") return await sendCache(await livre(code, env));
      if (url.pathname === "/produit") return await sendCache(await produit(code, env));
      if (url.pathname === "/comparer") {
        const a = (url.searchParams.get("a") || "").replace(/\D/g, ""), b = (url.searchParams.get("b") || "").replace(/\D/g, "");
        return await sendCache(await comparer(a, b, env));
      }
      if (url.pathname === "/test") return send(await diagnostic(code));
      return send({ ok: true, message: "Serveur Scan produit en ligne. Essaie /test?ean=9782070612758" });
    } catch (e) {
      return send({ ok: false, erreur: String(e && e.message || e) }, 500);
    }
  },
};

// ---------- outils ----------
async function get(u, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 9000);
  try {
    const r = await fetch(u, { headers: Object.assign({}, HDRS, opts.headers || {}), redirect: "follow", signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, url: r.url, text };
  } catch (e) {
    return { status: 0, url: u, text: "", err: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}
const strip = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'")
  .replace(/&quot;/g, '"').replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/<<|>>/g, "").replace(/[ \t]+/g, " ").trim();

// ---------- sources ----------
async function bnf(isbn) {
  const q = encodeURIComponent('bib.isbn all "' + isbn + '"');
  const r = await get("https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=dublincore&maximumRecords=1&query=" + q);
  if (r.status !== 200) return { trouve: false, status: r.status };
  const all = (tag) => [...r.text.matchAll(new RegExp("<dc:" + tag + "[^>]*>([\\s\\S]*?)</dc:" + tag + ">", "g"))].map((m) => strip(m[1]));
  const titre = all("title")[0];
  if (!titre) return { trouve: false, status: 200 };
  const fmt = all("format").join(" ");
  const pers = (s) => { s = s.replace(/\s*\(.*$/, "").replace(/\.\s.*$/, "").trim(); const p = s.split(/,\s*/); return p.length === 2 ? p[1] + " " + p[0] : s; };
  return {
    trouve: true,
    titre: titre.split(" / ")[0].replace(/\s*\[.*?\]\s*/g, " ").trim(),
    auteur: all("creator").map(pers).filter(Boolean).slice(0, 3).join(", "),
    editeur: (all("publisher")[0] || "").replace(/\s*\(.*\)\s*$/, "").replace(/^.*:\s*/, ""),
    date: all("date")[0] || "",
    pages: (fmt.match(/(\d+)\s*p/) || [])[1] || "",
    sujets: all("subject").join(" ; "),
  };
}

// Catalogue des bibliothèques suisses (swisscovery / SLSP), format MARC
async function suisse(isbn) {
  const r = await get("https://swisscovery.slsp.ch/view/sru/41SLSP_NETWORK?version=1.2&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=1&query=alma.isbn%3D" + isbn);
  if (r.status !== 200) return { trouve: false, status: r.status };
  const champ = (tag, code) => {
    const out = [];
    const re = new RegExp('<datafield[^>]*tag="' + tag + '"[^>]*>([\\s\\S]*?)</datafield>', "g");
    let m;
    while ((m = re.exec(r.text))) {
      const sm = m[1].match(new RegExp('<subfield code="' + code + '">([\\s\\S]*?)</subfield>'));
      if (sm) out.push(strip(sm[1]).replace(/\s*[\/:;,.]\s*$/, ""));
    }
    return out;
  };
  const titre = champ("245", "a")[0];
  if (!titre) return { trouve: false, status: 200 };
  const sous = champ("245", "b")[0];
  const auteur = champ("100", "a").concat(champ("700", "a")).slice(0, 3).map((s) => { const p = s.split(/,\s*/); return p.length === 2 ? p[1] + " " + p[0] : s; });
  return {
    trouve: true,
    titre: titre + (sous ? " – " + sous : ""),
    auteur: auteur.join(", "),
    editeur: champ("264", "b")[0] || champ("260", "b")[0] || "",
    date: champ("264", "c")[0] || champ("260", "c")[0] || "",
    pages: ((champ("300", "a")[0] || "").match(/(\d+)\s*(p|S)/) || [])[1] || "",
    description: champ("520", "a").join(" "),
    public: champ("521", "a")[0] || "",
    sujets: champ("650", "a").concat(champ("655", "a")).join(" ; "),
  };
}

async function google(isbn) {
  const r = await get("https://www.googleapis.com/books/v1/volumes?q=isbn:" + isbn);
  if (r.status !== 200) return { trouve: false, status: r.status };
  let j; try { j = JSON.parse(r.text); } catch (e) { return { trouve: false }; }
  const v = j.items && j.items[0] && j.items[0].volumeInfo;
  if (!v) return { trouve: false, status: 200 };
  return {
    trouve: true, titre: v.title + (v.subtitle ? " – " + v.subtitle : ""), auteur: (v.authors || []).join(", "),
    editeur: v.publisher || "", date: v.publishedDate || "", pages: v.pageCount || "",
    genre: (v.categories || []).join(", "), description: strip(v.description || ""),
    image: (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail) || "").replace("http://", "https://"),
  };
}

async function openlib(isbn) {
  const r = await get("https://openlibrary.org/api/books?bibkeys=ISBN:" + isbn + "&format=json&jscmd=data");
  if (r.status !== 200) return { trouve: false, status: r.status };
  let j; try { j = JSON.parse(r.text); } catch (e) { return { trouve: false }; }
  const v = j["ISBN:" + isbn];
  if (!v) return { trouve: false, status: 200 };
  return {
    trouve: true, titre: v.title, auteur: (v.authors || []).map((a) => a.name).join(", "),
    editeur: (v.publishers || []).map((x) => x.name).join(", "), date: v.publish_date || "",
    pages: v.number_of_pages || "", image: v.cover && (v.cover.medium || v.cover.small) || "",
  };
}

// ---------- routes ----------
async function diagnostic(code) {
  if (!code) return { erreur: "ajoute ?ean=..." };
  const [b, g, o, s, u] = await Promise.all([bnf(code), google(code), openlib(code), suisse(code), upc(code)]);
  const w = u.trouve ? await wikidataJeu(titreJeu(u.nom)) : { trouve: false };
  const [u1, opf, web, tp] = await Promise.all([upcUn(code), openProducts(code), webNom(code, true), toppreise(code)]);
  const etat = (x) => x.trouve ? "OK" : "rien (" + (x.status || x.err || "?") + ")";
  return {
    code,
    resume: { BnF: etat(b), swisscovery: etat(s), "Google Books": etat(g), "Open Library": etat(o), "Produits (UPCitemdb / Open Products Facts / web)": u.trouve ? "OK via " + (u.source || "UPCitemdb") + " : " + u.nom : etat(u), "Wikidata (jeux)": u.trouve ? etat(w) + " — recherche : " + titreJeu(u.nom) + (estJeu(u) ? " (détecté comme jeu)" : " (pas détecté comme jeu)") : "non testé" },
    toppreise: tp.trouve ? "Fnac trouvé : CHF " + tp.prix_fnac : (tp.status === 200 ? (tp.fnac_present ? "Fnac mentionné" : "page OK, Fnac absent") : "rien / bloqué (" + tp.status + ")"),
    details: { toppreise: tp, bnf: b, swisscovery: s, google: g, openlibrary: o, produit_final: u, upcitemdb_seul: u1, open_products_facts: opf, web: web, wikidata: w },
  };
}

async function livre(isbn, env) {
  if (!/^\d{13}$/.test(isbn)) return { trouve: false, erreur: "ISBN à 13 chiffres attendu" };
  const [b, g, o, s] = await Promise.all([bnf(isbn), google(isbn), openlib(isbn), suisse(isbn)]);
  const pick = (...v) => v.find((x) => x && String(x).trim()) || "";
  const fiche = {
    trouve: !!(b.trouve || g.trouve || o.trouve || s.trouve),
    titre: pick(b.titre, s.titre, g.titre, o.titre),
    auteur: pick(b.auteur, s.auteur, g.auteur, o.auteur),
    editeur: pick(b.editeur, s.editeur, g.editeur, o.editeur),
    date: pick(g.date, b.date, s.date, o.date),
    pages: pick(b.pages, s.pages, g.pages, o.pages),
    genre: pick(g.genre),
    age: pick(s.public),
    image: pick(g.image, o.image),
    description: pick(s.description, g.description),
    sources: { BnF: b.trouve, swisscovery: s.trouve, Google: g.trouve, OpenLibrary: o.trouve },
  };
  if (fiche.trouve && env && env.AI) fiche.ia = await resumeIA(env, fiche, [b.sujets, s.sujets].filter(Boolean).join(" ; "));
  return fiche;
}

async function demanderIA(env, consigne, infos, maxTokens) {
  if (!env || !env.AI) return null;
  for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"]) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: "system", content: consigne }, { role: "user", content: infos }], max_tokens: maxTokens || 300 });
      if (r && typeof r.response === "object" && r.response) return r.response;
      const txt = String(r && r.response || "");
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch (e) {}
  }
  return null;
}

function infosLivre(f, sujets) {
  return [
    "Titre : " + f.titre, f.auteur && "Auteur : " + f.auteur, f.editeur && "Éditeur : " + f.editeur,
    f.date && "Parution : " + f.date, f.pages && "Pages : " + f.pages, f.genre && "Genre : " + f.genre,
    sujets && "Sujets (catalogues de bibliothèques) : " + sujets, f.age && "Âge indiqué : " + f.age,
    f.description && "Texte de l'éditeur : " + f.description.slice(0, 1200),
  ].filter(Boolean).join("\n");
}

async function resumeIA(env, f, sujets) {
  const consigne = "Tu aides un libraire de la Fnac à renseigner un client en 10 secondes. À partir UNIQUEMENT des infos fournies, réponds en français, en JSON strict sans texte autour : " +
    '{"resume":"2 phrases maximum, sans spoiler","sujet":"de quoi ou de qui parle le livre, quelques mots","public":"âge ou public conseillé, ex. Dès 6 ans, Ados, Adultes"}. ' +
    "Si une info manque, déduis-la prudemment du genre et des sujets ; si c'est impossible, mets une chaîne vide. N'invente pas d'intrigue.";
  return demanderIA(env, consigne, infosLivre(f, sujets), 300);
}

// ---------- produits (hors livres) ----------
async function upc(ean) {
  if (!/^\d{8,14}$/.test(ean)) return { trouve: false };
  let res = await upcUn(ean);
  // les codes américains sont souvent enregistrés sur 12 chiffres, sans le 0 du début
  if (!res.trouve && res.status !== 429 && /^0\d{12}$/.test(ean)) res = await upcUn(ean.slice(1));
  if (!res.trouve) { const o = await openProducts(ean); if (o.trouve) return o; }
  if (!res.trouve) { const d = await webNom(ean); if (d.trouve) return d; }
  return res;
}

// Base libre Open Products Facts (produits non alimentaires)
async function openProducts(ean) {
  const r = await get("https://world.openproductsfacts.org/api/v2/product/" + ean + ".json?fields=product_name,product_name_fr,brands,categories,image_front_url");
  if (r.status !== 200) return { trouve: false, status: r.status };
  let j; try { j = JSON.parse(r.text); } catch (e) { return { trouve: false }; }
  const p = j.product; const nom = p && (p.product_name_fr || p.product_name);
  if (!nom) return { trouve: false, status: 200 };
  return { trouve: true, source: "Open Products Facts", nom, marque: p.brands || "", modele: "", categorie: p.categories || "", description: "", image: p.image_front_url || "" };
}

// Recherche web du code-barres via Bing (DuckDuckGo retiré : il bloque le serveur, testé le 30.10.2026)
function nettoieTitres(titres, ean) {
  const propre = (t) => t.replace(/\s*[|\-–—]\s*(amazon|ebay|fnac|digitec|galaxus|manor|interdiscount|media ?markt|darty|boulanger|idealo|brack|apple|google|toppreise|ricardo|microspot|conforama|cdiscount|rakuten|walmart|best ?buy)[^|]*$/i, "")
    .replace(/\b(acheter|achat|kaufen|buy|prix|preis|price|en stock|livraison)\b.*$/i, "").replace(new RegExp(ean, "g"), "")
    .replace(/\b(EAN|GTIN|UPC|code[- ]barres?|barcode)\b\s*:?/gi, "").replace(/\s+/g, " ").trim();
  return titres.map(propre).filter((t) => t.length > 6 && !/^(r[ée]sultats?|results?|search|recherche)/i.test(t));
}
async function webMoteur(nom, url, re, ean) {
  const r = await get(url, { timeout: 6000, headers: { "Accept": "text/html", "Accept-Language": "fr-CH,fr;q=0.9,en;q=0.7" } });
  const titres = [...r.text.matchAll(re)].map((m) => strip(m[1])).slice(0, 8);
  const noms = nettoieTitres(titres, ean);
  return { moteur: nom, status: r.status, nbResultats: titres.length, noms: noms.slice(0, 5),
    apercu: noms.length ? undefined : strip(r.text).slice(0, 160) };
}
async function webNom(ean, detail) {
  const essais = [
    () => webMoteur("Bing", "https://www.bing.com/search?setlang=fr&cc=CH&q=" + ean, /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g, ean),
  ];
  const traces = [];
  for (const essai of essais) {
    const t = await essai(); traces.push(t);
    if (t.noms.length) {
      const res = { trouve: true, source: "recherche web (" + t.moteur + ")", nom: t.noms[0], marque: "", modele: "", categorie: "",
        description: "Titres trouvés en ligne pour ce code : " + t.noms.join(" / "), image: "" };
      if (detail) res.traces = traces;
      return res;
    }
  }
  return { trouve: false, status: traces.map((t) => t.moteur + " " + t.status + " (" + t.nbResultats + " résultats)").join(", "), traces };
}

async function upcUn(ean) {
  const r = await get("https://api.upcitemdb.com/prod/trial/lookup?upc=" + ean);
  if (r.status !== 200) return { trouve: false, status: r.status };
  let j; try { j = JSON.parse(r.text); } catch (e) { return { trouve: false }; }
  const it = j.items && j.items[0];
  if (!it || !it.title) return { trouve: false, status: 200 };
  return {
    trouve: true, nom: it.title, marque: it.brand || "", modele: it.model || "",
    categorie: it.category || "", description: strip(it.description || "").slice(0, 1200),
    image: (it.images || []).find((x) => /^https:/.test(x)) || (it.images || [])[0] || "",
  };
}

// ---------- jeux vidéo ----------
const PLATEFORMES = /\b(ps5|ps4|ps3|playstation\s*[345]?|xbox(\s*(series\s*[xs]|one|360))?|nintendo\s*switch(\s*2)?|switch(\s*2)?|wii\s*u?|3ds|pc\s*dvd|pc)\b/i;
function estJeu(p) {
  const nom = String(p.nom || ""), t = (nom + " " + (p.categorie || "")).toLowerCase();
  if (/console|controller|manette|headset|casque|c[âa]ble|cable|charg|station|stand|support|carte|card|memory|m[ée]moire|joy-?con|steering|volant/i.test(nom)) return false;
  if (/video games/.test(t)) return true;
  return PLATEFORMES.test(nom);
}
function plateformeDe(nom) {
  const m = String(nom).match(PLATEFORMES);
  if (!m) return "";
  const s = m[0].toLowerCase();
  if (/ps5|playstation\s*5/.test(s)) return "PS5";
  if (/ps4|playstation\s*4/.test(s)) return "PS4";
  if (/switch\s*2/.test(s)) return "Nintendo Switch 2";
  if (/switch/.test(s)) return "Nintendo Switch";
  if (/series/.test(s)) return "Xbox Series X|S";
  if (/xbox\s*one/.test(s)) return "Xbox One";
  if (/pc/.test(s)) return "PC";
  return m[0];
}
function titreJeu(nom) {
  return String(nom)
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(PLATEFORMES, " ")
    .replace(/\b(sony|microsoft|nintendo|ubisoft|electronic arts|ea sports?|bandai namco|square enix|sega|capcom|take[- ]?two|2k games|warner bros\.?|activision|konami)\b/gi, " ")
    .replace(/\b(standard|deluxe|gold|ultimate|day one|launch|limited|collector'?s?|game of the year|goty|complete)\s*(edition)?\b/gi, " ")
    .replace(/\b(edition|édition|video ?game|jeu vidéo|jeu|game|for|pour|new|neuf|eu|pegi\s*\d+|fr|import)\b/gi, " ")
    .replace(/[-–—:|,]+/g, " ").replace(/\s+/g, " ").trim();
}
// Début de l'article Wikipédia (français, sinon anglais) pour que l'IA résume un vrai texte
async function extraitWikipedia(urlFr, urlEn) {
  for (const u of [urlFr, urlEn]) {
    if (!u) continue;
    const m = u.match(/^https:\/\/(fr|en)\.wikipedia\.org\/wiki\/(.+)$/);
    if (!m) continue;
    const r = await get("https://" + m[1] + ".wikipedia.org/api/rest_v1/page/summary/" + m[2],
      { timeout: 6000, headers: { "Accept": "application/json", "User-Agent": "ScanProduit/1.0 (https://matth0312leb.github.io/Fnac-scan/)" } });
    if (r.status !== 200) continue;
    try { const j = JSON.parse(r.text); if (j.extract) return { langue: m[1], texte: j.extract.slice(0, 1500) }; } catch (e) {}
  }
  return null;
}

async function wikidataJeu(titre) {
  if (!titre || titre.length < 2) return { trouve: false };
  const esc = titre.replace(/["\\]/g, " ");
  const q = `SELECT ?item ?itemLabel ?date ?pegiLabel ?modeLabel ?genreLabel ?devLabel ?platLabel ?wfr ?wen WHERE {
    SERVICE wikibase:mwapi { bd:serviceParam wikibase:api "EntitySearch"; wikibase:endpoint "www.wikidata.org";
      mwapi:search "${esc}"; mwapi:language "fr". ?item wikibase:apiOutputItem mwapi:item. ?num wikibase:apiOrdinal true. }
    ?item wdt:P31/wdt:P279* wd:Q7889.
    OPTIONAL { ?item wdt:P577 ?date. }
    OPTIONAL { ?item wdt:P908 ?pegi. }
    OPTIONAL { ?item wdt:P404 ?mode. }
    OPTIONAL { ?item wdt:P136 ?genre. }
    OPTIONAL { ?item wdt:P178 ?dev. }
    OPTIONAL { ?item wdt:P400 ?plat. }
    OPTIONAL { ?wfr schema:about ?item; schema:isPartOf <https://fr.wikipedia.org/>. }
    OPTIONAL { ?wen schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
  } ORDER BY ?num LIMIT 200`;
  const r = await get("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q),
    { timeout: 12000, headers: { "Accept": "application/sparql-results+json", "User-Agent": "ScanProduit/1.0 (https://matth0312leb.github.io/Fnac-scan/)" } });
  if (r.status !== 200) return { trouve: false, status: r.status };
  let j; try { j = JSON.parse(r.text); } catch (e) { return { trouve: false }; }
  const rows = (j.results && j.results.bindings) || [];
  if (!rows.length) return { trouve: false, status: 200 };
  const first = rows[0].item.value;
  const mine = rows.filter((x) => x.item.value === first);
  // les libellés sans traduction reviennent sous forme d'identifiant (Q123…) : on les écarte
  const uniq = (k) => [...new Set(mine.map((x) => x[k] && x[k].value).filter((v) => v && !/^Q\d+$/.test(v)))];
  const dates = uniq("date").sort();
  const pegi = uniq("pegiLabel").map((s) => (s.match(/\d+/) || [s])[0]).sort((a, b) => a - b);
  return {
    trouve: true, wikidata: first, nom: uniq("itemLabel")[0] || "",
    sortie: dates[0] ? dates[0].slice(0, 10) : "",
    pegi: pegi.length ? "PEGI " + pegi[pegi.length - 1] : "",
    modes: uniq("modeLabel").join(", "), genres: uniq("genreLabel").slice(0, 3).join(", "),
    studio: uniq("devLabel").slice(0, 2).join(", "), plateformes: uniq("platLabel").slice(0, 6).join(", "),
    wikipedia: await extraitWikipedia(uniq("wfr")[0], uniq("wen")[0]),
  };
}

async function produit(ean, env) {
  if (!/^\d{8,13}$/.test(ean)) return { trouve: false, erreur: "EAN attendu" };
  const p = await upc(ean);
  if (!p.trouve) return { trouve: false, sources: { UPCitemdb: p.status || false } };
  if (estJeu(p)) return await jeu(p, env);
  return await produitIA(p, env);
}

async function produitIA(p, env) {
  const infos = ["Produit : " + p.nom, p.marque && "Marque : " + p.marque, p.modele && "Modèle : " + p.modele,
    p.categorie && "Catégorie : " + p.categorie, p.description && "Description : " + p.description].filter(Boolean).join("\n");
  const consigne = "Tu aides un vendeur de la Fnac (Suisse) à conseiller un client en 10 secondes. Réponds en français, en JSON strict sans texte autour : " +
    '{"nom":"nom commercial court du produit en français","resume":"1 à 2 phrases : ce que c\'est et à quoi ça sert","forts":["point fort","point fort","point fort"],"faibles":["point faible","point faible"],"pour_qui":"type de client à qui le conseiller","alternative":"une alternative courante à proposer"}. ' +
    "Si les infos viennent de titres de pages web, déduis-en le produit exact (marque, modèle, génération). Appuie-toi sur les infos fournies et sur tes connaissances générales du produit. Si tu ne connais pas bien ce produit, reste général et prudent, n'invente pas de caractéristiques chiffrées, et laisse vide ce que tu ignores.";
  const ia = await demanderIA(env, consigne, infos, 450);
  return { trouve: true, ...p, ia, sources: { produit: p.source || "UPCitemdb" } };
}

async function jeu(p, env) {
  const titre = titreJeu(p.nom);
  const w = await wikidataJeu(titre);
  const infos = ["Jeu vidéo : " + p.nom, "Titre nettoyé : " + titre, plateformeDe(p.nom) && "Plateforme de cette boîte : " + plateformeDe(p.nom),
    w.trouve && "Wikidata – nom : " + w.nom, w.sortie && "Sortie : " + w.sortie, w.pegi && "Classification : " + w.pegi,
    w.modes && "Modes : " + w.modes, w.genres && "Genres : " + w.genres, w.studio && "Studio : " + w.studio,
    w.wikipedia && "Article Wikipédia (" + w.wikipedia.langue + ") : " + w.wikipedia.texte,
    p.description && "Description : " + p.description].filter(Boolean).join("\n");
  const consigne = "Tu aides un vendeur de la Fnac (Suisse) à renseigner un client sur un jeu vidéo en 10 secondes. Réponds en français, en JSON strict sans texte autour : " +
    '{"nom":"titre officiel du jeu","resume":"2 phrases : univers et principe du jeu, sans spoiler","genre":"genre en français, quelques mots","modes":"Solo, Multijoueur local, En ligne… (ce qui s\'applique)","pegi":"PEGI x si connu","taille":"espace disque approximatif sur cette plateforme, ex. ~50 Go, UNIQUEMENT si tu le connais avec certitude, sinon vide","duree":"durée de vie approximative si connue, ex. 30-40 h","pour_qui":"type de joueur à qui le conseiller"}. ' +
    "Les infos Wikidata et Wikipédia fournies sont fiables : appuie ton résumé et les modes de jeu sur l'article Wikipédia s'il est fourni (traduis en français). Complète avec tes connaissances seulement si tu es sûr ; sinon laisse la chaîne vide. N'invente aucun chiffre.";
  const ia = await demanderIA(env, consigne, infos, 450);
  return { trouve: true, type: "jeu", ...p, plateforme: p.plateforme || plateformeDe(p.nom), titre, jeu: w, ia, sources: { produit: p.source || "UPCitemdb", Wikidata: w.trouve || w.status || false } };
}

// ---------- identification par photo ----------
async function vision(env, image, details) {
  const question = "Tu regardes la photo d'un article vendu à la Fnac (jeu vidéo, livre, BD, film, produit high-tech…). Lis le texte visible sur la couverture ou la boîte. " +
    'Réponds UNIQUEMENT en JSON : {"type":"jeu|livre|produit","titre":"titre exact lu (jeu ou livre) ou nom du produit","plateforme":"console si jeu vidéo (PS5, Nintendo Switch…), sinon vide","marque":"marque ou éditeur","modele":"modèle si produit","auteur":"auteur si livre","pegi":"chiffre PEGI visible, sinon vide"}. N\'invente rien : laisse vide ce que tu ne lis pas.';
  const texteDe = (r) => {
    if (r == null) return "";
    if (typeof r === "string") return r;
    const v = r.response ?? r.answer ?? r.description ?? r.caption ?? r.result ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content);
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && Object.keys(v).length) return JSON.stringify(v);
    return JSON.stringify(r).slice(0, 300);
  };
  const jsonDe = (t) => {
    const m = String(t).match(/\{[\s\S]*\}/);
    try { const o = m ? JSON.parse(m[0]) : null; return o && (o.titre || o.title) ? { ...o, titre: o.titre || o.title } : null; } catch (e) { return null; }
  };
  const brut = [];
  const essai = async (nom, fn) => {
    try {
      const t = texteDe(await fn());
      if (t && t !== "{}") brut.push(t);
      details.push(nom + " : " + (t ? "« " + t.replace(/\s+/g, " ").slice(0, 100) + " »" : "réponse vide"));
      return jsonDe(t);
    } catch (e) { const m = String(e && e.message || e); details.push(nom + " : " + m.slice(0, 110)); return { erreur: m }; }
  };
  const LLAMA = "@cf/meta/llama-3.2-11b-vision-instruct";
  const sys = { role: "system", content: "Tu lis le texte des couvertures et emballages et tu réponds en JSON." };
  const formats = [
    ["llama A", () => env.AI.run(LLAMA, { messages: [sys, { role: "user", content: question }], image, max_tokens: 300 })],
    ["llama B", () => env.AI.run(LLAMA, { prompt: question, image, max_tokens: 300 })],
    ["llama C", () => env.AI.run(LLAMA, { messages: [sys, { role: "user", content: [{ type: "text", text: question }, { type: "image_url", image_url: { url: image } }] }], max_tokens: 300 })],
  ];
  let licence = false;
  for (const [nom, fn] of formats) {
    let v = await essai(nom, fn);
    if (v && v.erreur && /agree|licen/i.test(v.erreur) && !licence) {
      licence = true;
      try { await env.AI.run(LLAMA, { prompt: "agree" }); details.push("licence Meta acceptée"); } catch (e) { details.push("licence : " + String(e && e.message || e).slice(0, 80)); }
      v = await essai(nom + " (2e)", fn);
    }
    if (v && v.titre) return { ...v, modeleIA: nom };
  }
  let v = await essai("gemma", () => env.AI.run("@cf/google/gemma-3-12b-it", { messages: [{ role: "user", content: [{ type: "text", text: question }, { type: "image_url", image_url: { url: image } }] }], max_tokens: 300 }));
  if (v && v.titre) return { ...v, modeleIA: "gemma" };
  v = await essai("moondream", () => env.AI.run("@cf/moondream/moondream3.1-9B-A2B", { task: "query", image, question }));
  if (v && v.titre) return { ...v, modeleIA: "moondream" };
  await essai("moondream légende", () => env.AI.run("@cf/moondream/moondream3.1-9B-A2B", { task: "caption", image, length: "long" }));
  // une IA a décrit la photo en texte libre : on en extrait le titre avec l'IA texte
  const desc = brut.filter((t) => t && t.length > 10).join("\n");
  if (desc) {
    const o = await demanderIA(env, "Voici ce qu'une IA a lu sur la photo d'un article. Réponds UNIQUEMENT en JSON : " +
      '{"type":"jeu|livre|produit","titre":"","plateforme":"","marque":"","modele":"","auteur":"","pegi":""}. Laisse vide ce qui n\'est pas indiqué.', desc.slice(0, 2000), 200);
    if (o && (o.titre || o.title)) { details.push("titre extrait de la description"); return { ...o, titre: o.titre || o.title, modeleIA: "description" }; }
  }
  return null;
}

async function photo(image, env) {
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(image)) return { trouve: false, erreur: "image attendue (data:image/jpeg;base64,...)" };
  if (image.length > 3000000) return { trouve: false, erreur: "image trop lourde" };
  if (!env || !env.AI) return { trouve: false, erreur: "IA indisponible" };
  const details = [];
  const v = await vision(env, image, details);
  if (!v) return { trouve: false, erreur: "rien de lisible sur la photo", details };
  const type = String(v.type || "").toLowerCase();
  if (type.startsWith("jeu") || v.plateforme) {
    const p = { trouve: true, source: "photo", nom: [v.titre, v.plateforme].filter(Boolean).join(" "), marque: v.marque || "", modele: "",
      categorie: "Jeu vidéo", description: v.pegi ? "PEGI " + v.pegi + " visible sur la boîte" : "", image: "", plateforme: plateformeDe(v.plateforme || "") || v.plateforme || "" };
    const r = await jeu(p, env);
    if (v.pegi && r.jeu && !r.jeu.pegi) r.jeu.pegi = "PEGI " + v.pegi;
    if (v.marque && r.jeu && !r.jeu.studio) r.jeu.studio = v.marque;
    return { ...r, lu: v };
  }
  if (type.startsWith("livre")) {
    const infos = ["Livre (lu sur la couverture) : " + v.titre, v.auteur && "Auteur : " + v.auteur, v.marque && "Éditeur : " + v.marque].filter(Boolean).join("\n");
    const consigne = "Tu aides un libraire de la Fnac à renseigner un client en 10 secondes. Réponds en français, en JSON strict sans texte autour : " +
      '{"resume":"2 phrases maximum, sans spoiler","sujet":"de quoi ou de qui parle le livre","public":"âge ou public conseillé"}. ' +
      "Utilise tes connaissances seulement si tu reconnais ce livre avec certitude ; sinon laisse les champs vides. N'invente pas d'intrigue.";
    const ia = await demanderIA(env, consigne, infos, 300);
    return { trouve: true, type: "livre", source: "photo", titre: v.titre, auteur: v.auteur || "", editeur: v.marque || "", ia, lu: v };
  }
  const p = { trouve: true, source: "photo", nom: [v.marque, v.titre, v.modele].filter(Boolean).join(" "), marque: v.marque || "", modele: v.modele || "", categorie: "", description: "", image: "" };
  return { ...(await produitIA(p, env)), lu: v };
}

// ---------- prix via le comparateur Toppreise (essai) ----------
async function toppreise(ean) {
  const base = "https://www.toppreise.ch";
  const r = await get(base + "/produktsuche?q=" + ean, { headers: { "Accept": "text/html", "Accept-Language": "fr-CH,de-CH;q=0.9" } });
  const out = { status: r.status, url: r.url };
  if (r.status !== 200) return { trouve: false, ...out, apercu: strip(r.text).slice(0, 160) };
  let html = r.text, pageUrl = r.url;
  // si on reste sur la page de résultats, suivre le premier lien produit
  if (!/preisvergleich|\/p\d+|-p\d+/i.test(pageUrl)) {
    const m = html.match(/href="(\/[^"]*(?:preisvergleich|-p\d+)[^"]*)"/i);
    if (m) { const r2 = await get(base + m[1], { headers: { "Accept": "text/html" } }); out.produit = r2.status; if (r2.status === 200) { html = r2.text; pageUrl = r2.url; } }
  }
  const texte = strip(html);
  const prixTous = [...texte.matchAll(/CHF\s*([\d'’]+(?:[.,]\d{2}|\.–|\.-)?)/g)].map((m) => m[1]);
  // prix proche de la mention « Fnac »
  let fnac = "";
  const i = texte.search(/fnac/i);
  if (i >= 0) {
    const prixRe = /(?:CHF\s*)?([\d'’]{1,6}[.,]\d{2})/;
    const apres = texte.slice(i, i + 200).match(prixRe);
    const avant = [...texte.slice(Math.max(0, i - 120), i).matchAll(new RegExp(prixRe.source, "g"))].pop();
    fnac = apres ? apres[1] : avant ? avant[1] + " (à vérifier)" : "mentionné, prix non repéré";
  }
  return { trouve: !!fnac, ...out, page: pageUrl, fnac_present: i >= 0, prix_fnac: fnac, prix_sur_la_page: prixTous.slice(0, 6),
    apercu: texte.slice(0, 160) };
}

// ---------- comparaison ----------
async function fichePour(code, env) {
  if (/^97[89]\d{10}$/.test(code)) {
    const [b, g, o, s] = await Promise.all([bnf(code), google(code), openlib(code), suisse(code)]);
    const pick = (...v) => v.find((x) => x && String(x).trim()) || "";
    const f = { titre: pick(b.titre, s.titre, g.titre, o.titre), auteur: pick(b.auteur, s.auteur, g.auteur, o.auteur),
      editeur: pick(b.editeur, s.editeur, g.editeur, o.editeur), date: pick(g.date, b.date, s.date, o.date),
      pages: pick(b.pages, s.pages, g.pages, o.pages), genre: pick(g.genre), age: pick(s.public), description: pick(s.description, g.description) };
    if (!f.titre) return { trouve: false, code };
    return { trouve: true, code, nom: f.titre + (f.auteur ? " (" + f.auteur + ")" : ""), texte: "Livre\n" + infosLivre(f, [b.sujets, s.sujets].filter(Boolean).join(" ; ")) };
  }
  const p = await upc(code);
  if (!p.trouve) return { trouve: false, code };
  return { trouve: true, code, nom: p.nom, texte: ["Produit : " + p.nom, p.marque && "Marque : " + p.marque, p.modele && "Modèle : " + p.modele,
    p.categorie && "Catégorie : " + p.categorie, p.description && "Description : " + p.description].filter(Boolean).join("\n") };
}

async function comparer(a, b, env) {
  if (!/^\d{8,13}$/.test(a) || !/^\d{8,13}$/.test(b)) return { trouve: false, erreur: "deux codes attendus (?a=...&b=...)" };
  const [fa, fb] = await Promise.all([fichePour(a, env), fichePour(b, env)]);
  if (!fa.trouve || !fb.trouve) return { trouve: false, introuvables: [fa, fb].filter((x) => !x.trouve).map((x) => x.code) };
  const consigne = "Tu aides un vendeur de la Fnac (Suisse) dont le client hésite entre deux articles. Réponds en français, en JSON strict sans texte autour : " +
    '{"lignes":[{"critere":"critère court","a":"valeur pour l\'article A","b":"valeur pour l\'article B"}],"conseil":"1 à 2 phrases : lequel conseiller selon le profil du client"}. ' +
    "Donne 4 à 6 critères qui comptent vraiment pour choisir. Appuie-toi sur les infos fournies et tes connaissances générales ; n'invente pas de chiffres précis que tu ignores, écris alors « ? ».";
  const ia = await demanderIA(env, consigne, "ARTICLE A\n" + fa.texte + "\n\nARTICLE B\n" + fb.texte, 600);
  return { trouve: !!ia, a: { code: a, nom: fa.nom }, b: { code: b, nom: fb.nom }, ia };
}

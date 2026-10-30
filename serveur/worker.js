// Serveur de l'appli « Scan produit » (Cloudflare Worker, offre gratuite)
// Adresses :
//   /test?ean=...     diagnostic : montre ce que chaque site répond
//   /livre?isbn=...   fiche livre (BnF, Google Books, Open Library, fnac.com, fnac.ch) + résumé IA
//   /produit?ean=...  fiche produit fnac.ch (nom, prix, SKU, description) si Fnac laisse passer

const SITE = "https://matth0312leb.github.io";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const HDRS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "fr-CH,fr;q=0.9" };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin === SITE ? SITE : "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const code = (url.searchParams.get("ean") || url.searchParams.get("isbn") || "").replace(/\D/g, "");
    const send = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: cors });
    try {
      if (url.pathname === "/test") return send(await diagnostic(code));
      if (url.pathname === "/livre") return send(await livre(code, env));
      if (url.pathname === "/produit") return send(await produit(code));
      return send({ ok: true, message: "Serveur Scan produit en ligne. Essaie /test?ean=9782889443666" });
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
    const r = await fetch(u, { headers: HDRS, redirect: "follow", signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, url: r.url, text };
  } catch (e) {
    return { status: 0, url: u, text: "", err: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}
const strip = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'")
  .replace(/&quot;/g, '"').replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&agrave;/g, "à").replace(/[ \t]+/g, " ").trim();
const bloque = (r) => r.status === 403 || r.status === 429 || /captcha|datadome|geo\.captcha-delivery|Access denied/i.test(r.text.slice(0, 5000));

function jsonLd(html) {
  const out = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1].trim());
      (Array.isArray(j) ? j : (j["@graph"] || [j])).forEach((x) => out.push(x));
    } catch (e) {}
  }
  return out;
}
function produitDepuisHtml(html, pageUrl) {
  const items = jsonLd(html);
  const p = items.find((x) => /Product|Book/i.test([].concat(x["@type"] || "").join(" "))) || {};
  const offer = [].concat(p.offers || [])[0] || {};
  const texte = strip(html);
  const sku = (texte.match(/SKU\s*:?\s*(\d{8})(?!\d)/i) || [])[1] || "";
  const age = (texte.match(/(?:[ÂA]ge|Tranche d'[âa]ge)\s*:?\s*([^\n]{2,40}?ans)/i) || [])[1] || "";
  const titreHtml = (html.match(/<meta property="og:title" content="([^"]+)"/i) || [])[1] || "";
  return {
    trouve: !!(p.name || titreHtml),
    url: pageUrl,
    nom: p.name || strip(titreHtml),
    prix: offer.price ? String(offer.price) + " " + (offer.priceCurrency || "") : "",
    dispo: offer.availability ? String(offer.availability).split("/").pop() : "",
    description: strip(p.description || "").slice(0, 1500),
    image: [].concat(p.image || [])[0] || "",
    auteur: [].concat(p.author || []).map((a) => a.name || a).join(", "),
    sku, age,
  };
}

// ---------- sources ----------
async function fnac(site, code) {
  const base = site === "ch" ? "https://www.fr.fnac.ch" : "https://www.fnac.com";
  const r = await get(base + "/SearchResult/ResultList.aspx?Search=" + code);
  if (bloque(r)) return { trouve: false, bloque: true, status: r.status };
  if (r.status !== 200) return { trouve: false, status: r.status, err: r.err };
  let html = r.text, pageUrl = r.url;
  // page de résultats : on suit le premier lien produit (/aNNNNN/)
  if (!/\/a\d+\//.test(pageUrl)) {
    const m = html.match(/href="(https?:\/\/[^"]*\/a\d+\/[^"]+|\/a\d+\/[^"]+)"/i);
    if (!m) return { trouve: false, status: r.status, info: "aucun produit dans les résultats" };
    const lien = m[1].startsWith("http") ? m[1] : base + m[1];
    const r2 = await get(lien.split("#")[0]);
    if (bloque(r2)) return { trouve: false, bloque: true, status: r2.status };
    html = r2.text; pageUrl = r2.url;
  }
  return produitDepuisHtml(html, pageUrl);
}

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
  const [ch, com, b, g, o] = await Promise.all([fnac("ch", code), fnac("com", code), bnf(code), google(code), openlib(code)]);
  const etat = (x) => x.trouve ? "OK" : x.bloque ? "BLOQUÉ par anti-robot (" + x.status + ")" : "rien (" + (x.status || x.err || "?") + ")";
  return {
    code,
    resume: { "fnac.ch": etat(ch), "fnac.com": etat(com), BnF: etat(b), "Google Books": etat(g), "Open Library": etat(o) },
    details: { fnac_ch: ch, fnac_com: com, bnf: b, google: g, openlibrary: o },
  };
}

async function livre(isbn, env) {
  if (!/^\d{13}$/.test(isbn)) return { trouve: false, erreur: "ISBN à 13 chiffres attendu" };
  const [b, g, o, com, ch] = await Promise.all([bnf(isbn), google(isbn), openlib(isbn), fnac("com", isbn), fnac("ch", isbn)]);
  const pick = (...v) => v.find((x) => x && String(x).trim()) || "";
  const fiche = {
    trouve: !!(b.trouve || g.trouve || o.trouve || com.trouve || ch.trouve),
    titre: pick(b.titre, g.titre, com.nom, ch.nom, o.titre),
    auteur: pick(b.auteur, g.auteur, com.auteur, ch.auteur, o.auteur),
    editeur: pick(b.editeur, g.editeur, o.editeur),
    date: pick(g.date, b.date, o.date),
    pages: pick(b.pages, g.pages, o.pages),
    genre: pick(g.genre),
    age: pick(com.age, ch.age),
    image: pick(g.image, com.image, ch.image, o.image),
    description: pick(com.description, ch.description, g.description),
    prix: pick(ch.prix),
    sku: pick(ch.sku),
    sources: { BnF: b.trouve, Google: g.trouve, OpenLibrary: o.trouve, "fnac.com": com.trouve || (com.bloque ? "bloqué" : false), "fnac.ch": ch.trouve || (ch.bloque ? "bloqué" : false) },
  };
  if (fiche.trouve && env && env.AI) fiche.ia = await resumeIA(env, fiche, b.sujets);
  return fiche;
}

async function produit(ean) {
  if (!/^\d{8,13}$/.test(ean)) return { trouve: false, erreur: "EAN attendu" };
  return await fnac("ch", ean);
}

async function resumeIA(env, f, sujets) {
  const infos = [
    "Titre : " + f.titre, f.auteur && "Auteur : " + f.auteur, f.editeur && "Éditeur : " + f.editeur,
    f.date && "Parution : " + f.date, f.pages && "Pages : " + f.pages, f.genre && "Genre : " + f.genre,
    sujets && "Sujets (catalogue BnF) : " + sujets, f.age && "Âge indiqué : " + f.age,
    f.description && "Texte de l'éditeur : " + f.description.slice(0, 1200),
  ].filter(Boolean).join("\n");
  const consigne = "Tu aides un libraire de la Fnac à renseigner un client en 10 secondes. À partir UNIQUEMENT des infos fournies, réponds en français, en JSON strict sans texte autour : " +
    '{"resume":"2 phrases maximum, sans spoiler","sujet":"de quoi ou de qui parle le livre, quelques mots","public":"âge ou public conseillé, ex. Dès 6 ans, Ados, Adultes"}. ' +
    "Si une info manque, déduis-la prudemment du genre et des sujets ; si c'est impossible, mets une chaîne vide. N'invente pas d'intrigue.";
  for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"]) {
    try {
      const r = await env.AI.run(model, { messages: [{ role: "system", content: consigne }, { role: "user", content: infos }], max_tokens: 300 });
      const txt = typeof r.response === "string" ? r.response : JSON.stringify(r.response || "");
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
    } catch (e) {}
  }
  return null;
}

// Serveur de l'appli « Scan produit » (Cloudflare Worker, offre gratuite)
// Adresses :
//   /test?ean=...     diagnostic : montre ce que chaque site répond
//   /livre?isbn=...   fiche livre (BnF, swisscovery, Google Books, Open Library) + résumé IA
//   /produit?ean=...  fiche produit (base de codes-barres UPCitemdb) + résumé IA pour conseiller
//   /comparer?a=...&b=...  comparaison de 2 articles par l'IA
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    const r = await fetch(u, { headers: HDRS, redirect: "follow", signal: ctl.signal });
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
  const etat = (x) => x.trouve ? "OK" : "rien (" + (x.status || x.err || "?") + ")";
  return {
    code,
    resume: { BnF: etat(b), swisscovery: etat(s), "Google Books": etat(g), "Open Library": etat(o), "UPCitemdb (produits)": etat(u) },
    details: { bnf: b, swisscovery: s, google: g, openlibrary: o, upcitemdb: u },
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

async function produit(ean, env) {
  if (!/^\d{8,13}$/.test(ean)) return { trouve: false, erreur: "EAN attendu" };
  const p = await upc(ean);
  if (!p.trouve) return { trouve: false, sources: { UPCitemdb: p.status || false } };
  const infos = ["Produit : " + p.nom, p.marque && "Marque : " + p.marque, p.modele && "Modèle : " + p.modele,
    p.categorie && "Catégorie : " + p.categorie, p.description && "Description : " + p.description].filter(Boolean).join("\n");
  const consigne = "Tu aides un vendeur de la Fnac (Suisse) à conseiller un client en 10 secondes. Réponds en français, en JSON strict sans texte autour : " +
    '{"nom":"nom commercial court du produit en français","resume":"1 à 2 phrases : ce que c\'est et à quoi ça sert","forts":["point fort","point fort","point fort"],"faibles":["point faible","point faible"],"pour_qui":"type de client à qui le conseiller","alternative":"une alternative courante à proposer"}. ' +
    "Appuie-toi sur les infos fournies et sur tes connaissances générales du produit. Si tu ne connais pas bien ce produit, reste général et prudent, n'invente pas de caractéristiques chiffrées, et laisse vide ce que tu ignores.";
  const ia = await demanderIA(env, consigne, infos, 450);
  return { trouve: true, ...p, ia, sources: { UPCitemdb: true } };
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

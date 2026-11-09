// Serveur de l'appli « Scan produit » (Cloudflare Worker, offre gratuite)
// Adresses :
//   /test?ean=...     diagnostic : montre ce que chaque site répond
//   /livre?isbn=...   fiche livre (BnF, swisscovery, Google Books, Open Library) + résumé IA
//   /produit?ean=...  fiche produit (base de codes-barres UPCitemdb) + résumé IA pour conseiller
//   /comparer?a=...&b=...  comparaison de 2 articles par l'IA
//   /similaires?isbn=...  4 livres à proposer « si vous avez aimé… » (IA, titres vérifiés dans Open Library)
//   POST /question {question, contexte}  réponse de l'IA à une question du client sur la fiche affichée
//   (les fiches livre/produit/comparaison sont gardées 30 jours dans le stockage KV « FICHES » ; ajouter &frais=1 pour forcer)
//   POST /photo {image: dataURL}  identification par photo (couverture / boîte) avec l'IA vision
//   Jeux vidéo : /produit détecte un jeu et ajoute les infos Wikidata (PEGI, sortie, modes, genre, plateformes, studio)
// Les sites Fnac ne sont pas interrogés : leur anti-robot bloque le serveur (403, testé le 30.10.2026).

const SITE = "https://matth0312leb.github.io";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const HDRS = { "User-Agent": UA, "Accept": "application/json,application/xml,text/xml;q=0.9,*/*;q=0.8", "Accept-Language": "fr-CH,fr;q=0.9" };

export default {
  async fetch(req, env, ctx) {
    env = compteurIA(env, ctx);
    try { env.__ctx = ctx; } catch (e) {}
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
    // statistiques, profils, questions et photos : jamais gardés en mémoire par le navigateur
    if (/^\/(stats|profil\/|chat\/|question|cadeaux|photo|test)/.test(url.pathname)) cors["Cache-Control"] = "no-store";
    const code = (url.searchParams.get("ean") || url.searchParams.get("isbn") || "").replace(/\D/g, "");
    const send = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: cors });
    // mémoire des fiches (stockage KV Cloudflare, 30 jours) : un article déjà vu s'affiche tout de suite
    const VERSION = "v2";   // v2 : dates de parution / sortie exactes
    const cle = url.pathname.slice(1) + ":" + VERSION + ":" + [code, url.searchParams.get("a"), url.searchParams.get("b")].filter(Boolean).join("-");
    const frais = url.searchParams.get("frais") === "1";
    if (env.FICHES && !frais && /^\/(livre|produit|comparer|similaires)$/.test(url.pathname)) {
      try { const deja = await env.FICHES.get(cle, "json"); if (deja) return send({ ...deja, memoire: true }); } catch (e) {}
    }
    const sendCache = async (o) => {
      if (o && o.trouve && env.FICHES) { try { await env.FICHES.put(cle, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {} }
      return send(o);
    };
    try {
      if (url.pathname === "/photo" && req.method === "POST") {
        let body; try { body = await req.json(); } catch (e) { return send({ trouve: false, erreur: "image attendue" }, 400); }
        return send(await photo(String(body.image || ""), env));
      }
      if (url.pathname.startsWith("/profil/") || url.pathname.startsWith("/chat/") || url.pathname === "/stats") return send(await profils(req, url, env));
      if (url.pathname === "/cadeaux" && req.method === "POST") {
        let body; try { body = await req.json(); } catch (e) { return send({ ok: false, erreur: "demande attendue" }, 400); }
        return send(await cadeaux(body || {}, env));
      }
      if (url.pathname === "/question" && req.method === "POST") {
        let body; try { body = await req.json(); } catch (e) { return send({ ok: false, erreur: "question attendue" }, 400); }
        return send(await question(String(body.question || ""), String(body.contexte || ""), env));
      }
      if (url.pathname === "/livre") return await sendCache(await livre(code, env));
      if (url.pathname === "/similaires") return await sendCache(await similaires(code, env));
      if (url.pathname === "/serie") {
        // liste des tomes : gardée 3 jours (les nouveaux tomes arrivent vite)
        const cs = "serie:v1:" + code;
        if (env.FICHES && !frais) { try { const d = await env.FICHES.get(cs, "json"); if (d) return send({ ...d, memoire: true }); } catch (e) {} }
        const o = await serie(code);
        if (o.trouve && env.FICHES) { try { await env.FICHES.put(cs, JSON.stringify(o), { expirationTtl: 3 * 24 * 3600 }); } catch (e) {} }
        return send(o);
      }
      if (url.pathname === "/produit") return await sendCache(await produit(code, env));
      if (url.pathname === "/comparer") {
        const g = (k) => (url.searchParams.get(k) || "").trim().slice(0, 120);
        return await sendCache(await comparer(g("a"), g("b"), env, g("na"), g("nb")));
      }
      if (url.pathname === "/test" && url.searchParams.get("actu")) return send(await actualite(env));
      if (url.pathname === "/test" && url.searchParams.get("titre")) return send({ livre: await chercherLivre(url.searchParams.get("titre"), url.searchParams.get("auteur") || "", url.searchParams.get("editeur") || "") });
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

// ---------- dates de parution : on garde la plus précise (jour > mois > année) ----------
const MOIS_FR = ["janvier","fevrier","mars","avril","mai","juin","juillet","aout","septembre","octobre","novembre","decembre"];
const MOIS_EN = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
// renvoie { iso: "AAAA-MM-JJ" | "AAAA-MM" | "AAAA", prec: 3 | 2 | 1 } ou null
function lireDate(v) {
  const t = String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  if (!t) return null;
  const ok = (a, m, j) => {
    a = +a; m = m ? +m : 0; j = j ? +j : 0;
    if (a < 1450 || a > 2100 || m > 12 || j > 31) return null;
    const z = (n) => String(n).padStart(2, "0");
    if (m && j) return { iso: a + "-" + z(m) + "-" + z(j), prec: 3 };
    if (m) return { iso: a + "-" + z(m), prec: 2 };
    return { iso: String(a), prec: 1 };
  };
  let m;
  if ((m = t.match(/(\d{4})-(\d{2})(?:-(\d{2}))?/))) return ok(m[1], m[2], m[3] && m[3] !== "00" ? m[3] : 0);
  if ((m = t.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/))) return ok(m[3], m[2], m[1]);
  if ((m = t.match(/\b(\d{1,2})(?:er)?\s+([a-z]+)\.?\s+(\d{4})\b/))) {
    const i = MOIS_FR.findIndex((x) => x.startsWith(m[2].slice(0, 3))), k = MOIS_EN.indexOf(m[2].slice(0, 3));
    if (i > -1 || k > -1) return ok(m[3], (i > -1 ? i : k) + 1, m[1]);
  }
  if ((m = t.match(/\b([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/))) {
    const k = MOIS_EN.indexOf(m[1].slice(0, 3));
    if (k > -1) return ok(m[3], k + 1, m[2]);
  }
  if ((m = t.match(/\b([a-z]+)\.?\s+(\d{4})\b/))) {
    const i = MOIS_FR.findIndex((x) => x.startsWith(m[1].slice(0, 3))), k = MOIS_EN.indexOf(m[1].slice(0, 3));
    if ((i > -1 || k > -1) && m[1].length >= 3) return ok(m[2], (i > -1 ? i : k) + 1, 0);
  }
  if ((m = t.match(/(?<!\d)(1[4-9]\d{2}|20\d{2})(?!\d)/))) return ok(m[1]);
  return null;
}
// choisit la date la plus précise ; si les catalogues donnent l'année de l'édition, une date plus précise doit tomber la même année
function meilleureDate(candidats, anneeEdition) {
  const ds = candidats.map(lireDate).filter(Boolean);
  if (!ds.length) return "";
  const an = anneeEdition ? (lireDate(anneeEdition) || {}).iso : "";
  const bons = ds.filter((d) => !an || d.prec === 1 || d.iso.slice(0, 4) === an.slice(0, 4));
  const liste = bons.length ? bons : ds;
  liste.sort((x, y) => y.prec - x.prec);
  return liste[0].iso;
}
// recherche web (Bing) de la date de parution d'un ISBN, sur les sites de libraires qui l'affichent
async function webDateLivre(isbn) {
  const r = await get("https://www.bing.com/search?setlang=fr&cc=CH&q=" + isbn + "+%22date+de+parution%22",
    { timeout: 6000, headers: { "Accept": "text/html", "Accept-Language": "fr-CH,fr;q=0.9" } });
  if (r.status !== 200) return { trouve: false, status: r.status };
  const texte = strip(r.text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const re = /(?:date de (?:parution|publication|sortie)|parution|paru le|publi[ée] le|sortie le)\s*[:\-–]?\s*(?:le\s+)?(\d{1,2}[\/.]\d{1,2}[\/.]\d{4}|\d{1,2}(?:er)?\s+[a-zéû]+\.?\s+\d{4})/gi;
  const vus = {};
  for (const m of texte.matchAll(re)) { const d = lireDate(m[1]); if (d && d.prec === 3) vus[d.iso] = (vus[d.iso] || 0) + 1; }
  const tri = Object.entries(vus).sort((a, b) => b[1] - a[1]);
  return tri.length ? { trouve: true, date: tri[0][0], toutes: vus } : { trouve: false, status: 200 };
}

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
  const [u1, opf, web, tp, wd] = await Promise.all([upcUn(code), openProducts(code), webNom(code, true), toppreise(code), /^97[89]/.test(code) ? webDateLivre(code) : { trouve: false }]);
  const etat = (x) => x.trouve ? "OK" : "rien (" + (x.status || x.err || "?") + ")";
  return {
    code,
    resume: { BnF: etat(b), swisscovery: etat(s), "Google Books": etat(g), "Open Library": etat(o), "Produits (UPCitemdb / Open Products Facts / web)": u.trouve ? "OK via " + (u.source || "UPCitemdb") + " : " + u.nom : etat(u), "Wikidata (jeux)": u.trouve ? etat(w) + " — recherche : " + titreJeu(u.nom) + (estJeu(u) ? " (détecté comme jeu)" : " (pas détecté comme jeu)") : "non testé" },
    toppreise: tp.trouve ? "Fnac trouvé : CHF " + tp.prix_fnac : (tp.status === 200 ? (tp.fnac_present ? "Fnac mentionné" : "page OK, Fnac absent") : "rien / bloqué (" + tp.status + ")"),
    date_parution: /^97[89]/.test(code) ? { retenue: meilleureDate([g.date, o.date, b.date, s.date, wd.date], b.date || s.date), google: g.date, openlibrary: o.date, bnf: b.date, swisscovery: s.date, web: wd } : undefined,
    details: { toppreise: tp, bnf: b, swisscovery: s, google: g, openlibrary: o, produit_final: u, upcitemdb_seul: u1, open_products_facts: opf, web: web, wikidata: w },
  };
}

async function dateLivre(isbn, b, g, o, s) {
  const edition = b.date || s.date || "";
  let d = meilleureDate([g.date, o.date, b.date, s.date], edition);
  if (!d || d.length < 10) {   // pas encore le jour exact : on cherche sur les sites de libraires
    const w = await webDateLivre(isbn).catch(() => ({ trouve: false }));
    if (w.trouve) d = meilleureDate([w.date, d], edition) || d;
  }
  return d;
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
    date: "",
    pages: pick(b.pages, s.pages, g.pages, o.pages),
    genre: pick(g.genre),
    age: pick(s.public),
    image: pick(g.image, o.image),
    description: pick(s.description, g.description),
    sources: { BnF: b.trouve, swisscovery: s.trouve, Google: g.trouve, OpenLibrary: o.trouve },
  };
  if (fiche.trouve) fiche.date = await dateLivre(isbn, b, g, o, s);
  if (fiche.trouve && env && env.AI) fiche.ia = await resumeIA(env, fiche, [b.sujets, s.sujets].filter(Boolean).join(" ; "));
  return fiche;
}

// ---------- suivi du quota de l'IA gratuite (10 000 « neurones » par jour) ----------
// Estimation à partir des tarifs publiés par Cloudflare (neurones par million de jetons, entrée / sortie).
const TARIFS = {
  "llama-3.3-70b": [26668, 204805], "llama-3.1-8b": [25608, 75147], "llama-3.2-11b-vision": [4410, 61493],
  "gemma-3-12b": [31371, 50560], "moondream": [27273, 90909],
};
function compteurIA(env, ctx) {
  if (!env || !env.AI || env.__compte) return env;
  const ai = env.AI;
  const compte = {
    run: async (modele, entree, ...reste) => {
      const r = await ai.run(modele, entree, ...reste);
      try {
        const cle = Object.keys(TARIFS).find((k) => modele.includes(k)) || "llama-3.3-70b";
        const [tIn, tOut] = TARIFS[cle];
        const u = (r && r.usage) || {};
        const texteIn = JSON.stringify((entree && (entree.messages || entree.prompt || entree.question)) || "").length;
        const jIn = u.prompt_tokens || Math.round(texteIn / 4) + (entree && entree.image ? 1600 : 0);
        const sortie = r && (r.response ?? r.answer ?? r.description ?? r.caption);
        const jOut = u.completion_tokens || Math.round(JSON.stringify(sortie || "").length / 4);
        const neurones = (jIn * tIn + jOut * tOut) / 1e6;
        if (env.DB && entree && entree.prompt !== "agree") {
          const jour = new Date().toISOString().slice(0, 10);
          const p = env.DB.prepare("INSERT INTO ia_usage (jour, appels, neurones) VALUES (?, 1, ?) ON CONFLICT(jour) DO UPDATE SET appels = appels + 1, neurones = neurones + excluded.neurones").bind(jour, neurones).run();
          if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
        }
      } catch (e) {}
      return r;
    },
  };
  return Object.assign(Object.create(env), env, { AI: compte, __compte: true });
}

// ---------- livres similaires ----------
async function similaires(isbn, env) {
  if (!/^97[89]\d{10}$/.test(isbn)) return { trouve: false, erreur: "ISBN attendu" };
  let f = env.FICHES ? await env.FICHES.get("livre:v1:" + isbn, "json").catch(() => null) : null;
  if (!f) f = await livre(isbn, env);
  if (!f || !f.trouve) return { trouve: false, erreur: "livre introuvable" };
  const ia = f.ia || {};
  const infos = ["Livre : " + f.titre, f.auteur && "Auteur : " + f.auteur, f.genre && "Genre : " + f.genre,
    (f.age || ia.public) && "Public : " + (f.age || ia.public), ia.sujet && "Sujet : " + ia.sujet,
    (ia.resume || f.description) && "Résumé : " + (ia.resume || f.description).slice(0, 600)].filter(Boolean).join("\n");
  const consigne = "Tu es libraire à la Fnac (Suisse). Un client a aimé ce livre. Propose 4 AUTRES livres réels, connus et disponibles en français, du même public et du même esprit. " +
    'Réponds en JSON strict : {"livres":[{"titre":"titre exact en français","auteur":"Prénom Nom","pourquoi":"une phrase courte : le point commun"}]}. ' +
    "Ne propose que des livres dont tu es certain qu'ils existent ; pas le livre d'origine ni un autre tome de la même série.";
  const r = await demanderIA(env, consigne, infos, 450);
  const liste = (r && Array.isArray(r.livres) ? r.livres : []).filter((x) => x && x.titre).slice(0, 4);
  if (!liste.length) return { trouve: false, erreur: "pas de suggestion" };
  const verifies = await Promise.all(liste.map(async (x) => {
    const q = "https://openlibrary.org/search.json?limit=1&fields=title,author_name,isbn&title=" + encodeURIComponent(x.titre) + (x.auteur ? "&author=" + encodeURIComponent(x.auteur) : "");
    const o = await get(q, { timeout: 5000 });
    let doc = null; try { doc = JSON.parse(o.text).docs[0]; } catch (e) {}
    const isbn13 = doc && (doc.isbn || []).find((i) => /^97[89]\d{10}$/.test(i) && /^97[89]2/.test(i)) || doc && (doc.isbn || []).find((i) => /^97[89]\d{10}$/.test(i)) || "";
    return { titre: String(x.titre), auteur: String(x.auteur || ""), pourquoi: String(x.pourquoi || ""), verifie: !!doc, isbn: isbn13 };
  }));
  // on ne garde que les titres retrouvés dans Open Library (évite les livres inventés par l'IA)
  const surs = verifies.filter((x) => x.verifie);
  return { trouve: true, pour: f.titre, livres: surs.length ? surs : verifies.map((x) => ({ ...x, aVerifier: true })) };
}

// ---------- actualité pour les idées cadeaux : sorties récentes tirées de Wikidata (gardées 1 jour) ----------
async function sparql(q, timeout) {
  const r = await get("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q),
    { timeout: timeout || 15000, headers: { "Accept": "application/sparql-results+json", "User-Agent": "BipBip/1.0 (https://matth0312leb.github.io/Fnac-scan/)" } });
  if (r.status !== 200) return [];
  try { return JSON.parse(r.text).results.bindings || []; } catch (e) { return []; }
}
const isoJour = (d) => new Date(d).toISOString().slice(0, 10);
async function actualite(env) {
  const jour = isoJour(Date.now()), cleKV = "actu:v1:" + jour;
  if (env.FICHES) { try { const deja = await env.FICHES.get(cleKV, "json"); if (deja) return deja; } catch (e) {} }
  const depuis = isoJour(Date.now() - 15 * 30 * 864e5), jusqua = isoJour(Date.now() + 45 * 864e5), v = (x, k) => x[k] && x[k].value || "";
  const [jeux, mangas, livres] = await Promise.all([
    // jeux vidéo sortis ces 15 derniers mois sur les consoles actuelles, triés par notoriété (nombre d'articles Wikipédia)
    sparql(`SELECT ?itemLabel (MIN(?date) AS ?sortie) (MAX(?sl) AS ?notoriete) (GROUP_CONCAT(DISTINCT ?platL; separator=", ") AS ?plats) (MAX(?pegiN) AS ?pegi) WHERE {
      ?item wdt:P31 wd:Q7889; wdt:P577 ?date; wikibase:sitelinks ?sl; wdt:P400 ?plat.
      FILTER(?date >= "${depuis}T00:00:00Z"^^xsd:dateTime && ?date <= "${jusqua}T00:00:00Z"^^xsd:dateTime) FILTER(?sl >= 6)
      ?plat rdfs:label ?platL. FILTER(LANG(?platL) = "en" && REGEX(?platL, "PlayStation 5|Nintendo Switch|Xbox Series|Windows"))
      OPTIONAL { ?item wdt:P908 ?pg. ?pg rdfs:label ?pgL. FILTER(LANG(?pgL) = "en") BIND(xsd:integer(REPLACE(?pgL, "[^0-9]", "")) AS ?pegiN) }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". ?item rdfs:label ?itemLabel. }
    } GROUP BY ?itemLabel ORDER BY DESC(?notoriete) LIMIT 45`),
    // séries manga en cours (pas de date de fin), les plus connues
    sparql(`SELECT ?itemLabel ?sl WHERE {
      ?item wdt:P31 wd:Q21198342; wikibase:sitelinks ?sl; wdt:P580 ?debut.
      FILTER NOT EXISTS { ?item wdt:P582 ?fin } FILTER(?debut >= "2010-01-01T00:00:00Z"^^xsd:dateTime) FILTER(?sl >= 12)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
    } ORDER BY DESC(?sl) LIMIT 35`),
    // livres et BD parus ces 15 derniers mois, les plus connus
    sparql(`SELECT ?itemLabel (MIN(?date) AS ?sortie) (MAX(?sl) AS ?notoriete) (SAMPLE(?auteurL) AS ?auteur) WHERE {
      VALUES ?type { wd:Q7725634 wd:Q47461344 wd:Q1004 wd:Q8261 wd:Q838795 }
      ?item wdt:P31 ?type; wdt:P577 ?date; wikibase:sitelinks ?sl.
      FILTER(?date >= "${depuis}T00:00:00Z"^^xsd:dateTime && ?date <= "${jusqua}T00:00:00Z"^^xsd:dateTime) FILTER(?sl >= 4)
      OPTIONAL { ?item wdt:P50 ?a. ?a rdfs:label ?auteurL. FILTER(LANG(?auteurL) = "fr" || LANG(?auteurL) = "en") }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". ?item rdfs:label ?itemLabel. }
    } GROUP BY ?itemLabel ORDER BY DESC(?notoriete) LIMIT 35`),
  ].map((pr) => pr.catch(() => [])));
  const propre = (t) => t && !/^Q\d+$/.test(t);
  const res = {
    jour,
    jeux: jeux.filter((x) => propre(v(x, "itemLabel"))).map((x) => ({ titre: v(x, "itemLabel"), sortie: v(x, "sortie").slice(0, 10), plateformes: v(x, "plats").replace(/Microsoft /g, ""), pegi: +v(x, "pegi") || 0 })),
    mangas: mangas.filter((x) => propre(v(x, "itemLabel"))).map((x) => v(x, "itemLabel")),
    livres: livres.filter((x) => propre(v(x, "itemLabel"))).map((x) => ({ titre: v(x, "itemLabel"), auteur: v(x, "auteur"), sortie: v(x, "sortie").slice(0, 10) })),
  };
  if (env.FICHES && (res.jeux.length || res.mangas.length)) { try { await env.FICHES.put(cleKV, JSON.stringify(res), { expirationTtl: 60 * 60 * 26 }); } catch (e) {} }
  return res;
}
function pegiMax(age) {
  const m = String(age).match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return /adulte/i.test(age) ? 18 : 18;
  const haut = +m[2];
  return haut <= 3 ? 3 : haut <= 7 ? 3 : haut <= 11 ? 7 : haut <= 15 ? 12 : 16;
}

// ---------- idées cadeaux (âge, budget, envies) ----------
async function cadeaux(b, env) {
  const t = (x, n) => String(x || "").replace(/\s+/g, " ").trim().slice(0, n);
  const age = t(b.age, 40), budget = t(b.budget, 40), gouts = t(b.gouts, 300), occasion = t(b.occasion, 40) || "Noël";
  const types = (Array.isArray(b.types) ? b.types : []).map((x) => t(x, 30)).filter(Boolean).slice(0, 6);
  if (!age && !gouts) return { ok: false, erreur: "indique au moins l'âge ou ce que la personne aime" };
  // ce qui sort en ce moment (Wikidata), pour ne pas proposer que des classiques d'il y a des années
  const actu = await actualite(env).catch(() => ({ jeux: [], mangas: [], livres: [] }));
  const veut = (re) => !types.length || types.some((t) => re.test(t));
  const pmax = pegiMax(age);
  const jeuxOk = (actu.jeux || []).filter((j) => !j.pegi || j.pegi <= pmax).slice(0, 30);
  const aujourdhui = new Date().toLocaleDateString("fr-CH", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Zurich" });
  const listes = [
    veut(/jeu vid/i) && jeuxOk.length && "JEUX VIDÉO SORTIS RÉCEMMENT (titre · date · consoles · PEGI) :\n" + jeuxOk.map((j) => "- " + j.titre + " · " + j.sortie + " · " + j.plateformes + (j.pegi ? " · PEGI " + j.pegi : "")).join("\n"),
    veut(/manga|bd/i) && (actu.mangas || []).length && "SÉRIES MANGA EN COURS ET POPULAIRES :\n" + actu.mangas.slice(0, 30).map((m) => "- " + m).join("\n"),
    veut(/livre|bd|manga/i) && (actu.livres || []).length && "LIVRES ET BD PARUS RÉCEMMENT :\n" + actu.livres.slice(0, 25).map((l) => "- " + l.titre + (l.auteur ? " (" + l.auteur + ")" : "") + " · " + l.sortie).join("\n"),
  ].filter(Boolean).join("\n\n");
  const consigne = "Tu es vendeur conseil à la Fnac (Suisse) et tu aides un collègue à trouver un cadeau. Nous sommes le " + aujourdhui + ". Propose 6 idées de cadeaux RÉELS, ACTUELS et vendus à la Fnac (livres, BD, mangas, jeux vidéo, jeux de société, high-tech, accessoires…), adaptées à l'âge, au budget en francs suisses et aux goûts. " +
    "PRIORITÉ À L'ACTUALITÉ : choisis d'abord dans les listes de sorties récentes fournies (elles viennent de bases à jour) ; pour le reste, propose des articles récents ou des incontournables encore très demandés cette année. " +
    "INTERDIT : les jeux gratuits (Roblox, Fortnite…), les éditions périmées (pas « Just Dance 2022 » mais la dernière édition), les vieux modèles high-tech remplacés depuis (propose la génération actuelle). " +
    "Varie les idées (pas 6 fois le même type, sauf si un seul type est demandé). Pour un livre ou une BD, donne un titre précis qui existe en français et son auteur ; pour une série, le tome 1. Pour un produit, le nom exact du modèle. Respecte l'âge (PEGI). " +
    'Réponds UNIQUEMENT en JSON : {"idees":[{"titre":"nom exact","auteur":"auteur si livre/BD/manga, sinon vide","type":"Livre|BD|Manga|Jeu vidéo|Jeu de société|High-tech|Autre","sortie":"date de sortie AAAA-MM-JJ si elle figure dans les listes, sinon vide","pourquoi":"une phrase : pourquoi ça plaira"}]}. ' +
    "Ne propose que des articles dont tu es certain qu'ils existent. N'indique aucun prix.";
  const demande = ["Occasion : " + occasion, age && "Pour : " + age + " (PEGI " + pmax + " maximum pour les jeux)", budget && "Budget : " + budget, types.length && "Types souhaités : " + types.join(", "), gouts && "Ce que la personne aime : " + gouts, listes].filter(Boolean).join("\n");
  const r = await demanderIA(env, consigne, demande, 700);
  const liste = (r && Array.isArray(r.idees) ? r.idees : []).filter((x) => x && x.titre).slice(0, 6);
  if (!liste.length) return { ok: false, erreur: "pas d'idée pour le moment, réessaie" };
  // livres, BD et mangas : on vérifie qu'ils existent (Open Library) pour écarter les titres inventés
  const idees = await Promise.all(liste.map(async (x) => {
    const o = { titre: t(x.titre, 120), auteur: t(x.auteur, 80), type: t(x.type, 30) || "Autre", pourquoi: t(x.pourquoi, 220), sortie: /^\d{4}-\d{2}-\d{2}$/.test(String(x.sortie || "")) ? x.sortie : "" };
    // date de sortie vérifiée dans nos listes (l'IA peut se tromper)
    const ref = (actu.jeux || []).concat(actu.livres || []).find((j) => j.titre.toLowerCase() === o.titre.toLowerCase());
    o.sortie = ref ? ref.sortie : "";
    o.recent = !!ref || (actu.mangas || []).some((m) => o.titre.toLowerCase().startsWith(m.toLowerCase()));
    if (/livre|bd|manga|roman|album/i.test(o.type)) {
      const q = "https://openlibrary.org/search.json?limit=1&fields=title,isbn&title=" + encodeURIComponent(o.titre) + (o.auteur ? "&author=" + encodeURIComponent(o.auteur) : "");
      const res = await get(q, { timeout: 5000 });
      let doc = null; try { doc = JSON.parse(res.text).docs[0]; } catch (e) {}
      o.verifie = !!doc;
      o.isbn = doc && ((doc.isbn || []).find((i) => /^97[89]2\d{9}$/.test(i)) || (doc.isbn || []).find((i) => /^97[89]\d{10}$/.test(i))) || "";
    }
    return o;
  }));
  // un livre introuvable dans Open Library est retiré (sauf si ça viderait la liste)
  const gardes = idees.filter((x) => x.verifie !== false);
  return { ok: true, idees: gardes.length >= 3 ? gardes : idees, actu: { jeux: (actu.jeux || []).length, mangas: (actu.mangas || []).length, livres: (actu.livres || []).length } };
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

async function sortieJeu(item, plateforme) {
  const q = `SELECT ?date ?prec ?lieu ?platL WHERE { wd:${item} p:P577 ?st. ?st psv:P577 ?v. ?v wikibase:timeValue ?date; wikibase:timePrecision ?prec.
    OPTIONAL { ?st pq:P291 ?lieu. } OPTIONAL { ?st pq:P400 ?plat. ?plat rdfs:label ?platL. FILTER(LANG(?platL) = "en") } } LIMIT 100`;
  const r = await get("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q),
    { timeout: 8000, headers: { "Accept": "application/sparql-results+json", "User-Agent": "ScanProduit/1.0 (https://matth0312leb.github.io/Fnac-scan/)" } });
  if (r.status !== 200) return "";
  let rows; try { rows = JSON.parse(r.text).results.bindings; } catch (e) { return ""; }
  const EUROPE = ["Q46", "Q142", "Q39", "Q458", "Q13780930", "Q145", "Q183"];
  const pl = String(plateforme || "").toLowerCase().replace("ps5", "playstation 5").replace("ps4", "playstation 4").replace("xbox series x|s", "xbox series");
  const cands = rows.map((x) => {
    const prec = +x.prec.value, iso = x.date.value.slice(0, 10);
    const lieu = x.lieu ? x.lieu.value.split("/").pop() : "", plat = x.platL ? x.platL.value.toLowerCase() : "";
    return {
      iso: prec >= 11 ? iso : prec === 10 ? iso.slice(0, 7) : iso.slice(0, 4), prec,
      score: (prec >= 11 ? 4 : prec === 10 ? 2 : 0) + (!lieu || EUROPE.includes(lieu) ? 2 : 0) + (lieu && EUROPE.includes(lieu) ? 1 : 0) +
        (pl && plat ? (plat.includes(pl) || pl.includes(plat) ? 3 : -3) : 0),
    };
  }).filter((c) => /^\d{4}/.test(c.iso) && !c.iso.startsWith("-"));
  cands.sort((a, b) => b.score - a.score || (a.iso < b.iso ? -1 : 1));
  return cands[0] ? cands[0].iso : "";
}
async function wikidataJeu(titre, plateforme) {
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
    sortie: (await sortieJeu(first.split("/").pop(), plateforme).catch(() => "")) || (dates[0] ? dates[0].slice(0, 4) : ""),
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
  const w = await wikidataJeu(titre, p.plateforme || plateformeDe(p.nom));
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

// ---------- profils (prénom), historique synchronisé et statistiques d'usage ----------
// Base D1 « DB » : historique(nom, code, note, t), activite(nom, t, type), profils(nom, affichage, cree, vu), config(cle, valeur)
// Le profil administrateur (config.admin_nom) est protégé par config.code_stats ; les stats ne montrent que des chiffres par fonction.
const TYPES = ["livre", "jeu", "produit", "sku", "photo", "question", "comparer", "motscles", "similaires", "cadeaux"];
async function profils(req, url, env) {
  if (!env.DB) return { ok: false, erreur: "base indisponible" };
  const corps = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const p = (k) => String(corps[k] ?? url.searchParams.get(k) ?? "").trim();
  const conf = async (k) => { const r = await env.DB.prepare("SELECT valeur FROM config WHERE cle = ?").bind(k).first(); return r ? r.valeur : ""; };
  let affichage = p("nom").replace(/\s+/g, " ").slice(0, 30);
  let nom = affichage.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const now = Date.now();
  const route = url.pathname;

  if (route === "/stats") {
    // chaque requête a un délai maximum, pour ne jamais bloquer l'écran des statistiques
    const etapes = [];
    const t0 = Date.now();
    const borne = (nomEtape, promesse, defaut) => {
      let minuteur;
      return Promise.race([
        Promise.resolve(promesse).then((v) => { etapes.push(nomEtape + " " + (Date.now() - t0) + " ms"); return v; }),
        new Promise((ok) => { minuteur = setTimeout(() => { etapes.push(nomEtape + " : délai dépassé"); ok(defaut); }, 4000); }),
      ]).catch((err) => { etapes.push(nomEtape + " : " + String(err && err.message || err).slice(0, 80)); return defaut; })
        .finally(() => clearTimeout(minuteur));
    };
    const code = await borne("code", conf("code_stats"), null);
    if (code === null) return { ok: false, erreur: "base injoignable", etapes };
    if (p("cle") !== code) {
      // un manager qui a le droit « stats » y accède avec son prénom et son code personnel
      const rcA = await rolesConf(env), pr = nom ? await env.DB.prepare("SELECT pin FROM profils WHERE nom = ?").bind(nom).first().catch(() => null) : null;
      if (!(rcA.roles[nom] === "manager" && rcA.droits.includes("stats") && pr && await pinOk(p("cle"), pr.pin))) return { ok: false, erreur: "code incorrect" };
    }
    const semaine = now - 7 * 24 * 3600 * 1000;
    const jour = new Date().toISOString().slice(0, 10);
    const [act, noms, q, hist] = await Promise.all([
      borne("activité", env.DB.prepare("SELECT nom, type, COUNT(*) AS n, SUM(CASE WHEN t > ? THEN 1 ELSE 0 END) AS n7, MAX(t) AS dernier FROM activite GROUP BY nom, type").bind(semaine).all(), { results: [] }),
      borne("profils", env.DB.prepare("SELECT nom, affichage, cree, vu, pin IS NOT NULL AS code FROM profils").all(), { results: [] }),
      borne("quota", env.DB.prepare("SELECT appels, neurones FROM ia_usage WHERE jour = ?").bind(jour).first(), null),
      borne("quota 7 j", env.DB.prepare("SELECT jour, appels, neurones FROM ia_usage ORDER BY jour DESC LIMIT 7").all(), { results: [] }),
    ]);
    const parNom = {};
    const rcS = await rolesConf(env), adminNomS = await conf("admin_nom");
    (noms.results || []).forEach((x) => { parNom[x.nom] = { id: x.nom, code: !!x.code, role: x.nom === adminNomS ? "admin" : rcS.roles[x.nom] === "manager" ? "manager" : "equipe", nom: x.affichage || x.nom, depuis: x.cree, dernier: x.vu || 0, total: 0, semaine: 0, fonctions: {} }; });
    (act.results || []).forEach((r) => {
      const s = parNom[r.nom] || (parNom[r.nom] = { id: r.nom, nom: r.nom, dernier: 0, total: 0, semaine: 0, fonctions: {} });
      s.fonctions[r.type || "scan"] = r.n; s.total += r.n; s.semaine += r.n7 || 0; s.dernier = Math.max(s.dernier, r.dernier || 0);
    });
    return { ok: true, equipe: Object.values(parNom).sort((a, b) => b.total - a.total),
      quota: { jour, appels: q ? q.appels : 0, neurones: q ? Math.round(q.neurones) : 0, limite: 10000, semaine: hist.results || [] },
      etapes };
  }

  if (!nom || nom.length < 2) return { ok: false, erreur: "prénom manquant" };
  // protection du profil administrateur
  if (nom === await conf("admin_nom") && p("cle") !== await conf("code_stats")) return { ok: false, erreur: "code", protege: true };
  const admin = nom === await conf("admin_nom");

  // profil renommé ou supprimé par l'administrateur : le téléphone du collègue est prévenu à sa prochaine requête
  let renomme = "";
  if (!admin) {
    const al = await env.DB.prepare("SELECT nouveau, affichage FROM renommages WHERE ancien = ?").bind(nom).first().catch(() => null);
    // supprimé : refusé pour le vieux téléphone, mais une reconnexion volontaire avec ce prénom le recrée
    if (al && !al.nouveau && route === "/profil/connexion") await env.DB.prepare("DELETE FROM renommages WHERE ancien = ?").bind(nom).run();
    else if (al && !al.nouveau) return { ok: false, erreur: "profil supprimé", supprime: true };
    else if (al) { nom = al.nouveau; affichage = al.affichage; renomme = al.affichage; }
  }
  // code personnel à 4 chiffres (champ « cle »), stocké haché ; 5 erreurs = profil bloqué 15 minutes
  let pinAFaire = false, poserPin = "";
  if (!admin) {
    const pr = await env.DB.prepare("SELECT pin, essais, bloque FROM profils WHERE nom = ?").bind(nom).first().catch(() => null);
    const pin = p("cle");
    if (pr && pr.pin) {
      if ((pr.bloque || 0) > now) return { ok: false, erreur: "trop d'essais", protege: true, bloque: true };
      if (!(await pinOk(pin, pr.pin))) {
        const essais = (pr.essais || 0) + 1;
        await env.DB.prepare("UPDATE profils SET essais = ?, bloque = ? WHERE nom = ?").bind(essais >= 5 ? 0 : essais, essais >= 5 ? now + 15 * 60 * 1000 : 0, nom).run();
        return { ok: false, erreur: "code", protege: true, bloque: essais >= 5 };
      }
      if (pr.essais) await env.DB.prepare("UPDATE profils SET essais = 0 WHERE nom = ?").bind(nom).run();
    } else if (/^\d{4}$/.test(pin) && (route === "/profil/connexion" || route === "/profil/definir-code")) {
      poserPin = await pinHache(pin);
    } else if (route === "/profil/connexion") {
      return { ok: false, erreur: "code à choisir", definir: true, nouveau: !pr };
    } else pinAFaire = true;   // ancien profil sans code : il continue de marcher, l'appli lui demande d'en choisir un
  }
  const reponse = (o) => ({ ...o, ...(renomme ? { renomme } : {}), ...(pinAFaire ? { pin_a_definir: true } : {}) });
  if (route === "/profil/definir-code") {
    if (!poserPin) return { ok: false, erreur: "code à 4 chiffres attendu" };
    await env.DB.prepare("UPDATE profils SET pin = ?, essais = 0, bloque = 0 WHERE nom = ?").bind(poserPin, nom).run();
    return { ok: true };
  }

  const rc = await rolesConf(env), mesDroits = droitsDe(nom, admin, rc), monRole = roleDe(nom, admin, rc);
  if (route.startsWith("/profil/admin-")) return await gestionProfils(route, p, admin, mesDroits, env, now);

  if (route.startsWith("/chat/")) return await chat(route, p, nom, affichage, admin, mesDroits, env, now);
  if (route === "/profil/moi") return reponse({ ok: true, nom: affichage, admin, role: monRole, droits: mesDroits, catalogue: DROITS });

  if (route === "/profil/connexion") {
    await env.DB.prepare("INSERT INTO profils (nom, affichage, cree, vu) VALUES (?, ?, ?, ?) ON CONFLICT(nom) DO UPDATE SET vu = excluded.vu").bind(nom, affichage, now, now).run();
    if (poserPin) await env.DB.prepare("UPDATE profils SET pin = ?, essais = 0, bloque = 0 WHERE nom = ?").bind(poserPin, nom).run();
    return reponse({ ok: true, nom: affichage, admin, role: monRole, droits: mesDroits, catalogue: DROITS });
  }
  if (route === "/profil/historique") {
    const rows = (await env.DB.prepare("SELECT code AS c, note AS n, t, titre AS ti FROM historique WHERE nom = ? ORDER BY t DESC LIMIT 50").bind(nom).all()).results || [];
    return reponse({ ok: true, historique: rows });
  }
  const type = TYPES.includes(p("type")) ? p("type") : "produit";
  if (route === "/profil/ajouter") {
    const article = p("article").slice(0, 120);
    if (!article) return { ok: false, erreur: "article manquant" };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO historique (nom, code, note, t, titre) VALUES (?, ?, '', ?, ?) ON CONFLICT(nom, code) DO UPDATE SET t = excluded.t, titre = CASE WHEN excluded.titre <> '' THEN excluded.titre ELSE historique.titre END").bind(nom, article, now, p("titre").slice(0, 120)),
      p("import") === "1" ? env.DB.prepare("SELECT 1") : env.DB.prepare("INSERT INTO activite (nom, t, type) VALUES (?, ?, ?)").bind(nom, now, type),
      env.DB.prepare("UPDATE profils SET vu = ? WHERE nom = ?").bind(now, nom),
      env.DB.prepare("DELETE FROM historique WHERE nom = ? AND code NOT IN (SELECT code FROM historique WHERE nom = ? ORDER BY t DESC LIMIT 50)").bind(nom, nom),
    ]);
    return reponse({ ok: true });
  }
  if (route === "/profil/activite") {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO activite (nom, t, type) VALUES (?, ?, ?)").bind(nom, now, type),
      env.DB.prepare("UPDATE profils SET vu = ? WHERE nom = ?").bind(now, nom),
    ]);
    return reponse({ ok: true });
  }
  if (route === "/profil/titre") {
    await env.DB.prepare("UPDATE historique SET titre = ? WHERE nom = ? AND code = ?").bind(p("titre").slice(0, 120), nom, p("article")).run();
    return reponse({ ok: true });
  }
  if (route === "/profil/note") {
    await env.DB.prepare("UPDATE historique SET note = ? WHERE nom = ? AND code = ?").bind(p("note").slice(0, 200), nom, p("article")).run();
    return reponse({ ok: true });
  }
  if (route === "/profil/supprimer") {
    await env.DB.prepare("DELETE FROM historique WHERE nom = ? AND code = ?").bind(nom, p("article")).run();
    return reponse({ ok: true });
  }
  if (route === "/profil/vider") {
    await env.DB.prepare("DELETE FROM historique WHERE nom = ?").bind(nom).run();
    return reponse({ ok: true });
  }
  return { ok: false, erreur: "route inconnue" };
}

async function pinHache(pin, sel) {
  sel = sel || [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bipbip:" + sel + ":" + pin));
  return sel + ":" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function pinOk(pin, stocke) {
  if (!/^\d{4}$/.test(String(pin || "")) || !stocke) return false;
  return (await pinHache(pin, stocke.split(":")[0])) === stocke;
}

// ---------- rôles : administrateur (tous les droits), manager (droits choisis par l'administrateur), équipe ----------
const DROITS = {
  infos: "Modifier, supprimer et épingler toutes les infos",
  planning: "Importer et modifier le planning",
  reassort: "Valider les demandes de réassort",
  chat: "Supprimer n'importe quel message du chat",
  stats: "Voir les statistiques de l'équipe",
  profils: "Gérer les profils (renommer, fusionner, supprimer, réinitialiser un code)",
};
async function rolesConf(env) {
  const lire = async (k, def) => { try { const r = await env.DB.prepare("SELECT valeur FROM config WHERE cle = ?").bind(k).first(); return r ? JSON.parse(r.valeur) : def; } catch (e) { return def; } };
  const roles = await lire("roles", {}), droits = await lire("droits_manager", []);
  return { roles: roles && typeof roles === "object" ? roles : {}, droits: Array.isArray(droits) ? droits.filter((d) => DROITS[d]) : [] };
}
function droitsDe(nom, admin, rc) { return admin ? Object.keys(DROITS) : rc.roles[nom] === "manager" ? rc.droits : []; }
function roleDe(nom, admin, rc) { return admin ? "admin" : rc.roles[nom] === "manager" ? "manager" : "equipe"; }

// ---------- gestion des profils par l'administrateur (renommer, fusionner, supprimer) ----------
async function gestionProfils(route, p, admin, droits, env, now) {
  const rc = await rolesConf(env);
  const ecrire = (k, v) => env.DB.prepare("INSERT INTO config (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").bind(k, JSON.stringify(v)).run();
  // rôles et droits : réservé à l'administrateur
  if (route === "/profil/admin-roles") {
    if (!admin) return { ok: false, erreur: "réservé à l'administrateur" };
    return { ok: true, roles: rc.roles, droits: rc.droits, catalogue: DROITS };
  }
  if (route === "/profil/admin-droits") {
    if (!admin) return { ok: false, erreur: "réservé à l'administrateur" };
    const liste = String(p("droits")).split(",").map((x) => x.trim()).filter((d) => DROITS[d]);
    await ecrire("droits_manager", [...new Set(liste)]);
    return { ok: true, droits: [...new Set(liste)] };
  }
  if (route === "/profil/admin-role" && !admin) return { ok: false, erreur: "réservé à l'administrateur" };
  if (!admin && !droits.includes("profils")) return { ok: false, erreur: "réservé à l'administrateur" };
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS renommages (ancien TEXT PRIMARY KEY, nouveau TEXT, affichage TEXT, t INTEGER)").run();
  const cle = (x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, 30).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const ancien = cle(p("cible"));
  const adminNom = (await env.DB.prepare("SELECT valeur FROM config WHERE cle = 'admin_nom'").first() || {}).valeur;
  if (!ancien || ancien === adminNom) return { ok: false, erreur: "profil invalide" };
  if (route === "/profil/admin-role") {
    const roles = { ...rc.roles };
    if (p("role") === "manager") roles[ancien] = "manager"; else delete roles[ancien];
    await ecrire("roles", roles);
    return { ok: true, role: roles[ancien] || "equipe" };
  }
  // un manager avec le droit « profils » ne peut pas toucher à un autre manager
  if (!admin && rc.roles[ancien] === "manager") return { ok: false, erreur: "seul l'administrateur peut modifier un manager" };
  if (route === "/profil/admin-code") {   // code oublié : le collègue en choisira un nouveau à sa prochaine ouverture
    await env.DB.prepare("UPDATE profils SET pin = NULL, essais = 0, bloque = 0 WHERE nom = ?").bind(ancien).run();
    return { ok: true };
  }
  if (route === "/profil/admin-supprimer") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM historique WHERE nom = ?").bind(ancien),
      env.DB.prepare("DELETE FROM activite WHERE nom = ?").bind(ancien),
      env.DB.prepare("DELETE FROM profils WHERE nom = ?").bind(ancien),
      env.DB.prepare("INSERT INTO renommages (ancien, nouveau, affichage, t) VALUES (?, '', '', ?) ON CONFLICT(ancien) DO UPDATE SET nouveau = '', affichage = '', t = excluded.t").bind(ancien, now),
    ]);
    return { ok: true };
  }
  if (route === "/profil/admin-renommer") {
    const affichage = p("vers").replace(/\s+/g, " ").trim().slice(0, 30), nouveau = cle(affichage);
    if (nouveau.length < 2) return { ok: false, erreur: "nouveau prénom manquant" };
    if (nouveau === adminNom) return { ok: false, erreur: "prénom réservé" };
    if (nouveau === ancien) {   // simple changement de majuscules / accents
      await env.DB.prepare("UPDATE profils SET affichage = ? WHERE nom = ?").bind(affichage, ancien).run();
      return { ok: true };
    }
    const existe = await env.DB.prepare("SELECT nom FROM profils WHERE nom = ?").bind(nouveau).first();
    const ops = [
      // l'historique est fusionné (le plus récent l'emporte en cas de doublon)
      env.DB.prepare("INSERT INTO historique (nom, code, note, t, titre) SELECT ?, code, note, t, titre FROM historique WHERE nom = ? ON CONFLICT(nom, code) DO UPDATE SET t = MAX(historique.t, excluded.t), note = CASE WHEN historique.note <> '' THEN historique.note ELSE excluded.note END, titre = CASE WHEN historique.titre <> '' THEN historique.titre ELSE excluded.titre END").bind(nouveau, ancien),
      env.DB.prepare("DELETE FROM historique WHERE nom = ?").bind(ancien),
      env.DB.prepare("UPDATE activite SET nom = ? WHERE nom = ?").bind(nouveau, ancien),
      existe
        ? env.DB.prepare("UPDATE profils SET cree = MIN(cree, (SELECT cree FROM profils WHERE nom = ?)), vu = MAX(vu, (SELECT vu FROM profils WHERE nom = ?)), affichage = ? WHERE nom = ?").bind(ancien, ancien, affichage, nouveau)
        : env.DB.prepare("UPDATE profils SET nom = ?, affichage = ? WHERE nom = ?").bind(nouveau, affichage, ancien),
      env.DB.prepare("DELETE FROM profils WHERE nom = ?").bind(ancien),
      env.DB.prepare("INSERT INTO renommages (ancien, nouveau, affichage, t) VALUES (?, ?, ?, ?) ON CONFLICT(ancien) DO UPDATE SET nouveau = excluded.nouveau, affichage = excluded.affichage, t = excluded.t").bind(ancien, nouveau, affichage, now),
      // les anciens alias qui pointaient vers l'ancien prénom suivent ; le nouveau prénom redevient libre
      env.DB.prepare("UPDATE renommages SET nouveau = ?, affichage = ? WHERE nouveau = ?").bind(nouveau, affichage, ancien),
      env.DB.prepare("DELETE FROM renommages WHERE ancien = ?").bind(nouveau),
    ];
    await env.DB.batch(ops);
    try { await env.DB.prepare("UPDATE messages SET nom = ?, affichage = ? WHERE nom = ?").bind(nouveau, affichage, ancien).run(); } catch (e) {}
    if (rc.roles[ancien]) { const roles = { ...rc.roles, [nouveau]: rc.roles[ancien] }; delete roles[ancien]; await ecrire("roles", roles); }
    return { ok: true, fusion: !!existe };
  }
  return { ok: false, erreur: "route inconnue" };
}

// ---------- lecture d'un planning (capture d'écran) par l'IA ----------
// Plusieurs modèles de vision essayés du plus fort au plus léger ; le premier qui rend un tableau exploitable gagne.
async function lirePlanning(image, env) {
  const consigne = "Tu lis la capture d'écran d'un planning hebdomadaire de vendeurs (logiciel de planning Fnac).\n" +
    "- En haut : un titre du genre « Novembre S46 » (S46 = semaine 46) puis les jours « Lu 09, Ma 10, Me 11, Je 12, Ve 13, Sa 14, Di 15 ».\n" +
    "- Chaque ligne = une personne, écrite NOM PRÉNOM en majuscules (ex. « DESORMIERE CHARLINE » → prénom Charline). La colonne « Théo » donne ses heures théoriques de la semaine (ex. 33.00 → 33). Ignore les colonnes Eq et (*).\n" +
    "- Chaque case jour contient soit « REPOSP » (= repos), soit « FNAC2S » suivi de 2 lignes d'horaires comme « 9.30-13.30 » et « 14.30-19.15 ». " +
    "Les 2 lignes entre parenthèses en dessous répètent les mêmes horaires : ne les compte pas une deuxième fois. Ignore « FNAC2S ».\n" +
    'Réponds UNIQUEMENT avec ce JSON, sans texte autour : {"semaine":"46","jour_lundi":"09","mois":"novembre","personnes":[{"prenom":"Charline","theo":33,"jours":["9.30-13.30 14.30-19.15","repos","7.45-12.00 13.00-17.00","repos","…","…","repos"]}]}\n' +
    "Toujours exactement 7 cases par personne, du lundi au dimanche. « repos » pour un repos, « ? » si illisible. Recopie les heures telles qu'écrites, n'en invente aucune. Mets toutes les personnes du planning.";
  const essais = [];
  const texte = (r) => typeof r === "string" ? r : String(r && (typeof r.response === "string" ? r.response : (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content)) || "");
  const lire = (r) => {
    if (r && r.response && typeof r.response === "object") return r.response;
    const t = texte(r).replace(/```(?:json)?/g, ""); const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) {}
    try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, "$1")); } catch (e) { return null; }
  };
  const msgImg = [{ role: "user", content: [{ type: "text", text: consigne }, { type: "image_url", image_url: { url: image } }] }];
  const modeles = [
    ["llama4", () => env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages: msgImg, max_tokens: 3000, temperature: 0 })],
    ["mistral", () => env.AI.run("@cf/mistralai/mistral-small-3.1-24b-instruct", { messages: msgImg, max_tokens: 3000, temperature: 0 })],
    ["gemma", () => env.AI.run("@cf/google/gemma-3-12b-it", { messages: msgImg, max_tokens: 3000, temperature: 0 })],
    ["llama32", async () => {
      // ce modèle demande d'accepter sa licence une fois par compte
      try { await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree" }); } catch (e) {}
      return env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { messages: [{ role: "user", content: consigne }], image, max_tokens: 3000 });
    }],
  ];
  const MOISN = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };
  for (const [nomM, fn] of modeles) {
    try {
      const brut = await fn(); const j = lire(brut);
      const liste = j && (Array.isArray(j.personnes) ? j.personnes : Array.isArray(j) ? j : null);
      if (liste && liste.length) {
        const personnes = liste.slice(0, 30).map((x) => {
          let pr = String(x.prenom || x.nom || "").trim().split(/\s+/).pop().slice(0, 30);
          pr = pr.charAt(0).toUpperCase() + pr.slice(1).toLowerCase();
          const js = Array.isArray(x.jours) ? x.jours : [];
          const th = parseFloat(String(x.theo == null ? "" : x.theo).replace(",", "."));
          return { prenom: pr, theo: th > 0 && th < 80 ? Math.round(th * 4) / 4 : null, jours: Array.from({ length: 7 }, (_, i) => { let v = js[i]; if (Array.isArray(v)) v = v.join(" "); v = String(v == null ? "?" : v).trim(); return (/repos/i.test(v) ? "repos" : v || "?").slice(0, 60); }) };
        }).filter((x) => x.prenom);
        const lisibles = personnes.reduce((n, x) => n + x.jours.filter((v) => v !== "?").length, 0);
        if (personnes.length && lisibles >= personnes.length * 3) {
          // date du lundi : déduite du numéro du jour + mois (année courante, ou suivante en fin d'année)
          let lundi = "";
          const jl = parseInt(j.jour_lundi, 10), mo = MOISN[String(j.mois || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")];
          if (jl >= 1 && jl <= 31 && mo) {
            const now = new Date(); let an = now.getUTCFullYear();
            if (mo === 1 && now.getUTCMonth() === 11) an++; else if (mo === 12 && now.getUTCMonth() === 0) an--;
            lundi = an + "-" + String(mo).padStart(2, "0") + "-" + String(jl).padStart(2, "0");
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(j.lundi || "")) lundi = j.lundi;
          return { ok: true, modele: nomM, semaine: String(j.semaine || "").replace(/\D/g, "").slice(0, 2), lundi, personnes, essais };
        }
        essais.push(nomM + " : tableau incomplet");
      } else essais.push(nomM + " : réponse inexploitable « " + texte(brut).slice(0, 80) + " »");
    } catch (e) { essais.push(nomM + " : " + String(e && e.message || e).slice(0, 120)); }
  }
  return { ok: false, erreur: "l'IA n'a pas réussi à lire ce planning", details: essais };
}



// ---------- tous les tomes d'une série : uniquement les catalogues (BnF, swisscovery), aucune IA ----------
// « One Piece. 107, Le héros légendaire » → { nom: "One Piece", n: 107, sous: "Le héros légendaire" }
function decouperSerie(titre) {
  const t = String(titre || "").split(" / ")[0].replace(/\s*\[.*?\]\s*/g, " ").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{2,120}?)\s*(?:\.|,|-|–|:)\s*(?:tome|t\.|vol\.?|volume|n°|no\.?|#)?\s*(\d{1,4})(?:\s*(?:,|:|\.|-|–)\s*(.*))?$/i);
  if (!m) return null;
  const n = parseInt(m[2], 10), nom = m[1].replace(/\s*[.,:;\-–]\s*$/, "").trim();
  if (!(n >= 1 && n <= 2000) || motsDe(nom).length === 0) return null;
  return { nom, n, sous: (m[3] || "").replace(/\s*[.,;:]\s*$/, "").trim() };
}
const normSerie = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
async function bnfPage(requete, debut) {
  const r = await get("https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=dublincore&maximumRecords=50&startRecord=" + debut + "&query=" + encodeURIComponent(requete), { timeout: 9000 });
  if (r.status !== 200) return { total: 0, recs: [], erreur: "BnF " + r.status };
  const total = parseInt((r.text.match(/<srw:numberOfRecords>(\d+)</) || [])[1] || "0", 10);
  const recs = [...r.text.matchAll(/<srw:record>([\s\S]*?)<\/srw:record>/g)].map((m) => {
    const rec = m[1], dc = (tag) => [...rec.matchAll(new RegExp("<dc:" + tag + "[^>]*>([\\s\\S]*?)</dc:" + tag + ">", "g"))].map((x) => strip(x[1]));
    const isbn = (rec.match(/ISBN\s*(97[89][\d\- ]{10,17})/) || [])[1];
    return { titre: dc("title")[0] || "", editeur: dc("publisher").join(" "), auteur: dc("creator")[0] || "", date: (dc("date")[0] || "").slice(0, 4), isbn: isbn ? isbn.replace(/\D/g, "") : "" };
  });
  return { total, recs };
}
async function serie(isbn) {
  if (!/^97[89]\d{10}$/.test(isbn)) return { trouve: false, erreur: "ISBN attendu" };
  // 1) le livre scanné : son titre catalogue dit s'il fait partie d'une série, et quel tome c'est
  const ici = (await bnfPage('bib.isbn all "' + isbn + '"', 1).catch(() => ({ recs: [] }))).recs[0];
  let base = ici && decouperSerie(ici.titre), editeur = ici ? ici.editeur : "", auteur = ici ? ici.auteur : "";
  if (!base) {
    // repli : catalogue suisse, champ « collection / série » (MARC 490 ou 800/830)
    const r = await get("https://swisscovery.slsp.ch/view/sru/41SLSP_NETWORK?version=1.2&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=1&query=alma.isbn%3D" + isbn).catch(() => null);
    if (r && r.status === 200) {
      const champ = (tag, code) => { const re = new RegExp('<datafield[^>]*tag="' + tag + '"[^>]*>([\\s\\S]*?)</datafield>'); const m = r.text.match(re); const sm = m && m[1].match(new RegExp('<subfield code="' + code + '">([\\s\\S]*?)</subfield>')); return sm ? strip(sm[1]).replace(/\s*[\/:;,.]\s*$/, "") : ""; };
      for (const tag of ["800", "830", "490"]) {
        const nom = champ(tag, tag === "800" ? "t" : "a"), v = (champ(tag, "v").match(/\d{1,4}/) || [])[0];
        if (nom && v) { base = { nom, n: parseInt(v, 10), sous: "" }; break; }
      }
      editeur = editeur || champ("264", "b") || champ("260", "b"); auteur = auteur || champ("100", "a");
    }
  }
  if (!base) return { trouve: false, raison: "pas de série", message: "Les catalogues n’indiquent pas que ce livre fait partie d’une série." };
  // 2) tous les livres du catalogue BnF portant ce titre de série (même auteur), page par page
  const mots = motsDe(base.nom).slice(0, 6), nomAuteur = motsDe(String(auteur).split(",")[0]).slice(-1)[0] || "";
  if (!mots.length) return { trouve: false, raison: "titre trop court" };
  const req = 'bib.title all "' + mots.join(" ") + '"' + (nomAuteur ? ' and bib.author all "' + nomAuteur + '"' : "");
  const p1 = await bnfPage(req, 1).catch(() => ({ total: 0, recs: [], erreur: "BnF injoignable" }));
  if (p1.erreur && !p1.recs.length) return { trouve: false, raison: "catalogue injoignable", message: "Le catalogue de la BnF ne répond pas, réessaie plus tard.", detail: p1.erreur };
  const pages = [];
  for (let d = 51; d <= Math.min(p1.total, 400); d += 50) pages.push(bnfPage(req, d).catch(() => ({ recs: [] })));
  const recs = p1.recs.concat(...(await Promise.all(pages)).map((x) => x.recs));
  // 3) on ne garde que « <même titre de série>. <numéro> » chez le même éditeur : pas d'hors-série, pas d'autre édition
  const cible = normSerie(base.nom), edMots = motsDe(String(editeur).replace(/^.*:\s*/, ""));
  const memeEditeur = (e) => !edMots.length || motsDe(e).some((w) => edMots.includes(w));
  const parN = {};
  for (const x of recs) {
    const d = decouperSerie(x.titre);
    if (!d || normSerie(d.nom) !== cible || !memeEditeur(x.editeur)) continue;
    const prec = parN[d.n];
    const mieux = !prec || (x.isbn && !prec.isbn) || (!!x.isbn === !!prec.isbn && /^9782/.test(x.isbn) && !/^9782/.test(prec.isbn)) || (!!x.isbn === !!prec.isbn && x.date && prec.date && x.date < prec.date);
    if (mieux) parN[d.n] = { n: d.n, titre: d.sous, isbn: x.isbn, annee: x.date };
  }
  if (!parN[base.n]) parN[base.n] = { n: base.n, titre: base.sous, isbn, annee: ici ? ici.date : "" };
  const tomes = Object.values(parN).sort((a, b) => a.n - b.n);
  // un seul tome trouvé : ce n'est sans doute pas une série (« Paris - 1900 »…) → on ne montre rien plutôt qu'une liste fausse
  if (tomes.length < 2) return { trouve: false, raison: "pas d'autres tomes", message: "Aucun autre tome de cette série dans le catalogue de la BnF." };
  const max = tomes[tomes.length - 1].n, manquants = [];
  for (let i = 1; i <= max && manquants.length < 60; i++) if (!parN[i]) manquants.push(i);
  return { trouve: true, source: "BnF", serie: base.nom, editeur: String(editeur).replace(/^.*:\s*/, "").replace(/\s*\(.*\)\s*$/, ""), ici: base.n, tomes, dernier: max, manquants, complet: !manquants.length };
}

// « @Inès » / « @ines » / « @Valoche » → noms de profil (sans l'auteur)
async function mentionsDe(env, texte, auteur) {
  const ms = [...String(texte || "").matchAll(/@([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,29})/g)].map((m) => m[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, ""));
  if (!ms.length) return [];
  const r = await env.DB.prepare("SELECT nom FROM profils").all().catch(() => ({ results: [] }));
  const parCle = {};
  (r.results || []).forEach((x) => { parCle[String(x.nom).replace(/[^a-z0-9]/g, "")] = x.nom; });
  return [...new Set(ms.map((m) => parCle[m]).filter((n) => n && n !== auteur))].slice(0, 10);
}
// ---------- notifications Web Push (RFC 8291 / 8292), sans service payant ----------
// les clés VAPID sont créées une seule fois et gardées dans la base (table config)
let vapidCache = null, tablePushOk = false;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...a) => { const n = a.reduce((t, x) => t + x.length, 0), r = new Uint8Array(n); let o = 0; for (const x of a) { r.set(x, o); o += x.length; } return r; };
const TE = new TextEncoder();
async function tablePush(env) {
  if (tablePushOk) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS push_abos (endpoint TEXT PRIMARY KEY, salon TEXT, nom TEXT, abo TEXT, types TEXT, t INTEGER)").run();
  tablePushOk = true;
}
async function clesVapid(env) {
  if (vapidCache) return vapidCache;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS config (cle TEXT PRIMARY KEY, valeur TEXT)").run();
  const r = await env.DB.prepare("SELECT valeur FROM config WHERE cle = 'vapid'").first();
  if (r) { vapidCache = JSON.parse(r.valeur); return vapidCache; }
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const v = { pub: b64u(await crypto.subtle.exportKey("raw", k.publicKey)), priv: await crypto.subtle.exportKey("jwk", k.privateKey) };
  await env.DB.prepare("INSERT OR IGNORE INTO config (cle, valeur) VALUES ('vapid', ?)").bind(JSON.stringify(v)).run();
  const r2 = await env.DB.prepare("SELECT valeur FROM config WHERE cle = 'vapid'").first();
  vapidCache = JSON.parse(r2.valeur);
  return vapidCache;
}
async function hmac(cle, data) {
  const k = await crypto.subtle.importKey("raw", cle, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
// chiffrement du message pour un téléphone (aes128gcm)
async function chiffrerPush(abo, texte) {
  const uaPub = deB64u(abo.keys.p256dh), auth = deB64u(abo.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, secret);
  const ikm = await hmac(prkKey, concat(TE.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])));
  const sel = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sel, ikm);
  const cek = (await hmac(prk, concat(TE.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(TE.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, concat(TE.encode(texte), new Uint8Array([2]))));
  return concat(sel, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, chiffre);
}
async function jetonVapid(env, endpoint) {
  const v = await clesVapid(env);
  const cle = await crypto.subtle.importKey("jwk", v.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const ent = b64u(TE.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corps = b64u(TE.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE + "/Fnac-scan/" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cle, TE.encode(ent + "." + corps));
  return "vapid t=" + ent + "." + corps + "." + b64u(sig) + ", k=" + v.pub;
}
function enArrierePlan(env, promesse) {
  const p = Promise.resolve(promesse).catch(() => {});
  try { if (env.__ctx && env.__ctx.waitUntil) env.__ctx.waitUntil(p); } catch (e) {}
  return p;
}
// envoie une notification aux membres du magasin abonnés à ce type (sauf l'auteur) ; renvoie le nombre d'envois réussis
async function pousser(env, salon, auteur, type, msg, seulement, sauf) {
  await tablePush(env);
  const r = await env.DB.prepare("SELECT endpoint, nom, abo, types FROM push_abos WHERE salon = ?").bind(salon).all();
  let cibles = (r.results || []).filter((x) => x.nom !== auteur && (type === "test" || type === "mention" || String(x.types || "").split(",").includes(type)));
  if (seulement) cibles = cibles.filter((x) => seulement.includes(x.nom));
  if (sauf && sauf.length) cibles = cibles.filter((x) => !sauf.includes(x.nom));
  if (type === "reassort") {
    // les demandes de réassort ne vont qu'à ceux qui peuvent les valider (administrateur, manager avec le droit)
    const rc = await rolesConf(env), adminNom = await env.DB.prepare("SELECT valeur FROM config WHERE cle = 'admin_nom'").first().catch(() => null);
    cibles = cibles.filter((x) => (adminNom && x.nom === adminNom.valeur) || droitsDe(x.nom, false, rc).includes("reassort"));
  }
  const corps = JSON.stringify({ titre: msg.titre, texte: msg.texte, url: msg.url || "./", tag: msg.tag || type });
  let ok = 0; const journal = [];
  await Promise.all(cibles.slice(0, 60).map(async (x) => {
    const hote = (() => { try { return new URL(x.endpoint).host; } catch (e) { return "?"; } })();
    try {
      const abo = JSON.parse(x.abo);
      const rep = await fetch(abo.endpoint, { method: "POST", headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: type === "chat" ? "high" : "normal", Authorization: await jetonVapid(env, abo.endpoint) }, body: await chiffrerPush(abo, corps) });
      const txt = rep.ok ? "" : (await rep.text().catch(() => "")).slice(0, 160);
      journal.push({ nom: x.nom, hote, statut: rep.status, txt });
      if (rep.status === 404 || rep.status === 410) await env.DB.prepare("DELETE FROM push_abos WHERE endpoint = ?").bind(x.endpoint).run();
      else if (rep.ok) ok++;
    } catch (e) { journal.push({ nom: x.nom, hote, erreur: String(e && e.message || e).slice(0, 160) }); }
  }));
  // dernier envoi gardé pour le diagnostic
  try { await env.DB.prepare("INSERT INTO config (cle, valeur) VALUES ('push_journal', ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").bind(JSON.stringify({ t: Date.now(), type, cibles: cibles.length, journal })).run(); } catch (e) {}
  pousser.dernier = { cibles: cibles.length, journal };
  return ok;
}

// ---------- chat d'équipe par magasin ----------
// Un « salon » par magasin, rejoint avec un code à 6 caractères que l'administrateur crée et partage à ses collègues.
let tablesChatOk = false;
async function chat(route, p, nom, affichage, admin, droits, env, now) {
  const peut = (d) => admin || (droits || []).includes(d);
  if (!tablesChatOk) {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS salons (code TEXT PRIMARY KEY, nom TEXT, cree_par TEXT, cree INTEGER)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, salon TEXT, nom TEXT, affichage TEXT, texte TEXT, t INTEGER)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS messages_salon ON messages (salon, id)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS planning (salon TEXT, debut TEXT, donnees TEXT, maj INTEGER, PRIMARY KEY (salon, debut))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, salon TEXT, nom TEXT, affichage TEXT, categorie TEXT, titre TEXT, texte TEXT, date_evt TEXT, epingle INTEGER DEFAULT 0, t INTEGER, img INTEGER DEFAULT 0, date_fin TEXT DEFAULT '')"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS post_images (post_id INTEGER PRIMARY KEY, image TEXT)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS reassort (id INTEGER PRIMARY KEY AUTOINCREMENT, salon TEXT, nom TEXT, affichage TEXT, sku TEXT, titre TEXT, quantite INTEGER DEFAULT 1, note TEXT, statut TEXT DEFAULT 'demande', valide_par TEXT, t INTEGER, t_valide INTEGER)"),
    ]);
    // photos du chat (ajout après coup : colonne img + table à part, comme pour les infos)
    try { await env.DB.prepare("ALTER TABLE messages ADD COLUMN img INTEGER DEFAULT 0").run(); } catch (e) {}
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS msg_images (msg_id INTEGER PRIMARY KEY, image TEXT)").run();
    tablesChatOk = true;
  }
  if (route === "/chat/creer") {
    if (!admin) return { ok: false, erreur: "réservé à l'administrateur" };
    const nomSalon = p("salon").replace(/\s+/g, " ").slice(0, 40);
    if (nomSalon.length < 2) return { ok: false, erreur: "nom du magasin manquant" };
    const L = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", alea = crypto.getRandomValues(new Uint8Array(6));
    const code = [...alea].map((n) => L[n % L.length]).join("");
    await env.DB.prepare("INSERT INTO salons (code, nom, cree_par, cree) VALUES (?, ?, ?, ?)").bind(code, nomSalon, nom, now).run();
    return { ok: true, code, salon: nomSalon };
  }
  if (route === "/chat/salons") {
    if (!admin) return { ok: false, erreur: "réservé à l'administrateur" };
    const r = await env.DB.prepare("SELECT code, nom FROM salons ORDER BY cree").all();
    return { ok: true, salons: r.results || [] };
  }
  // invitation (QR code de l'administrateur) : un jeton temporaire remplace le code du magasin, qui reste secret
  let codeInv = "";
  if (route === "/chat/rejoindre" && p("invit")) {
    const jeton = p("invit").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
    codeInv = (env.FICHES && jeton) ? (await env.FICHES.get("invit:" + jeton).catch(() => null)) || "" : "";
    if (!codeInv) return { ok: false, erreur: "invitation expirée", inconnu: true, expiree: true };
  }
  const code = codeInv || p("code").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const salon = code ? await env.DB.prepare("SELECT code, nom FROM salons WHERE code = ?").bind(code).first() : null;
  if (!salon) return { ok: false, erreur: "code inconnu", inconnu: true };
  if (route === "/chat/rejoindre") return { ok: true, code: salon.code, salon: salon.nom };
  if (route === "/chat/invitation") {
    if (!admin) return { ok: false, erreur: "réservé à l'administrateur" };
    if (!env.FICHES) return { ok: false, erreur: "stockage indisponible" };
    const L = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789", alea = crypto.getRandomValues(new Uint8Array(12));
    const jeton = [...alea].map((n) => L[n % L.length]).join("");
    await env.FICHES.put("invit:" + jeton, salon.code, { expirationTtl: 14 * 24 * 3600 });
    return { ok: true, jeton, expire: now + 14 * 24 * 3600 * 1000 };
  }
  // ---------- notifications (Web Push) ----------
  if (route === "/chat/push-cle") return { ok: true, cle: (await clesVapid(env)).pub };
  if (route === "/chat/push-abonner") {
    let abo; try { abo = JSON.parse(p("abo")); } catch (e) { abo = null; }
    if (!abo || !/^https:\/\//.test(abo.endpoint || "") || !abo.keys || !abo.keys.p256dh || !abo.keys.auth) return { ok: false, erreur: "abonnement invalide" };
    const types = String(p("types")).split(",").filter((t) => ["infos", "chat", "reassort"].includes(t)).join(",");
    await tablePush(env);
    await env.DB.prepare("INSERT INTO push_abos (endpoint, salon, nom, abo, types, t) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET salon = excluded.salon, nom = excluded.nom, abo = excluded.abo, types = excluded.types, t = excluded.t")
      .bind(abo.endpoint.slice(0, 600), code, nom, JSON.stringify(abo).slice(0, 2000), types, now).run();
    try { await env.DB.prepare("INSERT INTO config (cle, valeur) VALUES ('push_journal_abo', ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").bind(JSON.stringify({ t: now, nom, hote: new URL(abo.endpoint).host, types })).run(); } catch (e) {}
    return { ok: true, types };
  }
  if (route === "/chat/push-desabonner") {
    await tablePush(env);
    await env.DB.prepare("DELETE FROM push_abos WHERE endpoint = ? AND nom = ?").bind(p("endpoint").slice(0, 600), nom).run();
    return { ok: true };
  }
  if (route === "/chat/push-test") {
    const n = await pousser(env, code, "", "test", { titre: "BipBip 🔔", texte: "Les notifications marchent sur ce téléphone.", url: "./" }, [nom]);
    return { ok: true, envoyees: n, ...(pousser.dernier || {}) };
  }
  // planning de la semaine du magasin (visible des membres du chat, avec leur code personnel)
  if (route === "/chat/planning") {
    const depuis = new Date(now - 8 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const r = await env.DB.prepare("SELECT debut, donnees, maj FROM planning WHERE salon = ? AND debut >= ? ORDER BY debut LIMIT 4").bind(code, depuis).all();
    return { ok: true, peutImporter: peut("planning"), semaines: (r.results || []).map((x) => { let d = {}; try { d = JSON.parse(x.donnees); } catch (e) {} return { ...d, debut: x.debut, maj: x.maj }; }) };
  }
  // lecture d'une capture du planning par l'IA (le responsable relit et corrige avant de publier)
  if (route === "/chat/planning-lire") {
    if (!peut("planning")) return { ok: false, erreur: "réservé au responsable" };
    const image = p("image");
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 3000000) return { ok: false, erreur: "image illisible ou trop lourde" };
    return await lirePlanning(image, env);
  }
  // ---------- Réassort : demandes de produits, validées par le responsable quand la commande est faite ----------
  if (route.startsWith("/chat/reassort")) {
    const peutValider = peut("reassort");
    const id = parseInt(p("id"), 10) || 0;
    if (route === "/chat/reassort") {
      const r = await env.DB.prepare("SELECT id, nom AS n, affichage AS a, sku, titre, quantite AS q, note, statut, valide_par AS v, t, t_valide AS tv FROM reassort WHERE salon = ? AND (statut = 'demande' OR t_valide > ?) ORDER BY CASE statut WHEN 'demande' THEN 0 ELSE 1 END, t DESC LIMIT 150")
        .bind(code, now - 30 * 24 * 3600 * 1000).all();
      return { ok: true, peutValider, demandes: r.results || [] };
    }
    if (route === "/chat/reassort-ajouter") {
      const sku = p("sku").replace(/\s+/g, "");
      if (!/^\d{6,13}$/.test(sku)) return { ok: false, erreur: "SKU (8 chiffres) ou EAN (13 chiffres) attendu" };
      const deja = await env.DB.prepare("SELECT id FROM reassort WHERE salon = ? AND sku = ? AND statut = 'demande'").bind(code, sku).first();
      if (deja) return { ok: false, erreur: "déjà demandé : en attente de commande", deja: true };
      const q = Math.min(99, Math.max(1, parseInt(p("quantite"), 10) || 1));
      await env.DB.batch([
        env.DB.prepare("INSERT INTO reassort (salon, nom, affichage, sku, titre, quantite, note, statut, t) VALUES (?, ?, ?, ?, ?, ?, ?, 'demande', ?)").bind(code, nom, affichage, sku, p("titre").replace(/\s+/g, " ").slice(0, 120), q, p("note").replace(/\s+/g, " ").slice(0, 200), now),
        env.DB.prepare("DELETE FROM reassort WHERE salon = ? AND statut <> 'demande' AND t_valide < ?").bind(code, now - 60 * 24 * 3600 * 1000),
      ]);
      enArrierePlan(env, pousser(env, code, nom, "reassort", { titre: "📦 Demande de réassort", texte: affichage + " : " + q + " × " + (p("titre").replace(/\s+/g, " ").slice(0, 60) || sku) + " (" + sku + ")", url: "./?vue=rea" }));
      return { ok: true };
    }
    if (route === "/chat/reassort-valider") {
      if (!peutValider) return { ok: false, erreur: "réservé au responsable" };
      const statut = ["commande", "refuse", "demande"].includes(p("statut")) ? p("statut") : "commande";
      await env.DB.prepare("UPDATE reassort SET statut = ?, valide_par = ?, t_valide = ? WHERE id = ? AND salon = ?").bind(statut, statut === "demande" ? null : affichage, statut === "demande" ? null : now, id, code).run();
      return { ok: true };
    }
    if (route === "/chat/reassort-supprimer") {
      await env.DB.prepare("DELETE FROM reassort WHERE id = ? AND salon = ? AND ((nom = ? AND statut = 'demande') OR ?)").bind(id, code, nom, peutValider ? 1 : 0).run();
      return { ok: true };
    }
  }

  // ---------- Infos : publications du magasin (nouveautés, sorties, infos) ----------
  if (route === "/chat/posts") {
    const r = await env.DB.prepare("SELECT id, nom AS n, affichage AS a, categorie AS c, titre, texte, date_evt AS d, date_fin AS f, epingle AS e, t, img FROM posts WHERE salon = ? ORDER BY epingle DESC, t DESC LIMIT 60").bind(code).all();
    return { ok: true, peutTout: peut("infos"), posts: r.results || [] };
  }
  if (route === "/chat/poster") {
    const CATS = ["nouveaute", "sortie", "info", "operation"];
    const titre = p("titre").replace(/\s+/g, " ").slice(0, 120), texte = p("texte").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").slice(0, 1500);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(p("date")) ? p("date") : "";
    let fin = /^\d{4}-\d{2}-\d{2}$/.test(p("fin")) ? p("fin") : "";
    if (fin && d && fin < d) fin = d;
    // photo facultative, déjà réduite par l'appli (JPEG ~1000 px)
    const image = p("image");
    if (image && (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 1500000)) return { ok: false, erreur: "photo trop lourde ou illisible" };
    if (titre.length < 2 && !image) return { ok: false, erreur: "titre manquant" };
    const r = await env.DB.prepare("INSERT INTO posts (salon, nom, affichage, categorie, titre, texte, date_evt, date_fin, epingle, t, img) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id")
      .bind(code, nom, affichage, CATS.includes(p("categorie")) ? p("categorie") : "info", titre, texte, d, fin, now, image ? 1 : 0).first();
    if (image && r) await env.DB.prepare("INSERT INTO post_images (post_id, image) VALUES (?, ?)").bind(r.id, image).run();
    enArrierePlan(env, pousser(env, code, nom, "infos", { titre: "📢 Nouvelle info de " + affichage, texte: titre || "Photo partagée", url: "./?vue=info" }));
    // nettoyage : publications non épinglées de plus de 90 jours (et leurs photos)
    await env.DB.batch([
      env.DB.prepare("DELETE FROM post_images WHERE post_id IN (SELECT id FROM posts WHERE salon = ? AND epingle = 0 AND t < ? AND (date_fin = '' OR date_fin < ?))").bind(code, now - 90 * 24 * 3600 * 1000, new Date(now).toISOString().slice(0, 10)),
      env.DB.prepare("DELETE FROM posts WHERE salon = ? AND epingle = 0 AND t < ? AND (date_fin = '' OR date_fin < ?)").bind(code, now - 90 * 24 * 3600 * 1000, new Date(now).toISOString().slice(0, 10)),
    ]);
    return { ok: true };
  }
  if (route === "/chat/post-supprimer") {
    const id = parseInt(p("id"), 10) || 0;
    const r = await env.DB.prepare("DELETE FROM posts WHERE id = ? AND salon = ? AND (nom = ? OR ?) RETURNING id").bind(id, code, nom, peut("infos") ? 1 : 0).first();
    if (r) await env.DB.prepare("DELETE FROM post_images WHERE post_id = ?").bind(id).run();
    return { ok: true };
  }
  if (route === "/chat/post-image") {
    const r = await env.DB.prepare("SELECT i.image FROM post_images i JOIN posts p ON p.id = i.post_id WHERE i.post_id = ? AND p.salon = ?").bind(parseInt(p("id"), 10) || 0, code).first();
    return r ? { ok: true, image: r.image } : { ok: false, erreur: "photo introuvable" };
  }
  // modifier : l'auteur, ou le responsable / l'administrateur pour toutes les publications
  if (route === "/chat/post-modifier") {
    const id = parseInt(p("id"), 10) || 0;
    const post = await env.DB.prepare("SELECT nom FROM posts WHERE id = ? AND salon = ?").bind(id, code).first();
    if (!post) return { ok: false, erreur: "publication introuvable" };
    if (post.nom !== nom && !peut("infos")) return { ok: false, erreur: "seul l'auteur ou le responsable peut la modifier" };
    const CATS = ["nouveaute", "sortie", "info", "operation"];
    const titre = p("titre").replace(/\s+/g, " ").slice(0, 120), texte = p("texte").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").slice(0, 1500);
    if (titre.length < 2) return { ok: false, erreur: "titre manquant" };
    const d = /^\d{4}-\d{2}-\d{2}$/.test(p("date")) ? p("date") : "";
    let fin = /^\d{4}-\d{2}-\d{2}$/.test(p("fin")) ? p("fin") : "";
    if (fin && d && fin < d) fin = d;
    const image = p("image"), ops = [];
    if (image && (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 1500000)) return { ok: false, erreur: "photo trop lourde ou illisible" };
    ops.push(env.DB.prepare("UPDATE posts SET categorie = ?, titre = ?, texte = ?, date_evt = ?, date_fin = ? WHERE id = ?").bind(CATS.includes(p("categorie")) ? p("categorie") : "info", titre, texte, d, fin, id));
    if (image) {   // nouvelle photo
      ops.push(env.DB.prepare("INSERT INTO post_images (post_id, image) VALUES (?, ?) ON CONFLICT(post_id) DO UPDATE SET image = excluded.image").bind(id, image));
      ops.push(env.DB.prepare("UPDATE posts SET img = 1 WHERE id = ?").bind(id));
    } else if (p("retirerImage") === "1") {
      ops.push(env.DB.prepare("DELETE FROM post_images WHERE post_id = ?").bind(id));
      ops.push(env.DB.prepare("UPDATE posts SET img = 0 WHERE id = ?").bind(id));
    }
    await env.DB.batch(ops);
    return { ok: true };
  }
  if (route === "/chat/post-epingler") {
    if (!peut("infos")) return { ok: false, erreur: "réservé au responsable" };
    await env.DB.prepare("UPDATE posts SET epingle = CASE WHEN epingle = 1 THEN 0 ELSE 1 END WHERE id = ? AND salon = ?").bind(parseInt(p("id"), 10) || 0, code).run();
    return { ok: true };
  }
  if (route === "/chat/planning-maj") {
    if (!peut("planning")) return { ok: false, erreur: "réservé au responsable" };
    let donnees; try { donnees = JSON.parse(p("donnees")); } catch (e) { return { ok: false, erreur: "planning illisible" }; }
    if (!donnees || !Array.isArray(donnees.personnes) || !donnees.personnes.length) return { ok: false, erreur: "planning vide" };
    const debut = p("debut");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(debut)) return { ok: false, erreur: "date de début attendue (AAAA-MM-JJ)" };
    await env.DB.prepare("INSERT INTO planning (salon, debut, donnees, maj) VALUES (?, ?, ?, ?) ON CONFLICT(salon, debut) DO UPDATE SET donnees = excluded.donnees, maj = excluded.maj").bind(code, debut, JSON.stringify(donnees).slice(0, 20000), now).run();
    await env.DB.prepare("DELETE FROM planning WHERE salon = ? AND debut < ?").bind(code, new Date(now - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10)).run();
    return { ok: true };
  }
  if (route === "/chat/messages") {
    const apres = parseInt(p("apres"), 10) || 0;
    const r = await env.DB.prepare("SELECT id, affichage AS a, nom AS n, texte AS x, t, img FROM messages WHERE salon = ? AND id > ? ORDER BY id DESC LIMIT 80").bind(code, apres).all();
    return { ok: true, salon: salon.nom, messages: (r.results || []).reverse() };
  }
  if (route === "/chat/envoyer") {
    const texte = p("texte").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").slice(0, 500);
    const image = p("image");
    if (image && (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 1500000)) return { ok: false, erreur: "photo trop lourde ou illisible" };
    if (!texte && !image) return { ok: false, erreur: "message vide" };
    const r = await env.DB.prepare("INSERT INTO messages (salon, nom, affichage, texte, t, img) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").bind(code, nom, affichage, texte, now, image ? 1 : 0).first();
    if (image && r) await env.DB.prepare("INSERT INTO msg_images (msg_id, image) VALUES (?, ?)").bind(r.id, image).run();
    // les messages (et leurs photos) s'effacent tout seuls après 30 jours
    await env.DB.batch([
      env.DB.prepare("DELETE FROM msg_images WHERE msg_id IN (SELECT id FROM messages WHERE salon = ? AND t < ?)").bind(code, now - 30 * 24 * 3600 * 1000),
      env.DB.prepare("DELETE FROM messages WHERE salon = ? AND t < ?").bind(code, now - 30 * 24 * 3600 * 1000),
    ]);
    // @mentions : la personne citée est prévenue même si elle a coupé les notifications du chat
    const cites = await mentionsDe(env, texte, nom);
    const apercu = (image ? "📷 " : "") + (texte || "Photo").slice(0, 140);
    if (cites.length) enArrierePlan(env, pousser(env, code, nom, "mention", { titre: "📣 " + affichage + " t’a mentionné", texte: apercu, url: "./?vue=chat", tag: "mention-" + code }, cites));
    enArrierePlan(env, pousser(env, code, nom, "chat", { titre: "💬 " + affichage, texte: apercu, url: "./?vue=chat", tag: "chat-" + code }, null, cites));
    return { ok: true, mentions: cites };
  }
  if (route === "/chat/msg-image") {
    const r = await env.DB.prepare("SELECT i.image FROM msg_images i JOIN messages m ON m.id = i.msg_id WHERE i.msg_id = ? AND m.salon = ?").bind(parseInt(p("id"), 10) || 0, code).first();
    return r ? { ok: true, image: r.image } : { ok: false, erreur: "photo effacée" };
  }
  // prénoms de l'équipe pour l'autocomplétion des @mentions
  if (route === "/chat/membres") {
    const r = await env.DB.prepare("SELECT nom, affichage FROM profils WHERE vu > ? ORDER BY affichage").bind(now - 90 * 24 * 3600 * 1000).all();
    return { ok: true, membres: (r.results || []).filter((x) => x.nom !== nom).map((x) => ({ n: x.nom, a: x.affichage })) };
  }
  if (route === "/chat/supprimer") {
    const idm = parseInt(p("id"), 10) || 0;
    await env.DB.prepare("DELETE FROM msg_images WHERE msg_id IN (SELECT id FROM messages WHERE id = ? AND salon = ? AND (nom = ? OR ?))").bind(idm, code, nom, peut("chat") ? 1 : 0).run();
    await env.DB.prepare("DELETE FROM messages WHERE id = ? AND salon = ? AND (nom = ? OR ?)").bind(idm, code, nom, peut("chat") ? 1 : 0).run();
    return { ok: true };
  }
  return { ok: false, erreur: "route inconnue" };
}

// ---------- question du client sur une fiche ----------
async function question(q, contexte, env) {
  q = q.trim().slice(0, 300); contexte = contexte.trim().slice(0, 3000);
  if (!q) return { ok: false, erreur: "question vide" };
  const consigne = "Tu aides un vendeur de la Fnac (Suisse) à répondre à la question d'un client, en rayon, sur l'article dont la fiche est fournie. " +
    'Réponds en français, en JSON strict : {"reponse":"2 à 4 phrases courtes et concrètes","certitude":"sûr|probable|incertain"}. ' +
    "Appuie-toi d'abord sur la fiche, puis sur tes connaissances générales. Si tu ne sais pas, dis-le simplement et conseille de vérifier sur la boîte ou la fiche fnac.ch. N'invente aucun chiffre ni prix.";
  const r = await demanderIA(env, consigne, "FICHE DE L'ARTICLE :\n" + contexte + "\n\nQUESTION DU CLIENT : " + q, 300);
  if (!r || !r.reponse) return { ok: false, erreur: "pas de réponse de l'IA" };
  return { ok: true, reponse: String(r.reponse), certitude: r.certitude || "" };
}

// ---------- identification par photo ----------
async function vision(env, image, details) {
  const question = "Tu regardes la photo d'un article vendu à la Fnac. Dis d'abord QUEL OBJET c'est, puis lis le texte visible. " +
    "Trois cas : « produit » = tout appareil ou accessoire (enceinte, casque, écouteurs, console de jeu elle-même, manette, téléphone, tablette, TV, appareil photo, câble, jouet…) ; " +
    "« jeu » = uniquement un jeu vidéo (boîtier plat de jeu avec la jaquette d'un jeu, un logo de console et un logo PEGI) ; « livre » = livre, BD, manga ou album jeunesse (auteur, éditeur). Une console ou une manette est un « produit », pas un « jeu ». En cas de doute, choisis « produit ». " +
    'Réponds UNIQUEMENT en JSON : {"objet":"ce que c\'est en 1 à 3 mots (ex. enceinte bluetooth, console, jeu vidéo, roman, album jeunesse)","type":"produit|jeu|livre","titre":"titre exact lu (jeu ou livre) ou nom du produit","plateforme":"console seulement si c\'est un jeu vidéo, sinon vide","marque":"marque ou éditeur","modele":"modèle si produit","auteur":"auteur si livre","pegi":"chiffre PEGI visible, sinon vide"}. N\'invente rien : laisse vide ce que tu ne lis pas.';
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
      '{"objet":"ce que c\'est en 1 à 3 mots","type":"produit|jeu|livre","titre":"","plateforme":"","marque":"","modele":"","auteur":"","pegi":""}. Une console, une manette, une enceinte, un casque… est un « produit ». Laisse vide ce qui n\'est pas indiqué.', desc.slice(0, 2000), 200);
    if (o && (o.titre || o.title)) { details.push("titre extrait de la description"); return { ...o, titre: o.titre || o.title, modeleIA: "description" }; }
  }
  return null;
}

// ---------- retrouver un livre (et son ISBN) à partir du titre lu sur la couverture ----------
const motsDe = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").split(" ")
  .filter((w) => w.length > 2 && !["les", "des", "une", "aux", "pour", "avec", "dans", "sur", "the", "and", "tome"].includes(w));
// part des mots lus qui se retrouvent dans le titre trouvé (tolère une lettre mal lue : « Malcel » ≈ « Marcel »)
function ressemblance(lu, trouve) {
  const a = motsDe(lu), b = motsDe(trouve);
  if (!a.length || !b.length) return 0;
  const proche = (x, y) => x === y || (x.length === y.length && x.length > 3 && [...x].filter((c, i) => c !== y[i]).length <= 1);
  return a.filter((x) => b.some((y) => proche(x, y))).length / a.length;
}
async function bnfTitre(requete) {
  const r = await get("https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=dublincore&maximumRecords=8&query=" + encodeURIComponent(requete), { timeout: 7000 });
  if (r.status !== 200) return [];
  return [...r.text.matchAll(/<srw:record>([\s\S]*?)<\/srw:record>/g)].map((m) => {
    const rec = m[1], dc = (tag) => [...rec.matchAll(new RegExp("<dc:" + tag + "[^>]*>([\\s\\S]*?)</dc:" + tag + ">", "g"))].map((x) => strip(x[1]));
    const isbn = (rec.match(/ISBN\s*(97[89][\d\- ]{10,17})/) || [])[1];
    return { titre: (dc("title")[0] || "").split(" / ")[0], editeur: dc("publisher").join(" "), auteur: dc("creator").join(" "), date: dc("date")[0] || "", isbn: isbn ? isbn.replace(/\D/g, "") : "" };
  }).filter((x) => x.isbn && x.isbn.length === 13);
}
async function openlibTitre(titre, auteur) {
  const r = await get("https://openlibrary.org/search.json?limit=5&fields=title,author_name,isbn,publisher&title=" + encodeURIComponent(titre) + (auteur ? "&author=" + encodeURIComponent(auteur) : ""), { timeout: 7000 });
  if (r.status !== 200) return [];
  let j; try { j = JSON.parse(r.text); } catch (e) { return []; }
  return (j.docs || []).map((d) => ({ titre: d.title || "", auteur: (d.author_name || []).join(" "), editeur: (d.publisher || []).join(" "),
    isbn: ((d.isbn || []).filter((i) => /^9782/.test(i))[0] || (d.isbn || []).filter((i) => /^97[89]\d{10}$/.test(i))[0] || "") })).filter((x) => x.isbn);
}
async function chercherLivre(titre, auteur, editeur) {
  const mots = motsDe(titre);
  if (!mots.length) return null;
  const nomAuteur = motsDe(auteur).slice(-1)[0] || "";
  const req = [];
  const q = (ws) => 'bib.title all "' + ws.join(" ") + '"';
  if (nomAuteur) req.push(q(mots) + ' and bib.author all "' + nomAuteur + '"');
  req.push(q(mots));
  // un mot mal lu fait échouer la recherche : on réessaie sans chacun des mots (titres de 3 mots ou plus)
  if (mots.length >= 3) mots.slice(0, 5).forEach((_, i) => req.push(q(mots.filter((__, k) => k !== i))));
  const listes = await Promise.all(req.slice(0, 7).map((x) => bnfTitre(x).catch(() => [])).concat([openlibTitre(titre, auteur).catch(() => [])]));
  const marque = motsDe(editeur), aut = motsDe(auteur);
  const tous = listes.flat().map((x) => ({ ...x,
    score: ressemblance(titre, x.titre) * 10 + (marque.length && motsDe(x.editeur).some((w) => marque.includes(w)) ? 3 : 0) +
      (aut.length && motsDe(x.auteur).some((w) => aut.includes(w)) ? 3 : 0) + (/^9782/.test(x.isbn) ? 1 : 0) }))
    .filter((x) => ressemblance(titre, x.titre) >= 0.6 && ressemblance(x.titre, titre) >= 0.5);
  tous.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
  return tous[0] || null;
}

const APPAREIL = /\b(enceintes?|speakers?|haut-parleurs?|casques?|headphones?|headset|[ée]couteurs|earbuds|airpods|consoles?|manettes?|controllers?|gamepad|joy-?con|dualsense|t[ée]l[ée]phone|smartphone|iphone|galaxy|tablette|ipad|t[ée]l[ée]viseur|tv|[ée]cran|moniteur|monitor|appareil photo|camera|cam[ée]ra|objectif|drone|montre connect[ée]e|smartwatch|watch|chargeur|charger|c[âa]ble|batterie externe|power ?bank|clavier|keyboard|souris|mouse|imprimante|printer|routeur|disque dur|ssd|cl[ée] usb|ordinateur|laptop|pc portable|macbook|barre de son|soundbar|platine|tourne-disque|radio|r[ée]veil|aspirateur|robot|trottinette|jouet|figurine|peluche|lego)\b/i;
const APPAREIL_FORT = /\b(enceintes?|haut-parleurs?|casques? audio|headphones?|[ée]couteurs|earbuds|airpods|manettes?|controllers?|dualsense|joy-?con|barre de son|soundbar|chargeur|power ?bank|batterie externe|console de jeux?)\b/i;
const MARQUES_TECH = /\b(jbl|bose|sonos|marshall|ultimate ears|beats|sony|samsung|apple|logitech|razer|steelseries|corsair|hyperx|turtle beach|philips|lg|xiaomi|huawei|garmin|gopro|dji|canon|nikon|fujifilm|nintendo|playstation|xbox|microsoft|lenovo|asus|acer|hp|dell|anker|belkin|bang ?& ?olufsen|sennheiser|jabra|devialet|harman|denon|yamaha|pioneer|panasonic|tcl|hisense|dyson)\b/i;
async function photo(image, env) {
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(image)) return { trouve: false, erreur: "image attendue (data:image/jpeg;base64,...)" };
  if (image.length > 3000000) return { trouve: false, erreur: "image trop lourde" };
  if (!env || !env.AI) return { trouve: false, erreur: "IA indisponible" };
  const details = [];
  const v = await vision(env, image, details);
  if (!v) return { trouve: false, erreur: "rien de lisible sur la photo", details };
  let type = String(v.type || "").toLowerCase();
  // « plateforme » ne compte que si c'est une vraie console (l'IA renvoie parfois « aucune », « N/A »…)
  v.plateforme = PLATEFORMES.test(String(v.plateforme || "")) ? v.plateforme : "";
  // un appareil (enceinte, console elle-même, casque…) est toujours un produit, quoi qu'ait répondu l'IA
  const texteLu = [v.objet, v.titre, v.marque, v.modele].join(" ");
  const objetJeuOuLivre = /jeu vid[ée]o|video game|livre|roman|bd|manga|album|book/i.test(String(v.objet || ""));
  if (!v.auteur && !v.pegi && !objetJeuOuLivre && (APPAREIL.test(String(v.objet || "")) || APPAREIL_FORT.test([v.titre, v.modele].join(" ")))) type = "produit";
  if (type.startsWith("jeu") && !v.plateforme && !v.pegi && MARQUES_TECH.test(texteLu)) type = "produit";
  // « jeu » dont le titre n'est que le nom de la console (« PlayStation 5 Pro », « Nintendo Switch 2 ») : c'est la console elle-même
  if (type.startsWith("jeu") && !v.pegi && !String(v.titre || "").replace(PLATEFORMES, "").replace(/\b(pro|slim|digital|edition|édition|oled|lite|console|nintendo|sony|microsoft|\d+\s*(go|to|gb|tb))\b/gi, "").replace(/[^a-z0-9]/gi, "")) type = "produit";
  details.push("vu : " + (v.objet || "?") + " → " + (type || "?"));
  const aCouverture = !v.plateforme && !v.pegi;   // ni console ni PEGI : probablement pas un jeu vidéo
  // livre (ou jeu sans console) : on cherche le titre dans les catalogues pour retrouver l'ISBN
  if (type.startsWith("livre") || (aCouverture && (type.startsWith("jeu") || v.auteur))) {
    const trouve = await chercherLivre(v.titre, v.auteur, v.marque).catch(() => null);
    details.push("catalogue : " + (trouve ? trouve.titre + " (" + trouve.isbn + ")" : "aucun livre correspondant"));
    if (trouve) return { trouve: true, type: "livre", source: "photo", isbn: trouve.isbn, titre: trouve.titre, auteur: v.auteur || "", editeur: v.marque || "", lu: v, details };
    if (type.startsWith("jeu")) type = v.auteur ? "livre" : "jeu";
    // « livre » sans auteur et introuvable dans les catalogues : plus probablement un produit
    else if (!v.auteur && !/livre|roman|bd|manga|album|book/i.test(String(v.objet || ""))) type = "produit";
  }
  if (type.startsWith("produit")) v.plateforme = "";
  if (type.startsWith("jeu") || (v.plateforme && !type.startsWith("livre"))) {
    const p = { trouve: true, source: "photo", nom: [v.titre, v.plateforme].filter(Boolean).join(" "), marque: v.marque || "", modele: "",
      categorie: "Jeu vidéo", description: v.pegi ? "PEGI " + v.pegi + " visible sur la boîte" : "", image: "", plateforme: plateformeDe(v.plateforme || "") || v.plateforme || "" };
    const r = await jeu(p, env);
    // pas de console, pas de PEGI et inconnu de Wikidata : ce n'est sans doute pas un jeu vidéo → produit (ou livre s'il y a un auteur)
    if (aCouverture && !(r.jeu && r.jeu.trouve)) type = v.auteur ? "livre" : "produit";
    else {
      if (v.pegi && r.jeu && !r.jeu.pegi) r.jeu.pegi = "PEGI " + v.pegi;
      if (v.marque && r.jeu && !r.jeu.studio) r.jeu.studio = v.marque;
      return { ...r, lu: v };
    }
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
      editeur: pick(b.editeur, s.editeur, g.editeur, o.editeur), date: meilleureDate([g.date, o.date, b.date, s.date], b.date || s.date),
      pages: pick(b.pages, s.pages, g.pages, o.pages), genre: pick(g.genre), age: pick(s.public), description: pick(s.description, g.description) };
    if (!f.titre) return { trouve: false, code };
    return { trouve: true, code, nom: f.titre + (f.auteur ? " (" + f.auteur + ")" : ""), texte: "Livre\n" + infosLivre(f, [b.sujets, s.sujets].filter(Boolean).join(" ; ")) };
  }
  const p = await upc(code);
  if (!p.trouve) return { trouve: false, code };
  return { trouve: true, code, nom: p.nom, texte: ["Produit : " + p.nom, p.marque && "Marque : " + p.marque, p.modele && "Modèle : " + p.modele,
    p.categorie && "Catégorie : " + p.categorie, p.description && "Description : " + p.description].filter(Boolean).join("\n") };
}

// un article à comparer : EAN, "s:SKU" ou "p:nom" (identifié par photo) ; nom = titre déjà connu par l'appli
async function ficheArticle(code, nom, env) {
  if (code.startsWith("p:")) nom = code.slice(2).trim() || nom;
  else if (/^\d{8,13}$/.test(code)) { const f = await fichePour(code, env); if (f.trouve) return f; }
  if (nom) return { trouve: true, code, nom, texte: "Article : " + nom };
  return { trouve: false, code };
}
async function comparer(a, b, env, na = "", nb = "") {
  if (!a || !b) return { trouve: false, erreur: "deux articles attendus (?a=...&b=...)" };
  const [fa, fb] = await Promise.all([ficheArticle(a, na, env), ficheArticle(b, nb, env)]);
  if (!fa.trouve || !fb.trouve) return { trouve: false, introuvables: [fa, fb].filter((x) => !x.trouve).map((x) => x.code) };
  const consigne = "Tu aides un vendeur de la Fnac (Suisse) dont le client hésite entre deux articles. Réponds en français, en JSON strict sans texte autour : " +
    '{"lignes":[{"critere":"critère court","a":"valeur pour l\'article A","b":"valeur pour l\'article B"}],"conseil":"1 à 2 phrases : lequel conseiller selon le profil du client"}. ' +
    "Donne 4 à 6 critères qui comptent vraiment pour choisir. Appuie-toi sur les infos fournies et tes connaissances générales ; n'invente pas de chiffres précis que tu ignores, écris alors « ? ».";
  const ia = await demanderIA(env, consigne, "ARTICLE A\n" + fa.texte + "\n\nARTICLE B\n" + fb.texte, 600);
  return { trouve: !!ia, a: { code: a, nom: fa.nom }, b: { code: b, nom: fb.nom }, ia };
}

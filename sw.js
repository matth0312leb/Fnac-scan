// Réseau d'abord (toujours la dernière version), copie locale si pas de connexion.
var CACHE = "scan-v75";
var FILES = ["./", "index.html", "manifest.json", "bipbip-192.png", "badge-96.png", "logo.svg",
  "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js"];
self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(FILES); }).catch(function(){}));
  self.skipWaiting();
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener("fetch", function(e){
  if (e.request.method !== "GET") return;
  var u = e.request.url;
  if (u.indexOf(self.location.origin) !== 0 && !/cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u)) return;
  e.respondWith(fetch(e.request).then(function(r){
    var copy = r.clone();
    caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
    return r;
  }).catch(function(){ return caches.match(e.request); }));
});

// ---------- notifications (posts, chat, réassort) envoyées par le serveur BipBip ----------
self.addEventListener("push", function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { titre: "BipBip", texte: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titre || "BipBip", {
    body: d.texte || "", icon: "bipbip-192.png", badge: "badge-96.png",
    tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var cible = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(cs){
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].url.indexOf(self.registration.scope) === 0 && "focus" in cs[i]) {
        cs[i].postMessage({ type: "ouvrir", url: cible });
        return cs[i].focus();
      }
    }
    return self.clients.openWindow(cible);
  }));
});

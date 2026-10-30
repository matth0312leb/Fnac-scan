// Réseau d'abord (toujours la dernière version), copie locale si pas de connexion.
var CACHE = "scan-v11";
var FILES = ["./", "index.html", "manifest.json", "icon-192.png",
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
  if (u.indexOf(self.location.origin) !== 0 && u.indexOf("cdn.jsdelivr.net") < 0) return;
  e.respondWith(fetch(e.request).then(function(r){
    var copy = r.clone();
    caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
    return r;
  }).catch(function(){ return caches.match(e.request); }));
});

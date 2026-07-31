const CACHE_NAME = 'leitor-desenho-v2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './js/framing/fallback-detector.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia: network-first para não travar em versões antigas do app,
// com fallback para cache quando offline. Chamadas à API do Gemini
// nunca são interceptadas/cacheadas.
//
// Guards:
// - Só GET: cache.put de POST/PUT lança rejeição não tratada e polui o
//   cache. Outros métodos passam direto ao network.
// - /dataset/: o harness lê o dataset de dev; cachear essas respostas
//   (imagens grandes, mutáveis entre coletas) é indesejado e atrapalha
//   a re-gravação. Ancorado em self.registration.scope (raiz efetiva do
//   app) para funcionar mesmo sob subpath (ex.: GitHub Pages de projeto);
//   starts('/dataset/') assumiria raiz do domínio e casaria /vendor/dataset/
//   de terceiro por acidente.
const DATASET_PATH = new URL('./dataset/', self.registration.scope).pathname;
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.includes('generativelanguage.googleapis.com')) {
    return; // deixa passar direto, sem cache
  }
  if (event.request.method !== 'GET') {
    return; // não cacheia métodos não-GET
  }
  if (url.pathname.startsWith(DATASET_PATH)) {
    return; // dataset de dev: sempre network, nunca cache
  }

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

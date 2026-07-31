/* =========================================================================
   Service Worker — Leitor de Desenho Projetivo (F1, passo 7)

   Dois caches:
   - APP_CACHE (leitor-desenho-v3): app shell. Bump a cada release do app.
   - VENDOR_CACHE (leitor-vendor-v1): vendor/ (OpenCV.js). Path versionado
     = imutável por construção. Activate limpa só prefixo leitor-desenho-,
     preservando o vendor cache entre bumps (8 MB re-download em 3G evitado).

   Rota cache-first para vendor/ (ancorada no scope, como DATASET_PATH):
   o OpenCV.js é ~10 MB e versionado no path — não há razão para network-first.
   ========================================================================= */

const APP_CACHE = 'leitor-desenho-v3';
const VENDOR_CACHE = 'leitor-vendor-v1';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './js/speech.js',
  './js/framing/stats.js',
  './js/framing/fallback-detector.js',
  './js/framing/guide.js',
  './js/framing/audio.js',
  './js/framing/frame-worker.js', // modo de precisão sobe offline
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // Não adicionar: vendor/opencv-*.js (rota cache-first própria, 10 MB),
  // test-harness.js (dev), stabilizer.js/haptics.js (F3/F5, ainda não existem).
];

self.addEventListener('install', (event) => {
  // Promise.allSettled: best-effort precache — não derrubar o install inteiro
  // por um recurso faltante (ex.: ícone ainda não gerado).
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) =>
      Promise.allSettled(ASSETS.map((u) => cache.add(u)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Limpa só caches com prefixo leitor-desenho- — preserva leitor-vendor-v1.
  // Sem isso, cada bump (v3→v4→v5…) joga fora os 10 MB do OpenCV e força
  // re-download em 3G.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith('leitor-desenho-') && k !== APP_CACHE).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Estratégia: network-first para o app shell (não travar em versões antigas),
// cache-first para vendor/ (path versionado = imutável). Chamadas à API do
// Gemini nunca são interceptadas/cacheadas.
//
// Guards:
// - Só GET: cache.put de POST/PUT lança rejeição não tratada e polui o cache.
// - /dataset/: o harness lê o dataset de dev; cachear essas respostas é
//   indesejado. Ancorado em self.registration.scope para funcionar sob subpath.
// - /vendor/: cache-first imutável (path versionado). Ancorado em scope.
const DATASET_PATH = new URL('./dataset/', self.registration.scope).pathname;
const VENDOR_PATH = new URL('./vendor/', self.registration.scope).pathname;

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

  // Rota cache-first para vendor/ (OpenCV.js ~10 MB, path versionado).
  // Ancorado no scope + checa origin para não casar vendor/ de terceiro.
  // G4 (review): só cache.put se resp.ok — um 404/502 gravado permanentemente
  // num path imutável faria o modo de precisão nunca mais ativar.
  if (url.origin === self.location.origin && url.pathname.startsWith(VENDOR_PATH)) {
    event.respondWith(
      caches.open(VENDOR_CACHE).then((cache) =>
        cache.match(event.request).then((cached) =>
          cached || fetch(event.request).then((resp) => {
            if (resp.ok) cache.put(event.request, resp.clone());
            return resp;
          })
        )
      )
    );
    return;
  }

  // Network-first para o resto do app shell.
  // G4 (review): só cache.put se resp.ok — não cachear respostas de erro.
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(APP_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

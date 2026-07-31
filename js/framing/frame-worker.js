/* =========================================================================
   frame-worker.js — Worker clássico com OpenCV.js (F1, passo 2)

   Worker clássico (não módulo) — usa importScripts para carregar o OpenCV.js.
   Path: ../../vendor/opencv-4.13.0.js (resolve contra self.location, a URL
   do worker em js/framing/, dois níveis até a raiz do app).

   Pipeline Otsu-only (F1): cvtColor RGBA→GRAY → GaussianBlur 3×3 →
   threshold OTSU → morphologyEx CLOSE 5×5 → findContours RETR_EXTERNAL →
   approxPolyDP 0.02*peri → selecionar quadrilátero convexo de maior
   contourArea. Cascata (CLAHE/adaptive/Canny) é F2.

   Init do cv: async IIFE cobrindo os 3 formatos de build (A5, rev. 4):
   factory (typeof cv === 'function'), Promise (cv instanceof Promise),
   callback (onRuntimeInitialized). Usa variável local `instance` — nunca
   reatribui cv global (build verificado: var cv, mas variável local é
   defensivo contra builds futuros com const).

   B2 (rev. 4): frames antes de ready emitem {type:'notready'} (tipo
   distinto de error) — o guia só limpa inFlight, sem trocar fonte nem
   agendar retry.

   Vazamento: contours é MatVector — .delete() não deleta os Mats
   individuais de contours.get(i). Cada Mat retornado por .get(i) precisa
   ser deletado após uso. Comentar explicitamente.
   ========================================================================= */

importScripts('../../vendor/opencv-4.13.0.js');

// Estado do pipeline — pré-alocado fora do loop para evitar vazamento.
// Realocado se width/height mudarem (resize implícito).
let cvInstance = null;
let src = null, gray = null, blur = null, bin = null, hierarchy = null;
let kernel5x5 = null, kernel3x3 = null, contours = null;
let currentW = 0, currentH = 0;
let ready = false;

// Contador de Mats em debug — auditoria formal (1000 iterações) é F6.
// let matAllocCount = 0;

/**
 * Pré-aloca os Mats do pipeline no tamanho dado. Deleta os anteriores se
 * o tamanho mudou (resize implícito — cada frame carrega width/height).
 */
function allocMats(cv, w, h) {
  if (w === currentW && h === currentH && src) return;
  freeMats(cv);
  src = cv.Mat.zeros(h, w, cv.CV_8UC4);
  gray = cv.Mat.zeros(h, w, cv.CV_8UC1);
  blur = cv.Mat.zeros(h, w, cv.CV_8UC1);
  bin = cv.Mat.zeros(h, w, cv.CV_8UC1);
  hierarchy = new cv.Mat();
  kernel5x5 = cv.Mat.ones(5, 5, cv.CV_8U);
  kernel3x3 = cv.Mat.ones(3, 3, cv.CV_8U);
  contours = new cv.MatVector();
  currentW = w;
  currentH = h;
}

function freeMats(cv) {
  if (src) { try { src.delete(); } catch (e) {} src = null; }
  if (gray) { try { gray.delete(); } catch (e) {} gray = null; }
  if (blur) { try { blur.delete(); } catch (e) {} blur = null; }
  if (bin) { try { bin.delete(); } catch (e) {} bin = null; }
  if (hierarchy) { try { hierarchy.delete(); } catch (e) {} hierarchy = null; }
  if (kernel5x5) { try { kernel5x5.delete(); } catch (e) {} kernel5x5 = null; }
  if (kernel3x3) { try { kernel3x3.delete(); } catch (e) {} kernel3x3 = null; }
  if (contours) { try { contours.delete(); } catch (e) {} contours = null; }
  currentW = 0;
  currentH = 0;
}

/**
 * Inicializa o pipeline com a instância do cv resolvida. Chamada pela IIFE
 * após aguardar a init (3 formatos de build, A5).
 */
function initPipeline(cv) {
  cvInstance = cv;
  // Mats são alocados no primeiro frame (precisa de width/height).
  self.postMessage({ type: 'ready' });
  ready = true;
}

// Inicialização do cv — async IIFE cobrindo os 3 formatos de build (A5).
// Worker clássico não é módulo — top-level await é SyntaxError.
(async () => {
  try {
    if (typeof cv === 'function') {
      // Build factory (recente): typeof cv === 'function' → cv() retorna Promise.
      // NÃO reatribui cv global — usa variável local (defensivo contra const).
      const instance = await cv();
      initPipeline(instance);
    } else if (cv instanceof Promise) {
      // Build Promise (comum): cv já é a Promise que resolve para o módulo.
      const instance = await cv;
      initPipeline(instance);
    } else {
      // Build callback (antigo): cv é objeto, onRuntimeInitialized dispara.
      await new Promise(resolve => {
        if (cv.onRuntimeInitialized) {
          const orig = cv.onRuntimeInitialized;
          cv.onRuntimeInitialized = () => { orig && orig(); resolve(); };
        } else {
          cv.onRuntimeInitialized = resolve;
        }
      });
      initPipeline(cv);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: 'cv-init: ' + (err && err.message || err) });
  }
})();

// Handler de mensagens — processa frames.
self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'frame') return;

  // B2: frames antes de ready emitem notready (tipo distinto de error).
  if (!ready || !cvInstance) {
    self.postMessage({ type: 'notready' });
    return;
  }

  try {
    processFrame(msg);
  } catch (err) {
    self.postMessage({ type: 'error', message: 'process: ' + (err && err.message || err) });
  }
};

// Erros não capturados no worker — emite error real (não notready).
self.onerror = (msg) => {
  self.postMessage({ type: 'error', message: 'onerror: ' + msg });
};

self.onmessageerror = (e) => {
  self.postMessage({ type: 'error', message: 'onmessageerror' });
};

/**
 * Processa um frame: pipeline Otsu-only (F1).
 * @param {{width:number, height:number, buffer:ArrayBuffer}} msg
 */
function processFrame(msg) {
  const cv = cvInstance;
  const w = msg.width, h = msg.height;
  const t0 = performance.now();

  // Resize implícito: se mudou, realoca Mats no novo tamanho.
  allocMats(cv, w, h);

  // Copia o buffer transferido para o Mat src (RGBA). O buffer foi doado ao
  // worker via transfer — src.data.set copia para o heap WASM (uma cópia).
  src.data.set(new Uint8Array(msg.buffer));

  // Pipeline Otsu-only:
  // 1. RGBA → GRAY
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // 2. GaussianBlur 3×3 (suaviza ruído antes do threshold)
  cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
  // 3. Threshold OTSU (binariza com limiar automático)
  cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  // 4. MorphologyEx CLOSE 5×5 (fecha buracos na folha)
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel5x5);
  // 5. findContours RETR_EXTERNAL (só contornos externos)
  cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // 6. Selecionar quadrilátero convexo de maior contourArea.
  let best = null;
  let bestArea = 0;
  const minArea = (w * h) * 0.08; // ≥8% do frame
  for (let i = 0; i < contours.size(); i++) {
    // VAZAMENTO: contours.get(i) retorna um Mat que NÃO é deletado pelo
    // .delete() do MatVector. Precisa ser deletado após uso.
    const cnt = contours.get(i);
    try {
      const area = cv.contourArea(cnt);
      if (area < minArea || area <= bestArea) continue;
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      try {
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          // B1 (review): deleta o best ANTERIOR antes de transferir posse.
          // A guarda `if (best !== approx)` anterior era sempre falsa (best
          // já havia sido sobrescrito) — todo best anterior vazava.
          if (best) { try { best.delete(); } catch (e) {} }
          best = approx;
          bestArea = area;
        } else {
          approx.delete();
        }
      } catch (e) {
        try { approx.delete(); } catch (e2) {}
      }
    } finally {
      try { cnt.delete(); } catch (e) {} // deleta o Mat individual
    }
  }

  const ms = performance.now() - t0;
  const wasmHeap = cv.HEAPU8 ? cv.HEAPU8.buffer.byteLength : 0;

  if (!best) {
    self.postMessage({
      type: 'result',
      found: false, cx: 0.5, cy: 0.5, coverage: 0, bboxAspect: 0, tilt: 0,
      touchesEdge: false, confidence: 0, mode: 'otsu', ms, wasmHeap, width: w, height: h,
    });
    return;
  }

  // B1 (review): try/finally garante best.delete() mesmo se a extração de
  // vértices, minAreaRect ou postMessage lançar — antes o best vazava.
  try {
    // Extrai vértices do quadrilátero (4 pontos).
    const pts = [];
    for (let i = 0; i < 4; i++) {
      pts.push({ x: best.data32S[i * 2], y: best.data32S[i * 2 + 1] });
    }

    // Bounding box do quadrilátero para cx/cy/coverage/bboxAspect.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const cx = (minX + maxX) / 2 / w;
    const cy = (minY + maxY) / 2 / h;
    const bw = maxX - minX, bh = maxY - minY;
    const coverage = bestArea / (w * h);
    const bboxAspect = bh > 0 ? bw / bh : 0;

    // touchesEdge: algum vértice a ≤2 px de borda do frame.
    const touchesEdge = pts.some(p =>
      p.x <= 2 || p.y <= 2 || p.x >= w - 3 || p.y >= h - 3
    );

    // tilt: ângulo do minAreaRect do quadrilátero. Calculado mas NÃO consumido
    // no feedback em F1 — incluído no result para o harness reportar.
    let tilt = 0;
    try {
      const rotRect = cv.minAreaRect(best);
      tilt = rotRect.angle;
    } catch (e) { /* tilt = 0 se falhar */ }

    // confidence: placeholder grosseiro (score formal vem em F2).
    const confidence = Math.min(1, coverage * 2);

    self.postMessage({
      type: 'result',
      found: true, cx, cy, coverage, bboxAspect, tilt, touchesEdge,
      confidence, mode: 'otsu', ms, wasmHeap, width: w, height: h,
    });
  } finally {
    try { best.delete(); } catch (e) {}
  }
}

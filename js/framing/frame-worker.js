/* =========================================================================
   frame-worker.js — Worker clássico com OpenCV.js (F2: cascata + score)

   Worker clássico (não módulo) — usa importScripts para carregar o OpenCV.js
   e o helper puro de score. Paths resolvem contra self.location (a URL do
   worker em js/framing/): vendor dois níveis acima, score.js ao lado.

   F2 sobre a base F1:
   - Score geométrico de candidatos (ScoreLib — js/framing/score.js):
     0.40*areaNorm + 0.25*aspectScore + 0.20*convexityScore + 0.15*centerBias.
   - Cascata de binarização Otsu → adaptive → Canny com CLAHE condicional
     (std < 18), cache de modo, probing periódico (10 frames), orçamento
     cooperativo (CASCADE_PROBE_BUDGET_MS) e cooldown de 2 frames.
   - Contrato de configuração: { type:'config', cascadeEnabled } enviado
     antes do primeiro frame. Default false (Otsu/CLAHE + score, sem
     adaptive/Canny, sem cache/probing) — preserva comparação F1 honesta.

   Init do cv: async IIFE cobrindo os 3 formatos de build (A5, rev. 4):
   factory (typeof cv === 'function'), Promise (cv instanceof Promise),
   callback (onRuntimeInitialized). Usa variável local `instance` — nunca
   reatribui cv global.

   B2 (rev. 4): frames antes de ready emitem {type:'notready'} (tipo
   distinto de error) — o guia só limpa inFlight, sem trocar fonte nem
   agendar retry.

   Vazamento: contours é MatVector — .delete() não deleta os Mats
   individuais de contours.get(i). Cada Mat retornado por .get(i), cada
   approx e cada hull precisam ser deletados no finally da iteração. Nenhum
   candidato mantém referência a Mat depois de extração — só objetos JS.
   ========================================================================= */

importScripts('../../vendor/opencv-4.13.0.js');
importScripts('./score.js'); // expõe self.ScoreLib (helper puro, sem OpenCV)

// -------------------------------------------------------------------------
// Constantes da F2
// -------------------------------------------------------------------------

// ⚠️ ALERTA (plano F2, seção 4): esta constante tem DOIS papéis deliberados —
// (a) short-circuit da cascata (o modo atual já produziu candidato
// suficiente → não roda os modos seguintes) e (b) decisão found:true do
// resultado final. Alterar o valor muda SIMULTANEAMENTE custo/latência
// (quantas vezes a cascata roda até o fim) e acurácia (o que conta como
// detecção). Não ajustar como "otimização" silenciosa — só com medição no
// dataset registrada no BENCHMARK.md.
const SCORE_FOUND_THRESHOLD = 0.45;

// Suborçamento do worker dentro de A2 (150 ms de frame completo):
// workerMs <= 100 ms, deixando ~50 ms para captura/transfer/dispatch/
// feedback. Guard COOPERATIVO: não interrompe uma chamada OpenCV em
// execução — é consultado antes de cada modo e no loop de contornos.
const CASCADE_PROBE_BUDGET_MS = 100;

// Reavaliação periódica do cache de modo (frames entre probings).
const PROBE_INTERVAL_FRAMES = 10;
// Frames de cooldown (só Otsu) após um probing estourar o orçamento.
const PROBE_COOLDOWN_FRAMES = 2;

// CLAHE condicional: aplicado quando o desvio padrão do cinza < este valor
// (imagem de baixo contraste). clip 2.0, grid 8×8 (plano F2, seção 5.2).
const CLAHE_STD_THRESHOLD = 18;

// Confiabilidade do Otsu (plano F2, seção 5.2):
// - limiar retornado extremo (<40 ou >215) → suspeito;
// - separabilidade entre classes eta = sigmaBetween²/sigmaTotal² baixa →
//   divisão pouco informativa. Valor inicial documentado; validar no
//   dataset — não ajustar para salvar um único caso.
const OTSU_THRESHOLD_MIN = 40;
const OTSU_THRESHOLD_MAX = 215;
const OTSU_MIN_ETA = 0.5;

// Área mínima de um candidato (fração do frame) — vale para a seleção
// principal E para o candidato parcial (não fabricar detecção com contorno
// menor).
const MIN_AREA_FRACTION = 0.08;

// -------------------------------------------------------------------------
// Estado do worker
// -------------------------------------------------------------------------

let cvInstance = null;
let src = null, gray = null, enhanced = null, blur = null, bin = null;
let edges = null, hierarchy = null, meanMat = null, stdMat = null;
let kernel5x5 = null, kernel3x3 = null, contours = null, clahe = null;
let currentW = 0, currentH = 0;
let ready = false;

// Configuração (contrato { type:'config', cascadeEnabled }). Default false:
// Otsu/CLAHE + score, sem adaptive/Canny — comparável à F1.
let cascadeEnabled = false;

// Cache do modo (só quando cascadeEnabled): otimização, não decisão
// permanente. Invalida em resize, falha do modo cacheado e config.
let cachedMode = null;
let framesSinceProbe = 0;
let probeCooldownFrames = 0;

/**
 * Pré-aloca os Mats do pipeline no tamanho dado. Deleta os anteriores se
 * o tamanho mudou (resize implícito — cada frame carrega width/height).
 * O resize invalida o cache de modo (a medição anterior não vale mais).
 */
function allocMats(cv, w, h) {
  if (w === currentW && h === currentH && src) return;
  freeMats(cv);
  src = cv.Mat.zeros(h, w, cv.CV_8UC4);
  gray = cv.Mat.zeros(h, w, cv.CV_8UC1);
  enhanced = cv.Mat.zeros(h, w, cv.CV_8UC1); // saída do CLAHE
  blur = cv.Mat.zeros(h, w, cv.CV_8UC1);
  bin = cv.Mat.zeros(h, w, cv.CV_8UC1);
  edges = cv.Mat.zeros(h, w, cv.CV_8UC1); // saída do Canny
  hierarchy = new cv.Mat();
  meanMat = new cv.Mat(); // saídas do meanStdDev (realocadas pelo OpenCV)
  stdMat = new cv.Mat();
  kernel5x5 = cv.Mat.ones(5, 5, cv.CV_8U);
  kernel3x3 = cv.Mat.ones(3, 3, cv.CV_8U);
  contours = new cv.MatVector();
  // CLAHE criado uma vez por conjunto de Mats (plano F2, seção 5.1).
  clahe = typeof cv.CLAHE === 'function'
    ? new cv.CLAHE(2.0, new cv.Size(8, 8))
    : cv.createCLAHE(2.0, new cv.Size(8, 8));
  currentW = w;
  currentH = h;
  // Resize: limpa modo cacheado e reinicia contadores de reavaliação.
  cachedMode = null;
  framesSinceProbe = 0;
  probeCooldownFrames = 0;
}

function freeMats(cv) {
  const mats = [src, gray, enhanced, blur, bin, edges, hierarchy, meanMat,
    stdMat, kernel5x5, kernel3x3, contours, clahe];
  for (const m of mats) {
    if (m) { try { m.delete(); } catch (e) {} }
  }
  src = gray = enhanced = blur = bin = edges = hierarchy = null;
  meanMat = stdMat = kernel5x5 = kernel3x3 = contours = clahe = null;
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

// Handler de mensagens — config e frames.
self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'config') {
    // Contrato F2: { type:'config', cascadeEnabled } antes do primeiro frame.
    cascadeEnabled = !!msg.cascadeEnabled;
    cachedMode = null;
    framesSinceProbe = 0;
    probeCooldownFrames = 0;
    return;
  }

  if (msg.type !== 'frame') return;

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

// -------------------------------------------------------------------------
// Estratégias de binarização (plano F2, seção 5.3)
// Cada uma escreve a máscara final em `bin` (fechamento CLOSE 5×5 incluso).
// Nenhum Mat novo por frame — tudo pré-alocado.
// -------------------------------------------------------------------------

/**
 * Otsu: threshold automático + CLOSE. Retorna o limiar e a separabilidade
 * eta = sigmaBetween²/sigmaTotal², calculada do histograma de `blur` em JS
 * (frame 160×120 → ~19k pixels, custo desprezível, zero Mats extras).
 */
function runOtsu(cv) {
  const thresh = cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel5x5);
  return { thresh, eta: otsuEta(blur.data, thresh) };
}

/** Separabilidade entre classes do limiar t sobre os pixels (Uint8Array). */
function otsuEta(pixels, t) {
  const hist = new Float64Array(256);
  const n = pixels.length;
  for (let i = 0; i < n; i++) hist[pixels[i]]++;
  let total = 0, sumAll = 0;
  for (let v = 0; v < 256; v++) { total += hist[v]; sumAll += v * hist[v]; }
  if (total === 0) return 0;
  const meanAll = sumAll / total;
  let n0 = 0, sum0 = 0, sigmaTotal = 0;
  for (let v = 0; v < 256; v++) {
    sigmaTotal += hist[v] * (v - meanAll) * (v - meanAll);
    if (v <= t) { n0 += hist[v]; sum0 += v * hist[v]; }
  }
  sigmaTotal /= total;
  if (sigmaTotal <= 0) return 0;
  const n1 = total - n0;
  if (n0 === 0 || n1 === 0) return 0;
  const w0 = n0 / total, w1 = n1 / total;
  const mu0 = sum0 / n0, mu1 = (sumAll - sum0) / n1;
  const sigmaBetween = w0 * w1 * (mu0 - mu1) * (mu0 - mu1);
  return sigmaBetween / sigmaTotal;
}

/** Adaptive Gaussian: bloco 31, C=5, + CLOSE. */
function runAdaptive(cv) {
  cv.adaptiveThreshold(blur, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY, 31, 5);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel5x5);
}

/** Canny 50/150 + dilate 3×3 (une trechos da borda ANTES do CLOSE). */
function runCanny(cv) {
  cv.Canny(blur, edges, 50, 150);
  cv.dilate(edges, bin, kernel3x3);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel5x5);
}

// -------------------------------------------------------------------------
// Extração e score de candidatos (plano F2, seção 6)
// -------------------------------------------------------------------------

/**
 * Analisa os contornos de `bin` e devolve o melhor candidato como objeto JS
 * puro (NENHUMA referência a Mat sobrevive ao retorno — evita repetir o
 * vazamento de `best` corrigido na revisão da F1).
 *
 * Preferência: melhor quadrilátero convexo por score; se não houver quad
 * válido, candidato parcial = minAreaRect do MAIOR contorno qualificado
 * (área ≥ 8% do frame — mesmo filtro, sem fabricar detecção parcial com
 * contorno menor).
 *
 * @param {object} cv
 * @param {number} w
 * @param {number} h
 * @param {number} deadline guard cooperativo — consultado no loop de contornos
 * @returns {?object} { score, parts, pts, area, tilt, isQuad }
 */
function extractBestCandidate(cv, w, h, deadline) {
  const ScoreLib = self.ScoreLib;
  const frameArea = w * h;
  const minArea = frameArea * MIN_AREA_FRACTION;

  cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let bestQuad = null;       // maior score entre quadriláteros válidos
  let largestPartial = null; // MAIOR contorno qualificado (fallback parcial)
  let largestPartialArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    // Guard cooperativo do orçamento (não interrompe chamada em curso,
    // mas evita continuar a varredura quando o deadline estourou).
    if (deadline && performance.now() >= deadline) break;

    // VAZAMENTO: contours.get(i) retorna um Mat que NÃO é deletado pelo
    // .delete() do MatVector. cnt/approx/hull deletados no finally.
    const cnt = contours.get(i);
    let approx = null, hull = null;
    try {
      const area = cv.contourArea(cnt);
      if (area < minArea) continue;

      // Centroide via momentos (enquanto o contorno existe) → centerBias.
      const m = cv.moments(cnt);
      if (!m.m00) continue;
      const mx = m.m10 / m.m00 / w;
      const my = m.m01 / m.m00 / h;

      // Convexidade: área do contorno / área do hull.
      hull = new cv.Mat();
      cv.convexHull(cnt, hull);
      const hullArea = cv.contourArea(hull);

      // Quadrilátero: approxPolyDP 0.02*peri, 4 vértices convexos.
      const peri = cv.arcLength(cnt, true);
      approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      const isQuad = approx.rows === 4 && cv.isContourConvex(approx);

      // minAreaRect do shape relevante: razão ORIENTADA para o aspectScore
      // (não penalizar folha inclinada duas vezes) + tilt.
      const rotRect = cv.minAreaRect(isQuad ? approx : cnt);
      const rw = rotRect.size.width, rh = rotRect.size.height;
      const orientedRatio = rh > 0 ? rw / rh : 0;
      const tilt = rotRect.angle;

      // Pontos → objetos JS simples ANTES de liberar os Mats.
      let pts;
      if (isQuad) {
        pts = [];
        for (let k = 0; k < 4; k++) {
          pts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
        }
      } else {
        // Candidato parcial: 4 pontos do retângulo rotacionado, só para
        // métricas — found continua dependendo do score final.
        pts = rotatedRectPoints(cv, rotRect, cnt);
      }

      const parts = {
        areaNorm: ScoreLib.areaNorm(area, frameArea),
        aspectScore: ScoreLib.aspectScore(orientedRatio),
        convexityScore: ScoreLib.convexityScore(area, hullArea),
        centerBias: ScoreLib.centerBias(mx, my),
      };
      const score = ScoreLib.computeScore(parts);
      const candidate = { score, parts, pts, area, tilt, isQuad };

      if (isQuad) {
        // Avaliar TODOS os quads pelo score (não escolher o maior por área
        // prematuramente — plano F2, seção 6.1).
        if (!bestQuad || score > bestQuad.score) bestQuad = candidate;
      } else if (area > largestPartialArea) {
        largestPartialArea = area;
        largestPartial = candidate;
      }
    } finally {
      try { cnt.delete(); } catch (e) {}
      if (approx) { try { approx.delete(); } catch (e) {} }
      if (hull) { try { hull.delete(); } catch (e) {} }
    }
  }

  return bestQuad || largestPartial;
}

/** 4 pontos do RotatedRect como objetos JS; fallback = boundingRect do cnt. */
function rotatedRectPoints(cv, rotRect, cnt) {
  try {
    const raw = cv.RotatedRect.points(rotRect);
    return raw.map((p) => ({ x: p.x, y: p.y }));
  } catch (e) {
    const r = cv.boundingRect(cnt);
    return [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
      { x: r.x, y: r.y + r.height },
    ];
  }
}

// -------------------------------------------------------------------------
// Frame: pré-processamento + cascata + emissão
// -------------------------------------------------------------------------

/**
 * Processa um frame: CLAHE condicional + cascata (ou Otsu-only) + score.
 * @param {{width:number, height:number, buffer:ArrayBuffer}} msg
 */
function processFrame(msg) {
  const cv = cvInstance;
  const w = msg.width, h = msg.height;
  const t0 = performance.now();
  const deadline = t0 + CASCADE_PROBE_BUDGET_MS;

  // Resize implícito: se mudou, realoca Mats (e invalida o cache de modo).
  allocMats(cv, w, h);

  // Copia o buffer transferido para o Mat src (RGBA). O buffer foi doado ao
  // worker via transfer — src.data.set copia para o heap WASM (uma cópia).
  src.data.set(new Uint8Array(msg.buffer));

  // Pré-processamento comum (plano F2, seção 5.2):
  // 1. RGBA → GRAY
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // 2. Desvio padrão do cinza ORIGINAL (antes de qualquer realce).
  cv.meanStdDev(gray, meanMat, stdMat);
  const grayStd = stdMat.data64F ? stdMat.data64F[0] : 0;
  // 3. CLAHE condicional (baixo contraste). CLAHE é pré-processamento, não
  //    uma quarta fonte — o mode do resultado continua sendo o da estratégia.
  const source = grayStd < CLAHE_STD_THRESHOLD ? (clahe.apply(gray, enhanced), enhanced) : gray;
  // 4. Gaussian blur 3×3 sobre o cinza usado pela cascata.
  cv.GaussianBlur(source, blur, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);

  // ---------------------------------------------------------------------
  // Ordem dos modos (tabela normativa, plano F2 seção 5.4):
  // - cascata desligada → só Otsu (sem probing/cache);
  // - cooldown pós-estouro → só Otsu, decrementa;
  // - probing (1º frame, resize, a cada 10 frames, pós-falha do cache) →
  //   ordem fixa otsu → adaptive → canny;
  // - frame normal → cachedMode primeiro, depois os demais sem duplicata.
  // ---------------------------------------------------------------------
  const ALL_MODES = ['otsu', 'adaptive', 'canny'];
  let order;
  if (!cascadeEnabled) {
    order = ['otsu'];
  } else if (probeCooldownFrames > 0) {
    probeCooldownFrames--;
    order = ['otsu'];
  } else if (cachedMode === null || framesSinceProbe >= PROBE_INTERVAL_FRAMES) {
    order = ALL_MODES;
    framesSinceProbe = 0;
  } else {
    order = [cachedMode].concat(ALL_MODES.filter((m) => m !== cachedMode));
  }
  framesSinceProbe++;

  let best = null;       // melhor candidato de TODAS as tentativas do frame
  let bestMode = order[0];
  let winner = null;     // candidato que passou o limiar (short-circuit)
  let winnerMode = null;
  let deadlineHit = false;

  for (let i = 0; i < order.length; i++) {
    // Guard cooperativo: antes de INICIAR cada modo (após o primeiro).
    if (i > 0 && performance.now() >= deadline) {
      deadlineHit = true;
      break;
    }
    const mode = order[i];
    let otsuInfo = null;
    if (mode === 'otsu') {
      otsuInfo = runOtsu(cv);
    } else if (mode === 'adaptive') {
      runAdaptive(cv);
    } else {
      runCanny(cv);
    }

    const cand = extractBestCandidate(cv, w, h, cascadeEnabled ? deadline : 0);
    if (cand && (!best || cand.score > best.score)) {
      best = cand;
      bestMode = mode;
    }

    // ⚠️ ALERTA: SCORE_FOUND_THRESHOLD aqui é o SHORT-CIRCUIT da cascata —
    // o mesmo valor decide found:true abaixo. Mudar o limiar altera custo
    // (quantos modos rodam) E acurácia ao mesmo tempo (plano F2, seção 4).
    if (cand && cand.score >= SCORE_FOUND_THRESHOLD) {
      // Otsu só encerra a cascata se for CONFIÁVEL (limiar não-extremo e
      // separabilidade suficiente). Com cascata desligada não há alternativa
      // — aceita direto.
      const otsuReliable = !otsuInfo
        || (otsuInfo.thresh >= OTSU_THRESHOLD_MIN
          && otsuInfo.thresh <= OTSU_THRESHOLD_MAX
          && otsuInfo.eta >= OTSU_MIN_ETA);
      if (!cascadeEnabled || mode !== 'otsu' || otsuReliable) {
        winner = cand;
        winnerMode = mode;
        break;
      }
    }
  }

  // Atualização do cache (só com cascata habilitada):
  // - sucesso → cachedMode = modo vencedor;
  // - estouro de orçamento → invalida cache + cooldown de 2 frames (só Otsu);
  // - todas as tentativas falharam → invalida cache (próximo frame = probing).
  if (cascadeEnabled) {
    if (winner) {
      cachedMode = winnerMode;
    } else if (deadlineHit) {
      cachedMode = null;
      probeCooldownFrames = PROBE_COOLDOWN_FRAMES;
    } else {
      cachedMode = null;
    }
  }

  const ms = performance.now() - t0;
  const wasmHeap = cv.HEAPU8 ? cv.HEAPU8.buffer.byteLength : 0;

  const chosen = winner || best;
  const chosenMode = winner ? winnerMode : bestMode;

  if (!chosen) {
    // Nenhum contorno utilizável: forma sem candidato (score 0, centro 0.5).
    self.postMessage({
      type: 'result',
      found: false, cx: 0.5, cy: 0.5, coverage: 0, bboxAspect: 0, tilt: 0,
      touchesEdge: false, confidence: 0, score: 0, mode: chosenMode,
      ms, wasmHeap, width: w, height: h,
    });
    return;
  }

  // Métricas derivadas do candidato escolhido (objeto JS puro — sem Mats).
  const pts = chosen.pts;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // cx/cy: centro do bbox dos pontos selecionados (contrato F1). O centroide
  // dos momentos alimenta só o centerBias do score — são coisas diferentes.
  const cx = (minX + maxX) / 2 / w;
  const cy = (minY + maxY) / 2 / h;
  const bw = maxX - minX, bh = maxY - minY;
  const coverage = chosen.area / (w * h);
  // bboxAspect: largura/altura do bbox ALINHADO (contrato F1). A razão
  // orientada do minAreaRect entrou só no aspectScore.
  const bboxAspect = bh > 0 ? bw / bh : 0;

  // touchesEdge: algum vértice a ≤2 px de borda (convenção F1).
  const touchesEdge = pts.some((p) =>
    p.x <= 2 || p.y <= 2 || p.x >= w - 3 || p.y >= h - 3
  );

  // ⚠️ ALERTA: found usa a MESMA constante do short-circuit acima
  // (SCORE_FOUND_THRESHOLD) — coincidência deliberada do plano F2, seção 4.
  // Não criar um segundo limiar sem medição que justifique a separação.
  const found = chosen.score >= SCORE_FOUND_THRESHOLD;

  self.postMessage({
    type: 'result',
    found, cx, cy, coverage, bboxAspect, tilt: chosen.tilt, touchesEdge,
    confidence: chosen.score, // score geométrico substitui o placeholder F1
    score: chosen.score,      // duplicado para diagnóstico do harness
    mode: chosenMode, ms, wasmHeap, width: w, height: h,
  });
}

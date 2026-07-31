/* =========================================================================
   test-harness.js — validação offline do detector (F0)

   Playback de stills (via <img> + drawImage) e clipes (via <video src> +
   drawImage) no lugar de getUserMedia. Chama detect() injetado (em F0 é o
   FallbackDetector; em F1 troca para o worker; em F3 encadeia
   detector->estabilizador para A5) e compara found/bbox/touchesEdge com a
   ground truth em dataset/annotations/. Reporta:
     - precisão de found (A1)
     - erro de centro (px) entre cx/cy previsto e bbox do ground truth
     - taxa de touchesEdge correta
     - ms/frame e fps (estatísticas do detector)

   A página do harness (harness.html) NÃO registra o Service Worker — o
   fetch handler do sw.js intercepta tudo e faria cache.put das imagens do
   dataset. ?nocache não bypassa SW. Por isso harness.html não carrega app.js
   e chama navigator.serviceWorker.unregister() defensivamente no topo.
   ========================================================================= */

/**
 * Carrega o índice do dataset (lista de stills/clipes + anotações).
 * Espera dataset/index.json gerado pelo operador (ver dataset/README.md).
 * @returns {Promise<{stills:Array, clips:Array}>}
 */
async function loadDatasetIndex() {
  const res = await fetch('dataset/index.json');
  if (!res.ok) throw new Error(`dataset/index.json não encontrado (${res.status}). Veja dataset/README.md.`);
  return res.json();
}

/**
 * Cria um canvas offscreen e devolve {canvas, ctx} com willReadFrequently.
 */
function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas, ctx };
}

/**
 * Carrega uma imagem estática e devolve ImageData na resolução alvo.
 * @param {string} src
 * @param {number} width  largura alvo (ex. 160)
 * @param {number} height altura alvo (derivada do aspecto do vídeo/imagem)
 */
async function stillToImageData(src, width, height) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = src;
  });
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Compara o resultado do detector com a anotação ground truth de um still.
 * @param {object} result   saída do detect()
 * @param {object} truth    { found, bbox:[minX,minY,maxX,maxY] (0..1), touchesEdge }
 * @param {number} width    largura do frame analisado (px) — para erro de centro
 * @param {number} height   altura do frame analisado (px)
 */
function compareStill(result, truth, width, height) {
  const foundCorrect = !!result.found === !!truth.found;
  let centerErrorPx = null;
  if (result.found && truth.found && truth.bbox) {
    const [minX, minY, maxX, maxY] = truth.bbox;
    const truthCx = (minX + maxX) / 2;
    const truthCy = (minY + maxY) / 2;
    const dx = (result.cx - truthCx) * width;
    const dy = (result.cy - truthCy) * height;
    centerErrorPx = Math.hypot(dx, dy);
  }
  const touchesEdgeCorrect = truth.touchesEdge === undefined
    ? null
    : !!result.touchesEdge === !!truth.touchesEdge;
  return { foundCorrect, centerErrorPx, touchesEdgeCorrect };
}

/**
 * Mediana de um array de números.
 */
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Roda o detector sobre todos os stills do dataset e reporta A1 + erro de
 * centro. Aceita `detect` injetado (F0: FallbackDetector; F1: worker).
 *
 * @param {function} detect  (imageData, w, h) => result
 * @param {object} opts      { width, onProgress, resetStats, getStats }
 *   `resetStats`/`getStats` são obrigatórios e devem corresponder à fonte
 *   `detect` injetada (F0: FallbackDetector; F1: worker). Não importar
 *   fallback-detector.js diretamente aqui — senão, ao injetar o worker em F1,
 *   o relatório mediria as stats do heurístico (ou zeros) enquanto mede o
 *   worker, invalidando o gate de Otsu.
 * @returns {Promise<object>} relatório { n, evaluated, loadFailures,
 *   foundAccuracy, centerErrorMedPx, centerErrorAvgPx, touchesEdgeAccuracy,
 *   frameMs, stats }
 */
export async function runStills(detect, opts = {}) {
  const width = opts.width || 160;
  const onProgress = opts.onProgress || (() => {});
  const { resetStats, getStats } = opts;
  if (typeof resetStats !== 'function' || typeof getStats !== 'function') {
    throw new Error('runStills: opts.resetStats e opts.getStats são obrigatórios (devem corresponder à fonte detect injetada).');
  }
  const index = await loadDatasetIndex();
  const stills = index.stills || [];

  resetStats();

  let foundOk = 0;
  let edgeOk = 0;
  let edgeTotal = 0;
  let loadFailures = 0;
  const centerErrors = [];
  // Custo total por frame (drawImage + getImageData + detect), para o
  // orçamento de A8. O `ms` do resultado mede só o loop interno do detector.
  let frameMsTotal = 0;
  let frameMsMin = Infinity;
  let frameMsMax = 0;
  let frameCount = 0;

  for (let i = 0; i < stills.length; i++) {
    const s = stills[i];
    // s.aspect é o aspecto do FRAME (altura/largura, h/w) — diferente do
    // `bboxAspect` (largura/altura) que o detector retorna. Renomeado para
    // evitar cruzar os dois.
    const frameAspectHW = s.aspect || (3 / 4); // fallback 4:3
    const height = Math.max(1, Math.round(width * frameAspectHW));
    let imageData;
    const frameT0 = performance.now();
    try {
      imageData = await stillToImageData(`dataset/stills/${s.file}`, width, height);
    } catch (e) {
      console.warn(`stills: falhou carregar ${s.file}:`, e);
      loadFailures++;
      continue;
    }
    const result = detect(imageData, width, height);
    const frameMs = performance.now() - frameT0;
    frameMsTotal += frameMs;
    if (frameMs < frameMsMin) frameMsMin = frameMs;
    if (frameMs > frameMsMax) frameMsMax = frameMs;
    frameCount++;
    const truth = s.truth || {};
    const cmp = compareStill(result, truth, width, height);
    if (cmp.foundCorrect) foundOk++;
    if (cmp.touchesEdgeCorrect !== null) {
      edgeTotal++;
      if (cmp.touchesEdgeCorrect) edgeOk++;
    }
    if (cmp.centerErrorPx !== null) centerErrors.push(cmp.centerErrorPx);
    onProgress(i + 1, stills.length, s.file, result, cmp);
  }

  const n = stills.length;
  const evaluated = n - loadFailures;
  return {
    n,
    evaluated,
    loadFailures,
    foundAccuracy: evaluated ? foundOk / evaluated : 0,
    centerErrorMedPx: median(centerErrors),
    centerErrorAvgPx: centerErrors.length
      ? centerErrors.reduce((a, b) => a + b, 0) / centerErrors.length
      : null,
    touchesEdgeAccuracy: edgeTotal ? edgeOk / edgeTotal : null,
    frameMs: {
      avg: frameCount ? frameMsTotal / frameCount : 0,
      min: frameCount ? frameMsMin : 0,
      max: frameCount ? frameMsMax : 0,
    },
    stats: getStats(),
  };
}

/**
 * Roda o detector (encadeado com estabilizador em F3) sobre um clipe de vídeo
 * e reporta A5 (falsos PRONTO). Em F0 só roda o detector puro para baseline.
 *
 * @param {function} detect        (imageData, w, h) => result
 * @param {object} clip           entrada do dataset (file, fps, frames[])
 * @param {object} opts            { width, onProgress, onFrame, resetStats, getStats }
 *   `resetStats`/`getStats` são obrigatórios (mesmo motivo de runStills).
 */
export async function runClip(detect, clip, opts = {}) {
  const width = opts.width || 160;
  const onProgress = opts.onProgress || (() => {});
  const { resetStats, getStats } = opts;
  if (typeof resetStats !== 'function' || typeof getStats !== 'function') {
    throw new Error('runClip: opts.resetStats e opts.getStats são obrigatórios (devem corresponder à fonte detect injetada).');
  }
  const video = document.createElement('video');
  video.src = `dataset/clips/${clip.file}`;
  video.muted = true;
  video.playsInline = true;
  // Sem video.play(): playback determinístico frame-a-frame por seek. Dar
  // play faria o currentTime avançar entre seeks e conflitar com a leitura.
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error(`falhou carregar clipe ${clip.file}`));
  });

  const frames = clip.frames || [];
  let falseReady = 0;
  let readyTotal = 0;
  resetStats();

  let frameMsTotal = 0;
  let frameMsMin = Infinity;
  let frameMsMax = 0;
  let frameCount = 0;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const t = f.t || (i / (clip.fps || 15));
    // seek com timeout: video.currentTime = t não dispara 'seeked' se já
    // estiver no valor (Promise pendurada). Guarda same-time + timeout.
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', onSeek);
        clearTimeout(timer);
        resolve();
      };
      const onSeek = () => finish();
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', onSeek);
        reject(new Error(`seek timeout no clipe ${clip.file} t=${t}`));
      }, 2000);
      video.addEventListener('seeked', onSeek);
      if (Math.abs(video.currentTime - t) < 1e-3) {
        // já no alvo: 'seeked' não vai disparar
        finish();
      } else {
        video.currentTime = t;
      }
    });
    const frameT0 = performance.now();
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    const { canvas, ctx } = makeCanvas(width, height);
    ctx.drawImage(video, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const result = detect(imageData, width, height);
    const frameMs = performance.now() - frameT0;
    frameMsTotal += frameMs;
    if (frameMs < frameMsMin) frameMsMin = frameMs;
    if (frameMs > frameMsMax) frameMsMax = frameMs;
    frameCount++;
    // Em F3, onFrame encadeia o estabilizador e devolve state; aqui só detector.
    const state = opts.onFrame ? opts.onFrame(result) : { ready: result.found };
    if (state.ready) {
      readyTotal++;
      if (!f.truth?.ready) falseReady++;
    }
    onProgress(i + 1, frames.length, state, result);
  }

  const totalFrames = frames.length;
  const clipDurationS = clip.durationS || (totalFrames / (clip.fps || 15));
  return {
    n: totalFrames,
    readyTotal,
    falseReady,
    // Métrica primária do gate de F3 (precisão do sinal de pronto). Ver A5 em
    // BENCHMARK.md. Denominador é readyTotal, NÃO totalFrames.
    falseReadyRate: readyTotal ? falseReady / readyTotal : 0,
    // Diagnóstico auxiliar (não é o gate): densidade temporal + quão falador.
    falseReadyPerMin: clipDurationS > 0 ? falseReady / clipDurationS * 60 : 0,
    readyRate: totalFrames ? readyTotal / totalFrames : 0,
    frameMs: {
      avg: frameCount ? frameMsTotal / frameCount : 0,
      min: frameCount ? frameMsMin : 0,
      max: frameCount ? frameMsMax : 0,
    },
    stats: getStats(),
  };
}

/**
 * Formata um relatório de stills como texto para colar no BENCHMARK.md.
 */
export function formatStillsReport(r) {
  return [
    `### A1 — Detecção (stills)`,
    `- Frames no índice: ${r.n}`,
    `- Frames avaliados: ${r.evaluated}` + (r.loadFailures ? ` (ignorados ${r.loadFailures} que falharam ao carregar)` : ''),
    `- Acurácia de found: ${(r.foundAccuracy * 100).toFixed(1)}% (meta A1: ≥85%)`,
    `- Erro de centro mediano: ${r.centerErrorMedPx !== null ? r.centerErrorMedPx.toFixed(1) + ' px' : 'n/a'}`,
    `- Erro de centro médio: ${r.centerErrorAvgPx !== null ? r.centerErrorAvgPx.toFixed(1) + ' px' : 'n/a'}`,
    `- Acurácia touchesEdge: ${r.touchesEdgeAccuracy !== null ? (r.touchesEdgeAccuracy * 100).toFixed(1) + '%' : 'n/a'}`,
    `- ms/frame (detector): med ${r.stats.medianMs.toFixed(1)} / p95 ${r.stats.p95Ms.toFixed(1)} / avg ${r.stats.avgMs.toFixed(1)} (min ${r.stats.minMs.toFixed(1)} / max ${r.stats.maxMs.toFixed(1)})`,
    `- ms/frame (total: drawImage+getImageData+detect): med ${r.frameMs.avg.toFixed(1)} (min ${r.frameMs.min.toFixed(1)} / max ${r.frameMs.max.toFixed(1)})`,
    `- fps efetivo: ${r.stats.fps.toFixed(1)}`,
  ].join('\n');
}

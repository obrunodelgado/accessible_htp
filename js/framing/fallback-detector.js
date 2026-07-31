/* =========================================================================
   FallbackDetector — detector heurístico de folha (extraído de app.js em F0)

   Refactor puro: a lógica de limiar por brilho médio é idêntica à antiga
   `detectSheetBounds`. A única mudança é a interface de saída, alinhada com
   o contrato do worker ({ found, cx, cy, coverage, bboxAspect, tilt,
   touchesEdge, confidence, mode, ms, wasmHeap }) para que FramingGuide
   possa trocar as fontes (heurístico vs OpenCV) sem saber qual está rodando.

   Esta é a fonte "quente" do app antes do OpenCV carregar e o fallback
   permanente se o WASM/Worker falhar (A7).
   ========================================================================= */

// Estatísticas acumuladas para instrumentação (F0 passo 6).
// ms por frame + fps efetivo + amostras de ms (cap em SAMPLES_CAP) para
// mediana/p95. Resetáveis via resetStats() para medir janelas.
const SAMPLES_CAP = 1000; // últimos N frames; ring buffer implícito via shift
const stats = {
  frames: 0,
  foundFrames: 0,
  totalMs: 0,
  minMs: Infinity,
  maxMs: 0,
  firstFrameAt: 0,
  lastFrameAt: 0,
  msSamples: [], // para mediana/p95 (cap em SAMPLES_CAP)
};

/**
 * Detecta a bounding box da região "clara" do quadro (a folha costuma ser
 * mais clara que a mesa/fundo) usando um limiar simples baseado no brilho
 * médio. Retorna null/objeto-vazio se não achar contraste suficiente.
 *
 * @param {ImageData} imageData
 * @param {number} width
 * @param {number} height
 * @returns {{found:boolean,cx:number,cy:number,coverage:number,bboxAspect:number,
 *   tilt:number,touchesEdge:boolean,confidence:number,mode:string,ms:number,
 *   wasmHeap:number}}
 *
 * Notas sobre os campos:
 * - `bboxAspect` é largura/altura da bounding box (w/h). NÃO confundir com o
 *   aspecto do frame (h/w) usado pelo harness. Renomeado de `aspect` para
 *   evitar a colisão de significados na mesma pasta.
 * - `confidence` NÃO é comparável entre modos: aqui é só `min(1, coverage*2)`
 *   (placeholder grosseiro, satura em coverage≥0.5). O OpenCV (F1+) terá
 *   confiança geométrica calibrada. Thresholds de confiança devem ser
 *   calibrados por modo, nunca cruzados.
 */
export function detect(imageData, width, height) {
  const t0 = performance.now();
  const { data } = imageData;
  let sum = 0;
  const n = width * height;
  for (let i = 0; i < data.length; i += 4) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  const mean = sum / n;
  const threshold = mean + 20; // um pouco acima da média para pegar só o mais claro

  let minX = width, minY = height, maxX = 0, maxY = 0, brightCount = 0;
  let idx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (b > threshold) {
        brightCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      idx += 4;
    }
  }

  const ms = performance.now() - t0;
  const found = brightCount >= n * 0.02;
  recordStats(ms, found);

  if (!found) {
    // quase nada de claro: sem folha detectável
    return {
      found: false, cx: 0.5, cy: 0.5, coverage: 0, bboxAspect: 0, tilt: 0,
      touchesEdge: false, confidence: 0, mode: 'heuristic', ms, wasmHeap: 0,
    };
  }

  const coverage = brightCount / n;
  const cx = (minX + maxX) / 2 / width;
  const cy = (minY + maxY) / 2 / height;
  const bw = maxX - minX;
  const bh = maxY - minY;
  const bboxAspect = bh > 0 ? bw / bh : 0;
  // touchesEdge: bounding box encosta em <=2 px de qualquer borda do frame.
  const touchesEdge = minX <= 2 || minY <= 2 || maxX >= width - 3 || maxY >= height - 3;
  // confidence derivado de coverage (heurístico não tem confiança geométrica).
  // Ver aviso no JSDoc: NÃO comparável entre modos.
  const confidence = Math.min(1, coverage * 2);

  return {
    found: true, cx, cy, coverage, bboxAspect, tilt: 0, touchesEdge,
    confidence, mode: 'heuristic', ms, wasmHeap: 0,
  };
}

function recordStats(ms, found) {
  stats.frames++;
  if (found) stats.foundFrames++;
  stats.totalMs += ms;
  if (ms < stats.minMs) stats.minMs = ms;
  if (ms > stats.maxMs) stats.maxMs = ms;
  // Ring buffer: mantém só os últimos SAMPLES_CAP ms para mediana/p95.
  // Shift é O(n) no cap, mas o cap é pequeno e a janela roda raramente.
  stats.msSamples.push(ms);
  if (stats.msSamples.length > SAMPLES_CAP) stats.msSamples.shift();
  const now = performance.now();
  if (stats.firstFrameAt === 0) stats.firstFrameAt = now;
  stats.lastFrameAt = now;
}

/** Reseta o acumulador de estatísticas (para medir janelas isoladas). */
export function resetStats() {
  stats.frames = 0;
  stats.foundFrames = 0;
  stats.totalMs = 0;
  stats.minMs = Infinity;
  stats.maxMs = 0;
  stats.firstFrameAt = 0;
  stats.lastFrameAt = 0;
  stats.msSamples = [];
}

// Percentil de um array ordenado (q em 0..1). Não muta o input.
function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Snapshot das estatísticas: ms mediano/p95/médio/min/máx por frame, fps
 * efetivo (derivado do intervalo entre primeiro e último frame, com
 * correção de viés N−1 intervalos para N frames) e taxa de found.
 *
 * mediana/p95 vêm das últimas SAMPLES_CAP amostras (ring buffer), não de
 * toda a sessão — úteis para latência, onde a cauda importa mais que a
 * média. Usado pelo harness e pelo BENCHMARK.md de F0.
 */
export function getStats() {
  const frames = stats.frames;
  // elapsed mede o span entre 1º e último frame = (N−1) intervalos.
  // fps = frames / elapsed superestima (conta N frames em N−1 intervalos);
  // por isso (frames−1)/elapsed. Com 1 frame, elapsed===0 → fps 0.
  const elapsed = stats.firstFrameAt && stats.lastFrameAt && frames > 1
    ? (stats.lastFrameAt - stats.firstFrameAt) / 1000
    : 0;
  const avgMs = frames ? stats.totalMs / frames : 0;
  const fps = elapsed > 0 ? (frames - 1) / elapsed : 0;
  const sorted = [...stats.msSamples].sort((a, b) => a - b);
  return {
    frames,
    foundFrames: stats.foundFrames,
    foundRate: frames ? stats.foundFrames / frames : 0,
    avgMs,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: frames ? stats.minMs : 0,
    maxMs: frames ? stats.maxMs : 0,
    fps,
    elapsedS: elapsed,
  };
}

/**
 * Mede o heap JS (A4 baseline). performance.memory é não-padrão e só existe
 * em Chrome; retorna null nos demais navegadores. O heap WASM é 0 aqui
 * (heurístico não usa OpenCV) — só relevante no worker a partir de F1.
 */
export function jsHeapBytes() {
  const mem = performance && performance.memory;
  return mem ? mem.usedJSHeapSize : null;
}

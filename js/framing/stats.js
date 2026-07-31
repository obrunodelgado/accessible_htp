/* =========================================================================
   stats.js — fábrica de acumulador de estatísticas por frame (B1, rev. 4)

   Extraído do fallback-detector.js para que cada fonte (FallbackDetector,
   wrapper do worker no main thread) instancie o seu próprio acumulador.
   Sem isso, o guia teria dois acumuladores divergentes medindo fontes
   diferentes sem indicar qual está valendo.

   Uso:
     const stats = createStats();
     stats.record(ms, found);   // a cada frame
     const snapshot = stats.get(); // síncrono
     stats.reset();              // para medir janelas isoladas

   A factory fecha sobre o estado interno — cada instância é independente.
   ========================================================================= */

const SAMPLES_CAP = 1000; // últimos N frames; ring buffer implícito via shift

/**
 * Cria um acumulador de estatísticas isolado.
 * @returns {{record: (function(number, boolean): void), get: (function(): object), reset: (function(): void)}}
 */
export function createStats() {
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

  function record(ms, found) {
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

  /** Reseta o acumulador (para medir janelas isoladas). */
  function reset() {
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
   * média.
   */
  function get() {
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

  return { record, get, reset };
}

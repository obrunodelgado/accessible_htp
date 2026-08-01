/* =========================================================================
   score.js — helper PURO do score geométrico de candidatos (F2, seção 6.2)

   Script CLÁSSICO (sem export ESM): roda em dois contextos —
   - frame-worker.js (worker clássico) via importScripts('./score.js'),
     consumindo self.ScoreLib;
   - harness.html via <script src>, consumindo window.ScoreLib /
     globalThis.ScoreLib.

   Sem dependência de DOM, OpenCV ou estado do worker. Todas as funções são
   puras e determinísticas — testáveis sem dataset (ScoreLib.runSelfTests).

   Fórmula (pesos fixos do plano F2):
     score = 0.40 * areaNorm
           + 0.25 * aspectScore
           + 0.20 * convexityScore
           + 0.15 * centerBias

   Nota: areaNorm satura em 0.85, então o score máximo teórico é
   0.40*0.85 + 0.25 + 0.20 + 0.15 = 0.94 (não 1.0).

   A decisão found (score >= SCORE_FOUND_THRESHOLD) NÃO vive aqui — a
   constante é do worker (frame-worker.js). Este helper só calcula o número.
   ========================================================================= */

(function (root) {
  'use strict';

  // Pesos fixos do plano F2 (seção 6.2). Não ajustar sem medição no dataset.
  var W_AREA = 0.40;
  var W_ASPECT = 0.25;
  var W_CONVEXITY = 0.20;
  var W_CENTER = 0.15;

  // Saturação de areaNorm (folha ocupando >85% do frame não pontua mais).
  var AREA_SATURATION = 0.85;

  // Proporção ISO A4 nas duas orientações (√2 e 1/√2) e tolerância relativa.
  var A4_RATIO = 1.414;
  var A4_RATIO_INV = 0.707;
  var ASPECT_TOLERANCE = 0.25; // ±25%: pontuação cai linearmente até 0 fora

  /** Limita x ao intervalo [0, 1]. */
  function clamp01(x) {
    if (!isFinite(x)) return 0;
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }

  /**
   * areaNorm = min(contourArea / frameArea, 0.85).
   * @param {number} contourArea área do contorno (px²)
   * @param {number} frameArea   área do frame (px²)
   */
  function areaNorm(contourArea, frameArea) {
    if (!(frameArea > 0) || !(contourArea > 0)) return 0;
    var ratio = contourArea / frameArea;
    return ratio > AREA_SATURATION ? AREA_SATURATION : ratio;
  }

  /**
   * aspectScore: proximidade da proporção ISO A4 em qualquer orientação.
   * Compara a razão ORIENTADA do minAreaRect (largura/altura do retângulo
   * rotacionado — não o bbox alinhado, para não penalizar folha inclinada
   * duas vezes) com 1.414 e 0.707; a melhor comparação pontua. Dentro da
   * tolerância de ±25% a pontuação cai linearmente de 1 (razão exata) até 0
   * (fora da tolerância).
   * @param {number} orientedRatio largura/altura do retângulo orientado
   */
  function aspectScore(orientedRatio) {
    if (!(orientedRatio > 0) || !isFinite(orientedRatio)) return 0;
    var best = 0;
    var targets = [A4_RATIO, A4_RATIO_INV];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var relDev = Math.abs(orientedRatio - t) / (t * ASPECT_TOLERANCE);
      var s = 1 - relDev; // 1 na razão exata, 0 no limite da tolerância
      if (s > best) best = s;
    }
    return clamp01(best);
  }

  /**
   * convexityScore = contourArea / hullArea, limitado a 0..1.
   */
  function convexityScore(contourArea, hullArea) {
    if (!(hullArea > 0) || !(contourArea > 0)) return 0;
    return clamp01(contourArea / hullArea);
  }

  /**
   * centerBias = 1 - distância normalizada do centroide ao centro do frame,
   * limitado a 0..1. Distância normalizada pela metade da diagonal do frame
   * (canto = distância 1 → bias 0; centro exato → bias 1).
   * @param {number} cx centroide normalizado 0..1
   * @param {number} cy centroide normalizado 0..1
   */
  function centerBias(cx, cy) {
    if (!isFinite(cx) || !isFinite(cy)) return 0;
    // Distância ao centro em coordenadas normalizadas; máx = √(0.5²+0.5²).
    var dx = cx - 0.5;
    var dy = cy - 0.5;
    var dist = Math.sqrt(dx * dx + dy * dy) / Math.sqrt(0.5);
    return clamp01(1 - dist);
  }

  /**
   * Soma ponderada final. Cada componente é clampado a 0..1 defensivamente
   * (areaNorm já vem saturado em 0.85 — clamp01 não altera).
   * @param {{areaNorm:number, aspectScore:number, convexityScore:number,
   *          centerBias:number}} parts
   * @returns {number} score 0..0.94
   */
  function computeScore(parts) {
    if (!parts) return 0;
    return W_AREA * clamp01(parts.areaNorm)
      + W_ASPECT * clamp01(parts.aspectScore)
      + W_CONVEXITY * clamp01(parts.convexityScore)
      + W_CENTER * clamp01(parts.centerBias);
  }

  /**
   * Testes unitários puros (plano F2, seção 9.1) — sem dataset, OpenCV ou
   * Worker. Cada caso falha com mensagem identificável.
   * @returns {{passed:number, failed:number, failures:string[]}}
   */
  function runSelfTests() {
    var failures = [];
    var passed = 0;
    function check(name, cond) {
      if (cond) { passed++; } else { failures.push(name); }
    }
    function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

    // 1. Soma ponderada de um vetor conhecido.
    check('computeScore: vetor conhecido (0.5/0.8/1.0/0.6 → 0.69)',
      approx(computeScore({ areaNorm: 0.5, aspectScore: 0.8, convexityScore: 1.0, centerBias: 0.6 }),
        0.40 * 0.5 + 0.25 * 0.8 + 0.20 * 1.0 + 0.15 * 0.6));
    check('computeScore: tudo zero → 0', computeScore({ areaNorm: 0, aspectScore: 0, convexityScore: 0, centerBias: 0 }) === 0);
    check('computeScore: máximo teórico 0.94',
      approx(computeScore({ areaNorm: 0.85, aspectScore: 1, convexityScore: 1, centerBias: 1 }), 0.94));

    // 2. Saturação de areaNorm em 0.85.
    check('areaNorm: satura em 0.85 (área = frame)', areaNorm(100, 100) === 0.85);
    check('areaNorm: satura em 0.85 (área 90%)', areaNorm(90, 100) === 0.85);
    check('areaNorm: abaixo da saturação passa direto', approx(areaNorm(30, 100), 0.30));
    check('areaNorm: frame inválido → 0', areaNorm(10, 0) === 0);

    // 3. Proporção A4 em orientação normal e invertida.
    check('aspectScore: A4 paisagem (1.414) → 1', approx(aspectScore(1.414), 1));
    check('aspectScore: A4 retrato (0.707) → 1', approx(aspectScore(0.707), 1));

    // 4. Limites interno e externo da tolerância de ±25%.
    // Interno: desvio de 25% exato → 0 (limite). Um pouco dentro → >0.
    check('aspectScore: +25% exato → 0', approx(aspectScore(1.414 * 1.25), 0, 1e-9));
    check('aspectScore: -25% de 0.707 → 0 (não pega o outro alvo)',
      approx(aspectScore(0.707 * 0.75), 0, 1e-9));
    check('aspectScore: +24% → >0', aspectScore(1.414 * 1.24) > 0);
    // Externo: fora da tolerância → 0 (não negativo).
    check('aspectScore: quadrado (1.0) fora das duas tolerâncias → 0', aspectScore(1.0) === 0);
    check('aspectScore: razão absurda (5.0) → 0', aspectScore(5.0) === 0);
    check('aspectScore: razão inválida (0) → 0', aspectScore(0) === 0);

    // 5. convexityScore e centerBias nos limites 0 e 1.
    check('convexityScore: contorno = hull → 1', convexityScore(50, 50) === 1);
    check('convexityScore: clamp superior (contorno > hull, degenerado) → 1', convexityScore(60, 50) === 1);
    check('convexityScore: hull inválido → 0', convexityScore(50, 0) === 0);
    check('convexityScore: contorno 0 → 0', convexityScore(0, 50) === 0);
    check('centerBias: centro exato → 1', approx(centerBias(0.5, 0.5), 1));
    check('centerBias: canto (0,0) → 0', approx(centerBias(0, 0), 0, 1e-9));
    check('centerBias: canto (1,1) → 0', approx(centerBias(1, 1), 0, 1e-9));
    check('centerBias: NaN → 0', centerBias(NaN, 0.5) === 0);

    // 6. Monotonicidade: melhorar um componente não pode reduzir o score.
    var base = { areaNorm: 0.3, aspectScore: 0.4, convexityScore: 0.5, centerBias: 0.6 };
    var baseScore = computeScore(base);
    var keys = ['areaNorm', 'aspectScore', 'convexityScore', 'centerBias'];
    for (var k = 0; k < keys.length; k++) {
      var better = { areaNorm: base.areaNorm, aspectScore: base.aspectScore, convexityScore: base.convexityScore, centerBias: base.centerBias };
      better[keys[k]] += 0.2;
      check('monotonicidade: melhorar ' + keys[k] + ' não reduz o score',
        computeScore(better) >= baseScore);
    }

    // 7. Separação entre score numérico e found: ScoreLib NÃO decide found.
    // A constante SCORE_FOUND_THRESHOLD vive no worker; aqui só se verifica
    // que o score é um número contínuo comparável ao limiar documentado (0.45).
    var low = computeScore({ areaNorm: 0.1, aspectScore: 0, convexityScore: 0.5, centerBias: 0.5 });
    var high = computeScore({ areaNorm: 0.85, aspectScore: 1, convexityScore: 1, centerBias: 0.8 });
    check('separação found: candidato fraco fica abaixo de 0.45', low < 0.45);
    check('separação found: candidato forte fica acima de 0.45', high >= 0.45);
    check('ScoreLib não expõe decisão found', typeof ScoreLibExports.found === 'undefined');

    return { passed: passed, failed: failures.length, failures: failures };
  }

  var ScoreLibExports = {
    computeScore: computeScore,
    areaNorm: areaNorm,
    aspectScore: aspectScore,
    convexityScore: convexityScore,
    centerBias: centerBias,
    clamp01: clamp01,
    runSelfTests: runSelfTests,
    AREA_SATURATION: AREA_SATURATION,
    ASPECT_TOLERANCE: ASPECT_TOLERANCE,
  };

  root.ScoreLib = ScoreLibExports;
})(typeof self !== 'undefined' ? self : window);

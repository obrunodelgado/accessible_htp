/* =========================================================================
   guide.js — FramingGuide (F1, passo 5)

   Coordena as fontes de detecção (FallbackDetector + worker OpenCV),
   gerencia o loop de captura, backpressure (inFlight), throttle temporal
   e adaptativo, e encaminha métricas para audio.update().

   B1 (rev. 4): stats delegadas à fonte ativa — guide.js não acumula nada
     próprio. getStats()/resetStats() são pass-through para
     activeSource.stats.
   B2 (rev. 4): notready (tipo distinto de error) só limpa inFlight, sem
     trocar fonte nem agendar retry. onWorkerError só age em error real.
   B3 (rev. 4): loop() ordem explícita — gate temporal → inFlight →
     captura imageData → switch de fonte. Worker não ready → fallback
     síncrono sem inFlight.
   B4 (rev. 4): worker vivo entre start()/stop() — stop() não termina o
     worker, só para de enviar frames. terminate() reservado para
     destroy() (pagehide) ou erro fatal.
   ========================================================================= */

import { detect as fallbackDetect, _stats as fallbackStats } from './fallback-detector.js';
import { createStats } from './stats.js';
import { audio, TARGET_COVERAGE_MIN, TARGET_COVERAGE_MAX, CENTER_MARGIN } from './audio.js';
import { queue, PRIORITY } from '../speech.js';

// Modos válidos do worker: 'yolo' (detector principal F3), 'otsu'/'adaptive'/
// 'canny' (pipeline OpenCV F2 — fallback). 'heuristic' é o FallbackDetector.
const WORKER_MODES = new Set(['yolo', 'otsu', 'adaptive', 'canny']);

// UX fallback (F2b): timeout de ajuda. Se o usuário não atinge "ready"
// (found + centralizado + cobertura na faixa) em STUCK_TIMEOUT_MS, o guia
// sugere "aproxime a folha". Repete a cada HELP_COOLDOWN_MS se continuar
// sem ready. Reseta quando ready é atingido.
//
// Motivação: o detector tem especificidade ~0% (falsos retângulos do fundo
// pontuam como folha). O usuário segue direções para centralizar um
// retângulo inexistente e nunca atinge "Pronto". O timeout é a defesa de
// UX — não resolve a especificidade, mas evita que o usuário fique preso
// seguindo direções para o vazio. Validado como necessário pelo gate F2
// (dataset 73:30, acurácia 69.9%, 0/30 negativos corretos).
const STUCK_TIMEOUT_MS = 15000;   // 15s sem ready → primeira ajuda
const HELP_COOLDOWN_MS = 12000;   // repete a cada 12s se continuar stuck

// Histerese temporal (estabilizador simples pré-F3): o YOLO pode oscilar
// entre found=true/false entre frames adjacentes (falsos positivos
// transitórios em alguns frames). Exigir N frames consecutivos com
// found=true antes de reportar found=true ao áudio evita "Pronto" em
// rajada. Reset no primeiro found=false.
const FOUND_HOLD_FRAMES = 3;

// Auto-captura: após AUTO_CAPTURE_DELAY_MS estável em "ready" (folha
// encontrada + centralizada + cobertura na faixa), dispara onAutoCapture.
// O usuário cego não precisa clicar — a captura acontece sozinha quando
// o enquadramento está bom por tempo suficiente.
const AUTO_CAPTURE_DELAY_MS = 3000;

// Throttle adaptativo (F1 conservador; refinamento é F6).
// YOLO: inference ~63ms desktop, ~150-300ms estimado Moto E. O throttle
// padrão de 450ms acomoda o YOLO com folga no desktop; no Moto E pode
// subir para 700ms (INTERVAL_MAX). Os thresholds são conservadores.
const INTERVAL_DEFAULT = 450;
const INTERVAL_MAX = 800;
const INTERVAL_MIN = 300;
const MS_THRESHOLD_UP = 350; // YOLO é mais lento que OpenCV — threshold maior
const MS_THRESHOLD_DOWN = 80; // YOLO rápido → permite intervalo menor
const WIDTH_DEFAULT = 160;   // largura do canvas de captura (não afeta YOLO)
const WIDTH_MIN = 120;

export class FramingGuide {
  /**
   * @param {{conf?: number, onStatus?: function, onAutoCapture?: function}} [opts]
   *   YOLO: limiar de confiança da detecção (default 0.35 — gate browser
   *   validado: 99% acurácia, 96.7% espec). onStatus: callback para reportar
   *   status do detector (debug visual). onAutoCapture: callback disparado
   *   após AUTO_CAPTURE_DELAY_MS estável em "ready" — captura automática.
   */
  constructor(opts = {}) {
    this.conf = opts.conf || 0.35;
    this.onStatus = opts.onStatus || null;
    this.onAutoCapture = opts.onAutoCapture || null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.w = WIDTH_DEFAULT;
    this.h = 120;

    // Worker — vivo entre start()/stop() (B4). Criado no primeiro start().
    this.worker = null;
    this.workerReady = false;
    this.workerFailed = false; // erro fatal — não recriar no próximo start
    this.workerRetried = false; // já tentou reinicializar uma vez

    // Backpressure (só no ramo worker — fallback é síncrono).
    this.inFlight = false;

    // Throttle temporal.
    this.lastFrameTime = 0;
    this.interval = INTERVAL_DEFAULT;

    // Loop.
    this._rafId = null;
    this._rafKind = null; // 'rVFC' | 'rAF' — qual API agendou (G1: cancel certo)
    this._running = false;

    // Fonte ativa: 'fallback' ou 'worker'. Stats delegadas (B1).
    this.activeSource = 'fallback';

    // Stats do wrapper do worker (B1) — instância própria via createStats().
    this.workerStats = createStats();

    // Instrumentação: tempo desde start() até ready (gate de carga de F6).
    this._startAt = 0;
    this._firstResultHeap = 0; // gate de A4

    // UX fallback (F2b): tracking de "ready" e timeout de ajuda.
    this._lastReadyMs = 0;       // último momento em que metrics eram "ready"
    this._lastHelpMs = 0;        // último momento em que a ajuda foi falada
    this._helpPending = false;  // já passou do timeout mas ainda não falou

    // Histerese temporal: contador de frames consecutivos com found=true.
    this._foundStreak = 0;

    // Auto-captura: timestamp do início do estado "ready" estável.
    // null = não está em ready. Quando atinge AUTO_CAPTURE_DELAY_MS,
    // dispara onAutoCapture e seta _autoCaptureFired para não repetir.
    this._readySinceMs = null;
    this._autoCaptureFired = false;

    // Pré-carregamento: cria o worker imediatamente no construtor para
    // baixar o modelo ONNX (12MB) em background, sem esperar o usuário
    // clicar na câmera. O worker emite 'ready' quando o modelo carrega;
    // o guia só começa a enviar frames no start().
    if (!this.worker && !this.workerFailed) {
      this._createWorker();
      if (this.onStatus) this.onStatus({ detector: 'yolo', state: 'loading' });
    }
  }

  /**
   * Inicia o guia. Reutiliza guideCanvas existente do index.html.
   * Worker reusado entre toggles (B4) — se já existe e está ready, reusa.
   * @param {HTMLVideoElement} video
   * @param {HTMLCanvasElement} canvas - guideCanvas do index.html
   */
  start(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    if (!video || !canvas) return;

    // Configura canvas com aspecto preservado (h derivado de videoHeight/Width).
    // Mudança de comportamento F1: w=160 (era 96). Declarado no BENCHMARK.md.
    this.w = WIDTH_DEFAULT;
    this.h = Math.max(1, Math.round((WIDTH_DEFAULT * video.videoHeight) / video.videoWidth));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });

    this._running = true;
    this._startAt = performance.now();
    this.lastFrameTime = 0;
    this.interval = INTERVAL_DEFAULT;
    this.inFlight = false;

    // UX fallback: reseta tracking de ready/help a cada start().
    this._lastReadyMs = this._startAt;
    this._lastHelpMs = 0;
    this._helpPending = false;

    // Auto-captura: reseta a cada start().
    this._readySinceMs = null;
    this._autoCaptureFired = false;

    // Worker: já foi criado no construtor (pré-carregamento). Se falhou
    // antes, fica no fallback. Se já está ready, troca fonte imediatamente.
    if (this.worker && this.workerReady) {
      this.activeSource = 'worker';
    } else if (this.worker && !this.workerFailed) {
      // Worker existe mas ainda carregando — fallback até ready.
      this.activeSource = 'fallback';
    } else {
      // Worker falhou ou não existe — fallback permanente.
      this.activeSource = 'fallback';
    }

    audio.start();
    this._loop();
  }

  /**
   * Para o guia (toggle do usuário). NÃO termina o worker (B4) — só para
   * de enviar frames. Worker fica ocioso em background.
   */
  stop() {
    this._running = false;
    // G1 (review): cancelar com a API certa — rVFC e rAF têm espaços de ID
    // separados. cancelAnimationFrame sobre handle de rVFC cancela um rAF
    // alheio com ID colidente (ou não cancela nada).
    if (this._rafId !== null) {
      if (this._rafKind === 'rVFC' && this.video && this.video.cancelVideoFrameCallback) {
        this.video.cancelVideoFrameCallback(this._rafId);
      } else {
        cancelAnimationFrame(this._rafId);
      }
      this._rafId = null;
      this._rafKind = null;
    }
    this.inFlight = false;
    audio.stop();
    // navigator.vibrate(0) defensivo (haptics.js é F5, mas limpa vibração ativa).
    if (navigator.vibrate) try { navigator.vibrate(0); } catch (e) {}
  }

  /**
   * Desmonte real (fim de vida) — termina o worker. Chamado em pagehide
   * (não unload — bfcache no iOS não dispara unload e Safari o ignora).
   * Diferente de stop(): stop() é toggle do usuário, destroy() é fim de vida.
   */
  destroy() {
    this.stop();
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) {}
      this.worker = null;
      this.workerReady = false;
    }
  }

  /**
   * Stats delegadas à fonte ativa (B1). Pass-through — guide.js não
   * acumula nada próprio.
   */
  getStats() {
    return this.activeSource === 'worker'
      ? this.workerStats.get()
      : fallbackStats.get();
  }

  resetStats() {
    if (this.activeSource === 'worker') {
      this.workerStats.reset();
    } else {
      fallbackStats.reset();
    }
  }

  // -----------------------------------------------------------------------
  // Loop (B3 — ordem explícita)
  // -----------------------------------------------------------------------

  _loop() {
    if (!this._running) return;

    // 1. Gate temporal em ambos os ramos.
    const now = performance.now();
    if (now - this.lastFrameTime < this.interval) {
      this._schedule();
      return;
    }

    // 2. Se inFlight (worker em processamento), descartar e agendar.
    if (this.inFlight) {
      this._schedule();
      return;
    }

    // 3. Capturar imageData (drawImage + getImageData).
    if (!this.video.videoWidth) {
      this._schedule();
      return;
    }
    // Recalcula dimensões do canvas se o vídeo ganhou dimensões depois do
    // start() (videoWidth=0 no start → h=NaN → getImageData falha). Também
    // cobre o caso do throttle adaptativo ter mudado this.w.
    const targetH = Math.max(1, Math.round((this.w * this.video.videoHeight) / this.video.videoWidth));
    if (this.canvas.width !== this.w || this.canvas.height !== targetH) {
      this.h = targetH;
      this.canvas.width = this.w;
      this.canvas.height = this.h;
    }
    this.ctx.drawImage(this.video, 0, 0, this.w, this.h);
    const img = this.ctx.getImageData(0, 0, this.w, this.h);
    this.lastFrameTime = now;

    // 4. Switch de fonte (B3):
    //    - Worker ready: transfer + inFlight=true (assíncrono).
    //    - Worker não ready: fallback síncrono, SEM inFlight.
    if (this.workerReady) {
      this.inFlight = true;
      this.worker.postMessage(
        { type: 'frame', width: this.w, height: this.h, buffer: img.data.buffer },
        [img.data.buffer]
      );
    } else {
      const result = fallbackDetect(img, this.w, this.h);
      this._onResult(result);
    }

    this._schedule();
  }

  _schedule() {
    if (!this._running) return;
    // requestVideoFrameCallback (se disponível) alinha com o refresh do vídeo;
    // fallback requestAnimationFrame para navegadores sem rVFC.
    // G1 (review): rastrear qual API agendou para cancelar com a certa.
    if (this.video && this.video.requestVideoFrameCallback) {
      this._rafKind = 'rVFC';
      this._rafId = this.video.requestVideoFrameCallback(() => this._loop());
    } else {
      this._rafKind = 'rAF';
      this._rafId = requestAnimationFrame(() => this._loop());
    }
  }

  // -----------------------------------------------------------------------
  // Worker
  // -----------------------------------------------------------------------

  _createWorker() {
    // YOLO é o detector principal (99% acurácia, 96.7% especificidade).
    // Fallback para frame-worker (OpenCV) se o YOLO falhar ao carregar.
    this.worker = new Worker(new URL('./yolo-worker.js', import.meta.url));
    this.worker.onmessage = (e) => this._onWorkerMessage(e.data);
    this.worker.onerror = (e) => this._onWorkerError(e.message || String(e));
    // Configuração ANTES do primeiro frame (conf=0.35 — gate browser validado).
    this.worker.postMessage({ type: 'config', conf: this.conf });
  }

  _onWorkerMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        this._onWorkerReady();
        break;
      case 'notready':
        // B2: só limpa inFlight — sem trocar fonte, sem retry.
        this.inFlight = false;
        break;
      case 'result':
        this._onResult(msg);
        break;
      case 'error':
        this._onWorkerError(msg.message || 'unknown');
        break;
    }
  }

  _onWorkerReady() {
    this.workerReady = true;
    this.activeSource = 'worker';
    this.inFlight = false;

    // Anúncio (prioridade STATUS — não é direção do guia).
    queue.speak('Modo de precisão ativado.', PRIORITY.STATUS);

    // Instrumentação: tempo desde start() até ready (gate de carga de F6).
    const loadMs = performance.now() - this._startAt;
    console.log('[FramingGuide] YOLO worker ready em', Math.round(loadMs), 'ms');
    if (this.onStatus) this.onStatus({ detector: 'yolo', state: 'ready', loadMs: Math.round(loadMs) });
  }

  _onWorkerError(message) {
    // B2: erro real (não notready) — rebaixa para fallback, tenta reinicializar.
    console.error('[FramingGuide] worker error:', message);
    this.workerReady = false;
    this.activeSource = 'fallback';
    this.inFlight = false;
    if (this.onStatus) this.onStatus({ detector: 'fallback', state: 'error', message });

    // Termina o worker (erro real, não corrida de init).
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) {}
      this.worker = null;
    }

    // Tenta reinicializar uma vez; se falhar de novo, fica no fallback.
    if (!this.workerRetried) {
      this.workerRetried = true;
      this._createWorker();
    } else {
      this.workerFailed = true; // não recriar no próximo start()
      console.warn('[FramingGuide] worker falhou definitivamente — fallback permanente.');
    }
  }

  // -----------------------------------------------------------------------
  // Resultado (comum aos dois ramos)
  // -----------------------------------------------------------------------

  _onResult(metrics) {
    // inFlight só no ramo worker — fallback já é síncrono (inofensivo limpar).
    this.inFlight = false;

    // G3 (review): descartar results atrasados cujo mode não bate com a
    // fonte ativa. Um result do worker que chega depois de _onWorkerError
    // (rebaixamento para fallback) ainda alimentaria _adaptThrottle e
    // audio.update() — feedback de áudio vindo de fonte já rebaixada.
    // F2: a fonte worker emite qualquer modo de WORKER_MODES (otsu/adaptive/
    // canny) — todos alimentam as mesmas stats, throttle e audio.update().
    const modeOk = this.activeSource === 'worker'
      ? WORKER_MODES.has(metrics && metrics.mode)
      : (metrics && metrics.mode) === 'heuristic';
    if (!modeOk) {
      return;
    }

    // Stats delegadas à fonte ativa (B1): FallbackDetector já chamou
    // stats.record internamente; wrapper do worker chama aqui.
    if (this.activeSource === 'worker') {
      this.workerStats.record(metrics.ms, metrics.found);

      // Gate de A4: heap WASM do primeiro result.
      if (this._firstResultHeap === 0 && metrics.wasmHeap) {
        this._firstResultHeap = metrics.wasmHeap;
        console.log('[FramingGuide] WASM heap inicial:', Math.round(metrics.wasmHeap / 1024 / 1024), 'MB');
      }
    }

    // Throttle adaptativo (F1 conservador): medir ms da fonte ativa.
    this._adaptThrottle(metrics.ms);

    // Histerese temporal (estabilizador simples pré-F3): exigir N frames
    // consecutivos com found=true antes de reportar found=true ao áudio.
    // O YOLO pode oscilar entre found=true/false em frames adjacentes
    // (falsos positivos transitórios). Sem isso, "Pronto" dispara no
    // primeiro frame com detecção, mesmo que o próximo já não detecte.
    //
    // Exceção: detecções parciais (folha na borda do quadro) bypassam a
    // histerese — a folha está saindo do quadro e o usuário precisa de
    // direção imediata, não de 3 frames de confirmação.
    if (metrics.found) {
      if (metrics.partial) {
        // Parcial: reseta streak mas reporta found=true imediatamente.
        this._foundStreak = 0;
      } else {
        this._foundStreak++;
        if (this._foundStreak < FOUND_HOLD_FRAMES) {
          // Ainda não tem confiança suficiente — reporta como sem folha.
          metrics = { ...metrics, found: false };
        }
      }
    } else {
      this._foundStreak = 0;
    }

    // Debug visual: loga detecções a cada ~2s para não floodar o console.
    const now = performance.now();
    if (!this._lastDebugLog || now - this._lastDebugLog > 2000) {
      this._lastDebugLog = now;
      console.log('[FramingGuide] det:', metrics.found ? 'FOLHA' : 'sem folha',
        '| mode:', metrics.mode, '| conf:', metrics.confidence?.toFixed(3),
        '| ms:', metrics.ms?.toFixed(0), '| coverage:', metrics.coverage?.toFixed(3));
      if (this.onStatus) {
        this.onStatus({
          detector: this.activeSource === 'worker' ? 'yolo' : 'fallback',
          state: 'detecting',
          found: metrics.found, conf: metrics.confidence, ms: metrics.ms,
          coverage: metrics.coverage, mode: metrics.mode,
        });
      }
    }

    // UX fallback (F2b): tracking de "ready" + timeout de ajuda.
    this._checkStuck(metrics);

    // Encaminha para áudio (em F1, sem estabilizador — direto).
    audio.update(metrics);
  }

  /**
   * UX fallback (F2b): se o usuário não atinge "ready" (found + centralizado
   * + cobertura na faixa) em STUCK_TIMEOUT_MS, fala "aproxime a folha".
   * Repete a cada HELP_COOLDOWN_MS se continuar stuck. Reseta em ready.
   *
   * "Ready" usa as MESMAS constantes de audio.js (CENTER_MARGIN,
   * TARGET_COVERAGE_MIN/MAX) — se elas mudarem lá, mudam aqui também
   * (importadas, não duplicadas).
   * @param {object} m - métricas do detector
   */
  _checkStuck(m) {
    const now = performance.now();
    const ready = m.found
      && !m.partial
      && Math.abs(m.cx - 0.5) < CENTER_MARGIN
      && Math.abs(m.cy - 0.5) < CENTER_MARGIN
      && m.coverage >= TARGET_COVERAGE_MIN
      && m.coverage <= TARGET_COVERAGE_MAX;

    if (ready) {
      this._lastReadyMs = now;
      this._helpPending = false;

      // Auto-captura: se estável em ready por AUTO_CAPTURE_DELAY_MS,
      // dispara onAutoCapture (uma vez por sessão de start()).
      if (!this._autoCaptureFired && this.onAutoCapture) {
        if (this._readySinceMs === null) {
          this._readySinceMs = now;
        } else if (now - this._readySinceMs >= AUTO_CAPTURE_DELAY_MS) {
          this._autoCaptureFired = true;
          this.onAutoCapture();
        }
      }
      return;
    }

    // Saiu de ready — reset do timer de auto-captura (mas não do fired,
    // que só reset a cada start()).
    this._readySinceMs = null;

    const sinceReady = now - this._lastReadyMs;
    if (sinceReady < STUCK_TIMEOUT_MS) return; // ainda dentro do tempo

    // Passou do timeout — fala a ajuda (com cooldown de repetição).
    const sinceHelp = now - this._lastHelpMs;
    if (sinceHelp < HELP_COOLDOWN_MS) return;

    this._lastHelpMs = now;
    // Prioridade GUIDE (mesma das direções). Não preempcta STATUS, mas a
    // frase é diferente das direções repetidas — passa pela fila sem
    // ser suprimida pelo cooldown de frase idêntica do audio.js.
    queue.speak('Não consigo enquadrar. Afaste a câmera da folha.', PRIORITY.GUIDE);
  }

  /**
   * Throttle adaptativo: se ms > 120 aumenta intervalo/baixa largura;
   * se ms < 40 permite intervalo menor. Limiar 120ms < A2 (150ms) — defesa.
   * Registrar width junto ao ms (sem isso, medições não são comparáveis).
   * @param {number} ms
   */
  _adaptThrottle(ms) {
    if (ms > MS_THRESHOLD_UP) {
      if (this.interval < INTERVAL_MAX) {
        this.interval = Math.min(INTERVAL_MAX, this.interval + 50);
      } else if (this.w > WIDTH_MIN) {
        // Já no intervalo máx — baixa largura para aliviar.
        this.w = WIDTH_MIN;
        this.h = Math.max(1, Math.round((WIDTH_MIN * this.video.videoHeight) / this.video.videoWidth));
        this.canvas.width = this.w;
        this.canvas.height = this.h;
      }
    } else if (ms < MS_THRESHOLD_DOWN && this.interval > INTERVAL_MIN) {
      this.interval = Math.max(INTERVAL_MIN, this.interval - 50);
    }
  }
}

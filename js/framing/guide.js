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
import { audio } from './audio.js';
import { queue, PRIORITY } from '../speech.js';

// Throttle adaptativo (F1 conservador; refinamento é F6).
const INTERVAL_DEFAULT = 450;
const INTERVAL_MAX = 700;
const INTERVAL_MIN = 300;
const MS_THRESHOLD_UP = 120; // >120ms → aumenta intervalo (defesa < A2 150ms)
const MS_THRESHOLD_DOWN = 40; // <40ms → permite intervalo menor
const WIDTH_DEFAULT = 160;
const WIDTH_MIN = 120;

export class FramingGuide {
  constructor() {
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

    // Worker: reusa se existe e está ready; cria se não existe ou foi
    // terminado por erro fatal (B4).
    if (!this.worker && !this.workerFailed) {
      this._createWorker();
    } else if (this.worker && this.workerReady) {
      // Worker já ready de toggle anterior — troca fonte imediatamente.
      this.activeSource = 'worker';
    } else {
      // Worker existe mas não ready ainda — fallback até ready.
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
    this.worker = new Worker(new URL('./frame-worker.js', import.meta.url));
    this.worker.onmessage = (e) => this._onWorkerMessage(e.data);
    this.worker.onerror = (e) => this._onWorkerError(e.message || String(e));
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
    console.log('[FramingGuide] worker ready em', Math.round(loadMs), 'ms');
  }

  _onWorkerError(message) {
    // B2: erro real (não notready) — rebaixa para fallback, tenta reinicializar.
    console.error('[FramingGuide] worker error:', message);
    this.workerReady = false;
    this.activeSource = 'fallback';
    this.inFlight = false;

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
    const expectedMode = this.activeSource === 'worker' ? 'otsu' : 'heuristic';
    if (metrics && metrics.mode && metrics.mode !== expectedMode) {
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

    // Encaminha para áudio (em F1, sem estabilizador — direto).
    audio.update(metrics);
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

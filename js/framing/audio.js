/* =========================================================================
   audio.js — singleton AudioFeedback (F1, passo 4)

   Reorganiza o áudio do guia (oscilador + pan estéreo + TTS) num módulo
   singleton. Preserva o StereoPannerNode existente (pan = desvio horizontal
   da folha). app.js e guide.js importam o mesmo singleton — um único
   AudioContext, um único resume().

   - activate(): cria E dá resume() no AudioContext (chamado no gesto do
     botão — correção defensiva do AudioContext suspended).
   - update(metrics): atualiza tom/pan/TTS a partir das métricas do detector.
     Em F1 sem estabilizador — feedback direto sobre métricas cruas.
   - stop(): silencia tom (gain→0), suspend() no contexto (não close() —
     close() é irreversível; no iOS a recriação exige gesto novo).
   - beep(): exposto para substituir o beep() do app.js que criava um
     AudioContext novo por chamada (Chrome limita a ~6). Chama ctx.resume()
     antes de tocar — o stop() do guia suspende o contexto compartilhado.

   Fica para F4: pulsação por distância, orientação/heading, voiceschanged.
   ========================================================================= */

import { queue, PRIORITY } from '../speech.js';

// Faixa de cobertura da folha em relação ao quadro considerada boa distância.
// Migradas do app.js (GUIDE_TARGET_COVERAGE_MIN/MAX, GUIDE_CENTER_MARGIN).
// Exportadas para guide.js (UX fallback: detectar "ready" sem duplicar valores).
export const TARGET_COVERAGE_MIN = 0.30;
export const TARGET_COVERAGE_MAX = 0.65;
export const CENTER_MARGIN = 0.08; // ~8% do quadro contado como "centralizado"

// Cooldown de TTS do guia: suprime frase idêntica por ~2s. NÃO bloqueia
// mudança de estado — só evita repetir a mesma frase em rajada.
const TTS_COOLDOWN_MS = 2200;
// Cooldown específico para "Folha não encontrada" — o usuário sem folha
// não precisa ouvir isso a cada 3s. 8s é suficiente para não ser irritante
// mas ainda informar se a folha saiu do quadro.
const TTS_NOT_FOUND_COOLDOWN_MS = 8000;
// Cooldown GLOBAL entre qualquer frase do guia (não só idêntica). Sem isso,
// o detector oscila entre "Câmera para cima" e "Pronto" a cada frame e o
// usuário ouve as duas frases em rajada (o cooldown idêntico não impede
// porque são frases DIFERENTES). 3s = tempo mínimo entre direções.
const TTS_GLOBAL_COOLDOWN_MS = 3000;
// Lock de "Pronto": uma vez dito, segura por 5s antes de permitir outra
// direção. Evita "Pronto → Câmera para cima → Pronto" em oscilação.
const READY_LOCK_MS = 5000;

class AudioFeedback {
  constructor() {
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.panner = null;
    this._active = false; // guia rodando (start chamado, stop não)
    this._lastPhrase = '';
    this._lastSpokenAt = 0;
    this._lastAnySpokenAt = 0; // cooldown global entre qualquer frase
    this._readyLockUntil = 0;  // lock após "Pronto" — segura por READY_LOCK_MS
  }

  /**
   * Cria (se preciso) E dá resume() no AudioContext. Deve ser chamado
   * sincronamente dentro de um gesto do usuário (click handler) para
   * satisfazer a política de autoplay dos navegadores.
   */
  activate() {
    if (!this.ctx) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        this.osc = this.ctx.createOscillator();
        this.gain = this.ctx.createGain();
        this.panner = this.ctx.createStereoPanner
          ? this.ctx.createStereoPanner()
          : null;
        this.osc.type = 'sine';
        this.gain.gain.value = 0;
        this.osc.connect(this.gain);
        if (this.panner) {
          this.gain.connect(this.panner);
          this.panner.connect(this.ctx.destination);
        } else {
          this.gain.connect(this.ctx.destination);
        }
        this.osc.start();
      } catch (e) {
        this.ctx = null;
        return;
      }
    }
    // resume() é barato, idempotente, e não precisa de gesto se já houve um.
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* noop */ });
    }
  }

  /**
   * Atualiza tom/pan/TTS a partir das métricas do detector. Em F1 sem
   * estabilizador — feedback direto sobre métricas cruas (como o
   * analyzeFrameForGuide original).
   * @param {object} m - métricas do detector ({found,cx,cy,coverage,...})
   */
  update(m) {
    if (!this.ctx || !this._active) return;
    // F3: feedback apenas por voz — oscilador removido (buzz irritante).
    // O tom contínuo era confuso para o usuário cego. Voz é mais claro.
    const now = this.ctx.currentTime;

    if (!m.found) {
      // Sem folha: silencia tom (defensivo — gain já é 0, mas garante).
      this.gain.gain.setTargetAtTime(0, now, 0.1);
      if (this.panner) this.panner.pan.setTargetAtTime(0, now, 0.1);
      this._speakGuide('Folha não encontrada.');
      return;
    }

    const dx = m.cx - 0.5; // negativo = folha à esquerda do quadro
    const dy = m.cy - 0.5;
    const centered = Math.abs(dx) < CENTER_MARGIN && Math.abs(dy) < CENTER_MARGIN;
    const distanceOk = m.coverage >= TARGET_COVERAGE_MIN && m.coverage <= TARGET_COVERAGE_MAX;

    // Pan estéreo mantido (acompanha folha — feedback sutil, não irritante).
    const pan = Math.max(-1, Math.min(1, dx * 2.2));
    if (this.panner) this.panner.pan.setTargetAtTime(pan, now, 0.08);

    // Tom desligado — feedback só por voz.
    this.gain.gain.setTargetAtTime(0, now, 0.08);

    // Feedback falado — frases curtas padronizadas (≤5 palavras)
    // Lock de "Pronto": se disse "Pronto" há menos de READY_LOCK_MS, não
    // diz outra direção (evita oscilação Pronto→direção→Pronto).
    const nowMs = performance.now();
    const inReadyLock = nowMs < this._readyLockUntil;
    if (centered && distanceOk) {
      this._speakGuide('Pronto, pode capturar.');
    } else if (!inReadyLock) {
      if (!distanceOk && m.coverage < TARGET_COVERAGE_MIN) {
        this._speakGuide('Aproxime.');
      } else if (!distanceOk && m.coverage > TARGET_COVERAGE_MAX) {
        this._speakGuide('Afaste.');
      } else if (Math.abs(dx) >= CENTER_MARGIN) {
        this._speakGuide(dx < 0 ? 'Câmera para a esquerda.' : 'Câmera para a direita.');
      } else if (Math.abs(dy) >= CENTER_MARGIN) {
        this._speakGuide(dy < 0 ? 'Câmera para cima.' : 'Câmera para baixo.');
      }
    }
  }

  /**
   * Inicia o modo guia: marca _active para update() começar a atuar.
   * O AudioContext já deve ter sido ativado via activate() no gesto do botão.
   * Menor (review): zera o gain com setValueAtTime — o stop() anterior
   * suspend() o contexto imediatamente após setTargetAtTime(0), congelando
   * a rampa no valor corrente. Sem isso, o próximo start() retoma o tom
   * no volume antigo até o primeiro result.
   */
  start() {
    this._active = true;
    if (this.gain && this.ctx) {
      try { this.gain.gain.setValueAtTime(0, this.ctx.currentTime); } catch (e) { /* noop */ }
    }
    // Reseta cooldowns/lock ao iniciar (não herdar de sessão anterior).
    this._lastPhrase = '';
    this._lastSpokenAt = 0;
    this._lastAnySpokenAt = 0;
    this._readyLockUntil = 0;
  }

  /**
   * Para o modo guia: silencia tom, suspend() no contexto (não close()).
   * Mantém um contexto por sessão, reativável sem gesto novo no iOS.
   * NÃO termina o worker — isso é guide.js que cuida (B4).
   */
  stop() {
    this._active = false;
    if (this.gain && this.ctx) {
      // Menor (review): setValueAtTime(0) imediato + suspend() — setTargetAtTime
      // com suspend() imediato congela a rampa no valor corrente. Zerar direto.
      try { this.gain.gain.setValueAtTime(0, this.ctx.currentTime); } catch (e) { /* noop */ }
    }
    if (this.ctx && this.ctx.state === 'running') {
      try { this.ctx.suspend(); } catch (e) { /* noop */ }
    }
    // Mata só falas do guia, preserva STATUS pendente (A6).
    queue.clear(PRIORITY.GUIDE);
    this._lastPhrase = '';
  }

  /**
   * Bip curto para feedback semântico do app (ok/action/error/sending).
   * Reaproveita o contexto do singleton — não cria um novo por chamada
   * (Chrome limita a ~6 contextos por página). Chama ctx.resume() antes
   * de tocar: o stop() do guia suspende o contexto compartilhado, e sem
   * resume() o próximo sounds.ok() toca mudo (regressão singleton+suspend).
   * @param {number} freq
   * @param {number} duration - ms
   * @param {string} type - tipo do oscilador
   */
  beep(freq = 440, duration = 120, type = 'sine') {
    try {
      this.activate(); // cria+resume se preciso (idempotente)
      if (!this.ctx) return;
      const ctx = this.ctx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      osc.start();
      osc.stop(ctx.currentTime + duration / 1000);
      osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
    } catch (e) { /* silencioso */ }
  }

  /**
   * Fala do guia com dois níveis de cooldown:
   * 1. Cooldown idêntico (~2s): suprime a MESMA frase em rajada.
   * 2. Cooldown global (~3s): tempo mínimo entre QUALQUER frase do guia,
   *    evitando "Câmera para cima → Pronto → Câmera para cima" em oscilação.
   * "Pronto, pode capturar." ignora o cooldown global (é a frase mais
   * importante — o usuário precisa saber que pode capturar) e ativa o
   * ready-lock (segura direções por 5s).
   * @param {string} text
   * @private
   */
  _speakGuide(text) {
    const now = performance.now();
    // Cooldown idêntico: mesma frase dentro do cooldown → suprime.
    // "Folha não encontrada" tem cooldown maior (8s) — não irrita o usuário.
    const isNotFound = text === 'Folha não encontrada.';
    const identicalCooldown = isNotFound ? TTS_NOT_FOUND_COOLDOWN_MS : TTS_COOLDOWN_MS;
    if (text === this._lastPhrase && now - this._lastSpokenAt < identicalCooldown) return;

    const isReady = text === 'Pronto, pode capturar.';
    // Cooldown global: qualquer frase não-ready dentro de 3s da última → suprime.
    // Ready passa direto (prioridade máxima do guia).
    if (!isReady && now - this._lastAnySpokenAt < TTS_GLOBAL_COOLDOWN_MS) return;

    this._lastSpokenAt = now;
    this._lastPhrase = text;
    this._lastAnySpokenAt = now;
    if (isReady) {
      // Lock: após "Pronto", segura direções por 5s mesmo se o detector oscilar.
      this._readyLockUntil = now + READY_LOCK_MS;
    }
    queue.speak(text, PRIORITY.GUIDE);
  }
}

// Singleton — um único AudioContext, um único resume(), compartilhado entre
// app.js (beep/sounds) e guide.js (update/start/stop).
export const audio = new AudioFeedback();

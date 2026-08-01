/* =========================================================================
   speech.js — SpeechQueue com prioridade (F1, passo 3)

   Fila única de utterances com prioridade numérica. Convenção (rev. 3):
   menor número = maior prioridade. STATUS=0 (app), GUIDE=1 (guia).

   A6 (rev. 4): speechSynthesis.cancel() é global — não há como cancelar um
   utterance específico. A fila mantém UM único utterance entregue ao
   browser por vez (`current`) + o restante em array JS (`queue`).
   speechSynthesis.cancel() só é chamado na preempção do `current` por um
   novo utterance de prioridade maior (número menor). clear(minPriority)
   filtra a fila JS e só cancela o `current` se current.priority >= min.

   Sem isso, clear(PRIORITY.GUIDE) mata a fala de STATUS em reprodução que
   promete preservar.
   ========================================================================= */

/**
 * Prioridades numéricas. Menor número = maior prioridade.
 * clear(minPriority) remove tudo com prioridade >= min.
 */
export const PRIORITY = {
  STATUS: 0, // mensagens de status do app (ex.: "Guia desativado")
  GUIDE: 1,  // direções do guia de enquadramento
};

/**
 * @typedef {Object} QueueEntry
 * @property {string} text
 * @property {number} priority
 * @property {SpeechSynthesisUtterance} utterance
 */

export class SpeechQueue {
  constructor() {
    /** @type {QueueEntry|null} */
    this.current = null; // utterance em reprodução no browser
    /** @type {QueueEntry[]} */
    this.queue = []; // pendentes em JS, ainda não entregues ao browser
    this._speaking = false;
  }

  /**
   * Enfileira e dispara a fala. Se o novo tem prioridade maior (número menor)
   * que o `current`, preempciona: cancela o current, re-enfileira se sua
   * prioridade for menor (número maior) que a do novo.
   * @param {string} text
   * @param {number} priority
   */
  speak(text, priority = PRIORITY.STATUS) {
    if (!text || typeof speechSynthesis === 'undefined') return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'pt-BR';
    utterance.rate = 1;
    // Seleciona voz pt-BR se disponível (Chrome carrega assíncrono — pode
    // ainda não estar pronto no primeiro speak, mas tenta a cada chamada).
    const voices = speechSynthesis.getVoices();
    if (voices && voices.length) {
      const ptVoice = voices.find(v => v.lang === 'pt-BR')
        || voices.find(v => v.lang && v.lang.startsWith('pt'));
      if (ptVoice) utterance.voice = ptVoice;
    }
    const entry = { text, priority, utterance };

    // Preempção: novo tem prioridade maior (número menor) que o current.
    // B3 (review): desanexar handlers do current ANTES de cancel() — senão
    // o onerror assíncrono do utterance cancelado zera o current NOVO.
    // Bônus (review): o if aninhado era a mesma condição do if externo — removido.
    if (this.current && priority < this.current.priority) {
      // Re-enfileira o current (prioridade menor = número maior que a do novo).
      this.queue.push(this.current);
      // Desanexa handlers para evitar órfão assíncrono.
      this.current.utterance.onend = null;
      this.current.utterance.onerror = null;
      // cancel() é global — cancela tudo. O current foi re-enfileirado acima;
      // os demais da fila JS permanecem intactos.
      speechSynthesis.cancel();
      this.current = null;
      this._speaking = false;
    }

    this.queue.push(entry);
    this._pump();
  }

  /**
   * Cancela e esvazia só falas com prioridade numérica >= minPriority.
   * stop() do guia chama clear(PRIORITY.GUIDE) = clear(1) — remove só GUIDE
   * (valor 1), preserva STATUS (valor 0). clear() sem argumento = cancela
   * tudo (comportamento original).
   * @param {number} [minPriority] Se omitido, cancela tudo.
   */
  clear(minPriority) {
    if (minPriority === undefined) {
      // Comportamento original: cancela tudo.
      this.queue = [];
      if (this.current) {
        // B3 (review): desanexa handlers antes de cancel().
        this.current.utterance.onend = null;
        this.current.utterance.onerror = null;
        speechSynthesis.cancel();
        this.current = null;
        this._speaking = false;
      }
      return;
    }
    // Filtra a fila JS: remove só entries com priority >= minPriority.
    this.queue = this.queue.filter(e => e.priority < minPriority);
    // Cancela o current só se sua prioridade >= minPriority.
    if (this.current && this.current.priority >= minPriority) {
      // B3 (review): desanexa handlers antes de cancel().
      this.current.utterance.onend = null;
      this.current.utterance.onerror = null;
      speechSynthesis.cancel();
      this.current = null;
      this._speaking = false;
    }
  }

  /**
   * Bombeia a próxima entry da fila para o browser. Mantém um único
   * utterance entregue ao browser por vez (A6).
   * @private
   */
  _pump() {
    if (this._speaking || this.current) return;
    if (this.queue.length === 0) return;

    // Pega a de maior prioridade (menor número); empate = FIFO.
    let bestIdx = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].priority < this.queue[bestIdx].priority) {
        bestIdx = i;
      }
    }
    const entry = this.queue.splice(bestIdx, 1)[0];
    this.current = entry;
    this._speaking = true;

    // B3 (review): guarda de identidade — se o handler disparar para um
    // utterance que já não é o current (cancelado/preempcionado), ignora.
    // Evita zerar o current NOVO e iniciar um segundo utterance em paralelo.
    entry.utterance.onend = () => {
      if (this.current !== entry) return;
      this.current = null;
      this._speaking = false;
      this._pump();
    };
    entry.utterance.onerror = (e) => {
      if (this.current !== entry) return;
      this.current = null;
      this._speaking = false;
      this._pump();
    };

    // Chrome bug: speechSynthesis pode estar travado em speaking:true de
    // uma sessão anterior, mesmo após cancel() na inicialização. Se
    // speaking:true mas nós não temos current (não fomos nós que iniciamos),
    // cancela e re-tenta no próximo tick (cancel é assíncrono no Chrome).
    if (speechSynthesis.speaking && !this.current) {
      try { speechSynthesis.cancel(); } catch (e) {}
      this.queue.push(entry);
      setTimeout(() => { this._speaking = false; this._pump(); }, 50);
      return;
    }

    speechSynthesis.speak(entry.utterance);

    // Chrome bug: speechSynthesis para de disparar onend após ~15s de uso
    // contínuo, travando a fila. resume() a cada speak() contorna isso.
    // Referência: https://stackoverflow.com/questions/21947730
    if (speechSynthesis.paused) {
      try { speechSynthesis.resume(); } catch (e) {}
    }
  }
}

// Singleton compartilhado entre app.js (STATUS) e guide.js/audio.js (GUIDE).
export const queue = new SpeechQueue();

// -------------------------------------------------------------------------
// Inicialização de vozes — Chrome/Safari carregam getVoices() de forma
// assíncrona (vazio até o evento voiceschanged disparar). Sem voz pt-BR
// carregada, speak() pode falhar silenciosamente. Forçamos o carregamento.
// -------------------------------------------------------------------------
if (typeof speechSynthesis !== 'undefined') {
  // Chrome bug: speechSynthesis pode iniciar num estado "speaking: true"
  // travado de uma sessão/tab anterior. O primeiro speak() fica preso sem
  // onend/onerror e nunca toca. cancel() limpa o estado.
  try { speechSynthesis.cancel(); } catch (e) {}

  // Trigger inicial do carregamento de vozes (Chrome: vazio até o evento).
  speechSynthesis.getVoices();
  if (typeof speechSynthesis.onvoiceschanged !== 'undefined') {
    speechSynthesis.onvoiceschanged = () => {
      const voices = speechSynthesis.getVoices();
      console.log('[SpeechQueue] vozes carregadas:', voices.length,
        '| pt-BR:', voices.filter(v => v.lang && v.lang.startsWith('pt')).length);
    };
  }
}

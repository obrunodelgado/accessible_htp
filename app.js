/* =========================================================================
   Leitor de Desenho Projetivo — Protótipo
   Fluxo: câmera -> foto -> Gemini (multimodal) -> descrição/hipóteses -> voz
   ========================================================================= */

import { FramingGuide } from './js/framing/guide.js';
import { audio } from './js/framing/audio.js';
import { queue as speechQueue, PRIORITY } from './js/speech.js';

const els = {
  status: document.getElementById('status'),
  resultText: document.getElementById('resultText'),
  camera: document.getElementById('camera'),
  canvas: document.getElementById('canvas'),
  preview: document.getElementById('preview'),
  captureBtn: document.getElementById('captureBtn'),
  retryBtn: document.getElementById('retryBtn'),
  repeatBtn: document.getElementById('repeatBtn'),
  voiceCmdBtn: document.getElementById('voiceCmdBtn'),
  apiKeyInput: document.getElementById('apiKey'),
  saveKeyBtn: document.getElementById('saveKeyBtn'),
  guideToggleBtn: document.getElementById('guideToggleBtn'),
  guideCanvas: document.getElementById('guideCanvas'),
};

const STORAGE_KEY = 'gemini_api_key';
const MODEL = 'gemini-3.5-flash-lite'; // troque para 'gemini-2.0-flash-lite' se preferir menor custo/latência

let mediaStream = null;
let lastImageBase64 = null;
let lastResultSpokenText = '';

// -------------------------------------------------------------------------
// Utilidades de voz (feedback sonoro + leitura do resultado)
// -------------------------------------------------------------------------

// F1: speak() delega à SpeechQueue com prioridade STATUS (0). A fila garante
// que mensagens de status não sejam canceladas por direções do guia (GUIDE=1)
// e vice-versa — preempção só quando a nova tem prioridade maior (número menor).
// B2 (review): NÃO chama clear() — clear() sem argumento mata tudo (inclusive
// GUIDE), reproduzindo o speechSynthesis.cancel() que se queria substituir.
// A preempção por prioridade já faz o trabalho: STATUS (0) preempciona GUIDE
// (1) se estiver em reprodução, sem esvaziar a fila.
function speak(text, { interrupt = true } = {}) {
  if (!('speechSynthesis' in window)) return;
  speechQueue.speak(text, PRIORITY.STATUS);
}

function setStatus(message, state = 'idle', { announceOnly = false } = {}) {
  els.status.textContent = message;
  els.status.dataset.state = state;
  if (!announceOnly) speak(message);
}

// Pequenos "bips" de feedback sonoro usando WebAudio, para não depender só de TTS.
// F1: beep() delega ao singleton audio.beep() — reaproveita o AudioContext
// compartilhado (Chrome limita a ~6 contextos por página). sounds (paleta
// semântica ok/action/error/sending) mantido intacto — zero call sites tocados.
function beep(freq = 440, duration = 120, type = 'sine') {
  audio.beep(freq, duration, type);
}

const sounds = {
  ok: () => beep(880, 100),
  action: () => beep(600, 80),
  error: () => { beep(220, 200, 'square'); },
  sending: () => beep(500, 60),
};

// -------------------------------------------------------------------------
// Guia sonoro de enquadramento (F1: delegado a FramingGuide)
// O pipeline heurístico inline foi substituído por FramingGuide, que coordena
// FallbackDetector (fonte ativa inicial) + worker OpenCV.js (Otsu-only).
// Áudio/TTS em módulos: js/framing/audio.js (singleton) + js/speech.js (fila).
// -------------------------------------------------------------------------

const framingGuide = new FramingGuide();
let framingGuideEnabled = true; // pode ser desligado pelo botão "Guia sonoro"

function startFramingGuide() {
  if (!framingGuideEnabled) return;
  framingGuide.start(els.camera, els.guideCanvas);
}

function stopFramingGuide() {
  framingGuide.stop();
}

function initGuideToggle() {
  if (!els.guideToggleBtn) return;
  updateGuideToggleLabel();
  els.guideToggleBtn.addEventListener('click', () => {
    framingGuideEnabled = !framingGuideEnabled;
    updateGuideToggleLabel();
    sounds.action();
    if (framingGuideEnabled && mediaStream) {
      // audio.activate() só ao LIGAR o guia — desligar não precisa de contexto.
      // Menor (review): antes roda ao desligar também, criando AudioContext à toa.
      audio.activate();
      setStatus('Guia sonoro de enquadramento ativado.', 'ok');
      startFramingGuide();
    } else {
      setStatus('Guia sonoro de enquadramento desativado.', 'idle');
      stopFramingGuide();
    }
  });
}

function updateGuideToggleLabel() {
  if (!els.guideToggleBtn) return;
  const label = framingGuideEnabled
    ? '🔊 Guia sonoro de enquadramento: ligado'
    : '🔈 Guia sonoro de enquadramento: desligado';
  els.guideToggleBtn.textContent = label;
  els.guideToggleBtn.setAttribute('aria-label', label);
}

// -------------------------------------------------------------------------
// Configuração da chave de API (nunca hardcoded)
// -------------------------------------------------------------------------

function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

function initApiKeyUI() {
  const saved = getApiKey();
  if (saved) els.apiKeyInput.value = saved;

  els.saveKeyBtn.addEventListener('click', () => {
    const key = els.apiKeyInput.value.trim();
    if (!key) {
      setStatus('Nenhuma chave informada.', 'error');
      sounds.error();
      return;
    }
    localStorage.setItem(STORAGE_KEY, key);
    sounds.ok();
    setStatus('Chave da API salva com sucesso. Agora toque em Tirar foto do desenho.', 'ok');
  });
}

// -------------------------------------------------------------------------
// Captura de câmera
// -------------------------------------------------------------------------

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    els.camera.srcObject = mediaStream;
    els.camera.classList.add('active');
    sounds.action();
    setStatus('Câmera ativada. Toque novamente no botão para capturar a foto.', 'idle');
    els.captureBtn.textContent = '📸 Capturar agora';
    els.captureBtn.setAttribute('aria-label', 'Capturar foto agora');
    startFramingGuide();
  } catch (err) {
    sounds.error();
    setStatus('Não foi possível acessar a câmera. Verifique as permissões do navegador e tente novamente.', 'error');
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  els.camera.classList.remove('active');
  stopFramingGuide();
}

function capturePhoto() {
  const video = els.camera;
  const canvas = els.canvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Verificação simples de brilho médio para detectar fotos muito escuras
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  const sampleStep = 40 * 4; // amostragem esparsa por performance
  let samples = 0;
  for (let i = 0; i < data.length; i += sampleStep) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    samples++;
  }
  const avgBrightness = sum / samples;

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  lastImageBase64 = dataUrl.split(',')[1];

  els.preview.src = dataUrl;
  els.preview.classList.add('active');
  stopCamera();

  if (avgBrightness < 25) {
    sounds.error();
    setStatus('A foto parece muito escura. Toque em Tentar novamente e melhore a iluminação.', 'error');
    showRetry();
    return;
  }

  sounds.ok();
  setStatus('Foto capturada. Enviando para análise, aguarde.', 'ok');
  els.retryBtn.style.display = 'none';
  sendToGemini(lastImageBase64);
}

function showRetry() {
  els.retryBtn.style.display = 'block';
}

// -------------------------------------------------------------------------
// Chamada à API do Gemini (multimodal)
// -------------------------------------------------------------------------

const SYSTEM_PROMPT = `
Você é um assistente de apoio técnico para um(a) psicólogo(a) com deficiência visual que aplica
testes projetivos de desenho (como HTP - House-Tree-Person, Desenho da Figura Humana - DFH).
Você NÃO substitui o julgamento clínico do profissional e NÃO fornece diagnóstico.

Fundamente suas observações nos referenciais teóricos clássicos de desenho projetivo, quando aplicável:
- Karen Machover (Desenho da Figura Humana)
- John Buck (HTP - House-Tree-Person)
- Elizabeth Koppitz (indicadores emocionais em desenhos infantis)

Estrutura obrigatória da resposta, em português, clara para leitura em voz alta:

1. "DESCRIÇÃO OBJETIVA": descreva de forma neutra e factual o que está desenhado — elementos presentes
   (ex: casa, árvore, figura humana), proporções aproximadas, posição na folha, traçado (forte/fraco,
   contínuo/entrecortado), presença de detalhes (janelas, portas, mãos, rosto), uso de espaço na página,
   e quaisquer elementos ausentes que normalmente apareceriam. Não interprete nada nesta seção.

2. "HIPÓTESES INTERPRETATIVAS (não são diagnóstico)": apresente de 2 a 4 hipóteses interpretativas
   possíveis, associando cada uma ao elemento objetivo que a embasa e, quando pertinente, ao autor/referencial
   teórico correspondente. Use linguagem de possibilidade ("pode sugerir", "é compatível com", "merece
   investigação clínica adicional") e nunca linguagem afirmativa de diagnóstico. Deixe explícito que a
   decisão clínica final é do profissional.

3. Finalize sempre com uma frase de encerramento breve lembrando que isso é apoio técnico, não diagnóstico.

Seja conciso o suficiente para ser ouvido em voz alta sem cansar, evitando jargão desnecessário.
`.trim();

async function sendToGemini(base64Image) {
  const apiKey = getApiKey();
  if (!apiKey) {
    sounds.error();
    setStatus('Nenhuma chave de API configurada. Abra "Configurar chave da API" e salve sua chave do Gemini.', 'error');
    showRetry();
    return;
  }

  sounds.sending();
  setStatus('Enviando imagem para análise por IA. Aguarde alguns segundos.', 'idle');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Analise o desenho projetivo na imagem a seguir, seguindo estritamente a estrutura definida.' },
          { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1024,
    },
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Gemini API error:', resp.status, errText);
      throw new Error(`status ${resp.status}`);
    }

    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n').trim();

    if (!text) throw new Error('Resposta vazia da API');

    lastResultSpokenText = text;
    els.resultText.style.display = 'block';
    els.resultText.textContent = text;
    els.repeatBtn.style.display = 'block';
    els.retryBtn.style.display = 'block';

    sounds.ok();
    setStatus('Análise pronta. Lendo o resultado em voz alta agora.', 'ok', { announceOnly: true });
    speak('Análise pronta.');
    // Pequeno atraso para não sobrepor as duas falas
    setTimeout(() => speak(text, { interrupt: false }), 900);
  } catch (err) {
    console.error(err);
    sounds.error();
    setStatus('Ocorreu um erro ao consultar a IA. Verifique sua conexão ou a chave de API, e toque em Tentar novamente.', 'error');
    showRetry();
  }
}

// -------------------------------------------------------------------------
// Comando de voz simples (SpeechRecognition)
// -------------------------------------------------------------------------

let recognition = null;

function initVoiceCommands() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    els.voiceCmdBtn.disabled = true;
    els.voiceCmdBtn.setAttribute('aria-label', 'Comando de voz indisponível neste navegador');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'pt-BR';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.toLowerCase();
    handleVoiceCommand(transcript);
  };

  recognition.onerror = () => {
    sounds.error();
    setStatus('Não entendi o comando de voz. Tente novamente.', 'error');
  };

  els.voiceCmdBtn.addEventListener('click', () => {
    // G5 (review): ativar o AudioContext no gesto que inicia o reconhecimento
    // de voz — startCamera() por comando de voz não passa pelo captureBtn,
    // e sem activate() o guia fica mudo (audio.update() retorna cedo se !ctx).
    audio.activate();
    sounds.action();
    setStatus('Ouvindo comando de voz. Diga: foto, repetir, ou tentar novamente.', 'idle', { announceOnly: true });
    speak('Ouvindo comando.');
    try { recognition.start(); } catch (e) { /* já rodando */ }
  });
}

function handleVoiceCommand(transcript) {
  if (transcript.includes('foto') || transcript.includes('captur')) {
    startCamera();
  } else if (transcript.includes('repet')) {
    repeatResult();
  } else if (transcript.includes('tentar') || transcript.includes('nov')) {
    resetFlow();
  } else {
    setStatus(`Comando não reconhecido: "${transcript}". Diga foto, repetir, ou tentar novamente.`, 'idle');
  }
}

function repeatResult() {
  if (lastResultSpokenText) {
    sounds.action();
    speak(lastResultSpokenText);
  } else {
    sounds.error();
    setStatus('Ainda não há resultado para repetir.', 'error');
  }
}

function resetFlow() {
  els.preview.classList.remove('active');
  els.resultText.style.display = 'none';
  els.repeatBtn.style.display = 'none';
  els.retryBtn.style.display = 'none';
  els.captureBtn.textContent = '📷 Tirar foto do desenho';
  els.captureBtn.setAttribute('aria-label', 'Ativar câmera e tirar foto do desenho');
  sounds.action();
  setStatus('Pronto para nova captura. Toque em Tirar foto do desenho.', 'idle');
}

// -------------------------------------------------------------------------
// Ligação dos botões principais
// -------------------------------------------------------------------------

els.captureBtn.addEventListener('click', () => {
  // audio.activate() dentro do gesto — correção defensiva do AudioContext.
  audio.activate();
  if (!mediaStream) {
    startCamera();
  } else {
    capturePhoto();
  }
});

els.retryBtn.addEventListener('click', resetFlow);
els.repeatBtn.addEventListener('click', repeatResult);

initApiKeyUI();
initVoiceCommands();
initGuideToggle();

// B4: destroy() termina o worker no fim de vida da página. pagehide (não
// unload) — bfcache no iOS não dispara unload e o Safari o ignora.
// Menor (review): sem { once: true } — após restauração de bfcache, o
// listener precisa continuar ativo para terminar o worker no próximo fim de vida.
addEventListener('pagehide', () => framingGuide.destroy());

// -------------------------------------------------------------------------
// Registro do Service Worker (PWA instalável)
// -------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW falhou:', e));
  });
}

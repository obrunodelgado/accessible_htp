/* =========================================================================
   Leitor de Desenho Projetivo — Protótipo
   Fluxo: câmera -> foto -> Gemini (multimodal) -> descrição/hipóteses -> voz
   ========================================================================= */

import { detect as detectSheet } from './js/framing/fallback-detector.js';

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

function speak(text, { interrupt = true } = {}) {
  if (!('speechSynthesis' in window)) return;
  if (interrupt) window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'pt-BR';
  utter.rate = 1;
  window.speechSynthesis.speak(utter);
}

function setStatus(message, state = 'idle', { announceOnly = false } = {}) {
  els.status.textContent = message;
  els.status.dataset.state = state;
  if (!announceOnly) speak(message);
}

// Pequenos "bips" de feedback sonoro usando WebAudio, para não depender só de TTS
function beep(freq = 440, duration = 120, type = 'sine') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + duration / 1000);
    osc.onended = () => ctx.close();
  } catch (e) { /* silencioso */ }
}

const sounds = {
  ok: () => beep(880, 100),
  action: () => beep(600, 80),
  error: () => { beep(220, 200, 'square'); },
  sending: () => beep(500, 60),
};

// -------------------------------------------------------------------------
// Guia sonoro de enquadramento
// Enquanto a câmera está ligada (antes da captura), analisa o quadro ao vivo
// para localizar a folha (região clara sobre fundo mais escuro) e emite um
// tom contínuo: o balanço estéreo indica a direção (esquerda/direita) e a
// frequência indica se é preciso aproximar ou afastar a câmera. Frases
// curtas complementam o som em intervalos espaçados para não sobrecarregar.
// -------------------------------------------------------------------------

let framingGuideEnabled = true; // pode ser desligado pelo botão "Guia sonoro"
let guideAudioCtx = null;
let guideOsc = null;
let guideGain = null;
let guidePanner = null;
let guideIntervalId = null;
let guideLastSpokenAt = 0;
let guideLastPhrase = '';

// Faixa de cobertura da folha em relação ao quadro considerada boa distância
const GUIDE_TARGET_COVERAGE_MIN = 0.30;
const GUIDE_TARGET_COVERAGE_MAX = 0.65;
const GUIDE_CENTER_MARGIN = 0.08; // ~8% do quadro contado como "centralizado"

function ensureGuideAudio() {
  if (guideAudioCtx) return;
  try {
    guideAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    guideOsc = guideAudioCtx.createOscillator();
    guideGain = guideAudioCtx.createGain();
    guidePanner = guideAudioCtx.createStereoPanner
      ? guideAudioCtx.createStereoPanner()
      : null;
    guideOsc.type = 'sine';
    guideGain.gain.value = 0;
    guideOsc.connect(guideGain);
    if (guidePanner) {
      guideGain.connect(guidePanner);
      guidePanner.connect(guideAudioCtx.destination);
    } else {
      guideGain.connect(guideAudioCtx.destination);
    }
    guideOsc.start();
  } catch (e) {
    guideAudioCtx = null;
  }
}

function stopGuideAudio() {
  if (guideGain) {
    try { guideGain.gain.setTargetAtTime(0, guideAudioCtx.currentTime, 0.05); } catch (e) { /* noop */ }
  }
  if (guideAudioCtx) {
    try { guideOsc.stop(); } catch (e) { /* noop */ }
    try { guideAudioCtx.close(); } catch (e) { /* noop */ }
  }
  guideAudioCtx = null;
  guideOsc = null;
  guideGain = null;
  guidePanner = null;
}

function speakGuide(text) {
  const now = performance.now();
  if (text === guideLastPhrase && now - guideLastSpokenAt < 2200) return; // evita repetição
  guideLastSpokenAt = now;
  guideLastPhrase = text;
  speak(text, { interrupt: false });
}

function analyzeFrameForGuide() {
  const video = els.camera;
  if (!video.videoWidth) return;

  const w = 96;
  const h = Math.max(1, Math.round((96 * video.videoHeight) / video.videoWidth));
  const gCanvas = els.guideCanvas;
  gCanvas.width = w;
  gCanvas.height = h;
  const ctx = gCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const result = detectSheet(imageData, w, h);

  ensureGuideAudio();
  if (!guideAudioCtx) return;
  const now = guideAudioCtx.currentTime;

  if (!result.found) {
    // Sem folha detectada: tom baixo e intermitente, sem direção
    guideGain.gain.setTargetAtTime(0.05, now, 0.1);
    guideOsc.frequency.setTargetAtTime(220, now, 0.1);
    if (guidePanner) guidePanner.pan.setTargetAtTime(0, now, 0.1);
    speakGuide('Não encontro a folha. Aponte a câmera para ela e melhore a iluminação.');
    return;
  }

  const dx = result.cx - 0.5; // negativo = folha à esquerda do quadro
  const dy = result.cy - 0.5;
  const centered = Math.abs(dx) < GUIDE_CENTER_MARGIN && Math.abs(dy) < GUIDE_CENTER_MARGIN;
  const distanceOk = result.coverage >= GUIDE_TARGET_COVERAGE_MIN && result.coverage <= GUIDE_TARGET_COVERAGE_MAX;

  // Balanço estéreo: acompanha o desvio horizontal da folha (-1 a 1)
  const pan = Math.max(-1, Math.min(1, dx * 2.2));
  if (guidePanner) guidePanner.pan.setTargetAtTime(pan, now, 0.08);

  // Frequência: mais alta quando a folha está próxima do enquadramento ideal
  // (perto do centro e da cobertura alvo); mais grave quando está longe.
  let freq = 300;
  if (result.coverage < GUIDE_TARGET_COVERAGE_MIN) {
    freq = 260; // folha pequena demais: precisa aproximar
  } else if (result.coverage > GUIDE_TARGET_COVERAGE_MAX) {
    freq = 340; // folha grande demais: precisa afastar
  } else {
    freq = 500;
  }
  if (centered && distanceOk) freq = 880; // tom agudo e estável = pronto para capturar
  guideOsc.frequency.setTargetAtTime(freq, now, 0.08);
  guideGain.gain.setTargetAtTime(centered && distanceOk ? 0.12 : 0.08, now, 0.08);

  // Feedback falado, só quando muda a situação principal
  if (centered && distanceOk) {
    speakGuide('Centralizado e na distância certa. Pode capturar.');
  } else if (!distanceOk && result.coverage < GUIDE_TARGET_COVERAGE_MIN) {
    speakGuide('Aproxime a câmera da folha.');
  } else if (!distanceOk && result.coverage > GUIDE_TARGET_COVERAGE_MAX) {
    speakGuide('Afaste um pouco a câmera.');
  } else if (Math.abs(dx) >= GUIDE_CENTER_MARGIN) {
    speakGuide(dx < 0 ? 'Mova a câmera um pouco para a esquerda.' : 'Mova a câmera um pouco para a direita.');
  } else if (Math.abs(dy) >= GUIDE_CENTER_MARGIN) {
    speakGuide(dy < 0 ? 'Mova a câmera um pouco para cima.' : 'Mova a câmera um pouco para baixo.');
  }
}

function startFramingGuide() {
  if (!framingGuideEnabled) return;
  stopFramingGuide();
  guideIntervalId = setInterval(analyzeFrameForGuide, 450);
}

function stopFramingGuide() {
  if (guideIntervalId) {
    clearInterval(guideIntervalId);
    guideIntervalId = null;
  }
  stopGuideAudio();
  guideLastPhrase = '';
}

function initGuideToggle() {
  if (!els.guideToggleBtn) return;
  updateGuideToggleLabel();
  els.guideToggleBtn.addEventListener('click', () => {
    framingGuideEnabled = !framingGuideEnabled;
    updateGuideToggleLabel();
    sounds.action();
    if (framingGuideEnabled && mediaStream) {
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

// -------------------------------------------------------------------------
// Registro do Service Worker (PWA instalável)
// -------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW falhou:', e));
  });
}

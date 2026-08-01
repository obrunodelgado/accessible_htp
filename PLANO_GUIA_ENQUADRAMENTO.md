# Plano de Desenvolvimento — Guia de Enquadramento da Folha (OpenCV.js + WebRTC)

> **STATUS DE EXECUÇÃO (atualizado em 2026-08-01):**
>
> Este plano foi a especificação original para as fases F0–F7. A execução real
> desviou em pontos importantes — o registro da verdade está em `BENCHMARK.md`.
>
> **F0 (baseline heurística)**: executado. Detector heurístico extraído para
> `js/framing/fallback-detector.js`. Medições de latência em `BENCHMARK.md`.
>
> **F1 (OpenCV.js + Worker)**: executado. Worker clássico com Otsu, canvas
> 160×120 com aspecto preservado, fallback heurístico, SW com cache-first
> para vendor/. A2/A3/A4/A5 não medidos em aparelho (pendente).
>
> **F2 (cascata + score geométrico)**: executado, mas **reprovado em
> especificidade**. Cascata Otsu→adaptive→Canny + CLAHE + score geométrico
> (área/aspecto/convexidade/centro). Gate em dataset balanceado 73:30:
> 69.9% acurácia, 98.6% sensibilidade, **0% especificidade** (30/30 FPs).
> Diagnóstico de textura/contraste descartado por medição — nenhum sinal
> separa folhas reais de falsos retângulos do fundo. A1 (≥85%) reprovado.
>
> **F3 (YOLOv8n — desvio do plano original)**: o pipeline OpenCV.js foi
> **substituído** por um modelo YOLOv8n (1 classe `paper_sheet`) via
> onnxruntime-web (WASM). Gate browser: **99% acurácia, 100% sensibilidade,
> 96.7% especificidade**, 63ms inference (Safari desktop). Modelo ONNX 12MB
> em `vendor/paper-yolov8n.onnx`, worker em `js/framing/yolo-worker.js`.
> OpenCV.js mantido como fallback (não como detector principal).
>
> **Mudanças de arquitetura vs plano**:
> - **Detector principal**: YOLOv8n (ONNX/WASM) em vez de OpenCV.js
> - **Feedback de áudio**: oscilador **removido** (buzz irritante para
>   usuário cego) — feedback só por voz, conforme feedback do usuário
> - **Histerese temporal**: 3 frames consecutivos antes de reportar found
>   (estabilizador simples, em vez de EMA + máquina de estados)
> - **Hápticos (F5)**: não implementado — `navigator.vibrate` tem suporte
>   irregular e o feedback por voz mostrou-se suficiente
> - **Pré-carregamento**: worker criado no construtor (modelo baixa ao
>   abrir a página, não ao clicar na câmera)
>
> **F4–F7**: não executados. F6 (otimização) parcialmente pendente.
> F8 (testes com usuários cegos) fora de escopo.

---

Documento de especificação para implementação por outro modelo/dev. Substitui o guia
heurístico atual (`analyzeFrameForGuide` / `detectSheetBounds` em `app.js`) por um
pipeline OpenCV.js robusto a fundo de baixo contraste, com feedback **auditivo** e
**tátil (vibração)**.

---

## 1. Contexto e estado atual

- Projeto: PWA em HTML/JS puro (`index.html`, `app.js`, `sw.js`, `manifest.json`), sem build step.
- Já existe: captura via `getUserMedia`, `speechSynthesis`, oscilador WebAudio com
  panning estéreo, loop de guia a 450 ms sobre um canvas de 96 px de largura.
- Ausente: detecção geométrica confiável (quadrilátero), robustez a fundo claro,
  vibração, histerese/estabilidade, medição de performance.

**Restrição transversal:** aparelhos Android de baixo custo (2–3 GB RAM, CPU ARM
quad-core lenta, sem WebGL confiável). Todo o desenho de solução é subordinado a isso.

---

## 2. Objetivo

Guiar uma pessoa cega a posicionar a câmera de forma que a folha de papel fique
**centralizada**, **completa no quadro** e **na distância certa**, informando de forma
contínua e não ambígua:

1. se a folha foi encontrada;
2. em que direção mover (esquerda/direita/cima/baixo);
3. aproximar ou afastar;
4. quando está pronto para capturar.

### Critérios de aceite

| # | Critério | Meta |
|---|---|---|
| A1 | Detecção correta da folha em fundo de médio/baixo contraste (mesa clara, papel branco) | ≥ 85% dos frames em teste |
| A2 | Latência do ciclo detecção→feedback | ≤ 150 ms por frame processado |
| A3 | Taxa de processamento | 5–8 fps em aparelho de referência (Moto E / Redmi 9A) |
| A4 | Pico de memória JS heap adicional | < 40 MB acima da baseline |
| A5 | Falsos "pronto para capturar" | < 2% dos frames em condição não ideal |
| A6 | Tempo até enquadrar (usuário cego, 5 tentativas) | mediana ≤ 20 s |
| A7 | App continua utilizável se OpenCV.js falhar ao carregar | fallback heurístico atual ativo |

---

## 3. Arquitetura

```
MediaStream (WebRTC/getUserMedia, facingMode: environment)
        │
        ▼
 <video> (não exibido em tamanho cheio; apenas fonte)
        │  grab a cada N ms (throttle adaptativo)
        ▼
 OffscreenCanvas 160×120  ──► ImageData (RGBA)
        │
        ▼
 ┌─────────────────── Worker (frame-worker.js) ───────────────────┐
 │  OpenCV.js (WASM, build reduzido)                              │
 │  cvtColor GRAY → GaussianBlur 3×3 → threshold OTSU             │
 │  → morphologyEx CLOSE → findContours → approxPolyDP            │
 │  → seleção do melhor quadrilátero → métricas                   │
 └────────────────────────────────────────────────────────────────┘
        │  postMessage({found, cx, cy, coverage, aspect, conf})
        ▼
 FeedbackController (thread principal)
   ├── Estabilizador (EMA + histerese + máquina de estados)
   ├── AudioFeedback   (oscilador contínuo + panning + TTS)
   └── HapticFeedback  (navigator.vibrate, padrões distintos)
```

Separar em Worker é o ponto crítico de performance: mantém a UI e a fala sem travamento
em CPU fraca. Se `Worker` + WASM não estiver disponível, cair para execução síncrona no
main thread com resolução ainda menor (120×90) e intervalo maior (500 ms).

---

## 4. Pipeline de visão (detalhado)

### 4.1 Aquisição
- `getUserMedia({ video: { facingMode: 'environment', width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 15} } })`.
  Pedir resolução **baixa** para o preview de guia; a captura final para análise usa
  o stream em alta apenas no momento da foto (constraints separadas ou `track.applyConstraints`).
- Reaproveitar um único `OffscreenCanvas` e um único `ctx` com `willReadFrequently: true`.
  Nunca recriar canvas por frame.

### 4.2 Pré-processamento
1. `cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)`.
2. `cv.GaussianBlur(gray, blur, new cv.Size(3,3), 0)` — kernel 3×3 basta nessa resolução.
3. **Equalização condicional**: se o desvio-padrão do cinza (`cv.meanStdDev`) < 18,
   aplicar `cv.createCLAHE(2.0, new cv.Size(8,8))`. Isso resolve o caso de fundo
   com pouco contraste (papel branco em mesa branca). CLAHE só quando necessário,
   pois custa CPU.

### 4.3 Binarização — estratégia em cascata
1. **Otsu (primário):**
   `cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)`.
   Guardar o valor de limiar retornado. Se o limiar ficar em faixa extrema
   (< 40 ou > 215) ou a separabilidade for baixa, considerar Otsu não confiável.
2. **Adaptive (fallback para contraste muito baixo):**
   `cv.adaptiveThreshold(blur, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 5)`.
3. **Canny + dilate (fallback geométrico):** quando nenhum dos dois produz contorno
   quadrilátero válido — `cv.Canny(blur, edges, 50, 150)` seguido de `cv.dilate` 3×3,
   pois a borda da folha (sombra fina) sobrevive mesmo sem diferença de brilho.

Ordem de tentativa por frame: usar a estratégia que funcionou no frame anterior
(cache do modo); só reavaliar a cascata a cada ~10 frames ou quando falhar.
Isso evita rodar três pipelines por frame.

### 4.4 Morfologia e contornos
- `cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel5x5)` para fechar falhas na borda.
- `cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)`.
- Para cada contorno com `cv.contourArea` ≥ 8% da área do frame:
  - `peri = cv.arcLength(c, true)`; `cv.approxPolyDP(c, approx, 0.02*peri, true)`.
  - Aceitar se `approx.rows === 4` **e** convexo (`cv.isContourConvex`).
  - Se nenhum quadrilátero: usar `cv.minAreaRect` do maior contorno como aproximação
    (folha parcialmente cortada pelo quadro).

### 4.5 Score do candidato
```
score = 0.40*areaNorm + 0.25*aspectScore + 0.20*convexityScore + 0.15*centerBias
```
- `areaNorm` = área/áreaFrame, saturado em 0.85;
- `aspectScore` = proximidade da razão A4 (1.414) ou seu inverso, tolerância ±25%;
- `convexityScore` = área do contorno / área do hull;
- `centerBias` = 1 − distância normalizada do centroide ao centro.

Escolher o de maior score; exigir `score ≥ 0.45` para declarar `found = true`.

### 4.6 Métricas emitidas
`{ found, cx, cy (0..1), coverage (0..1), aspect, tilt (graus), confidence, mode }`

---

## 5. Estabilização (anti-oscilação)

Feedback que muda a cada frame é inutilizável por uma pessoa cega. Obrigatório:

- **EMA** sobre `cx`, `cy`, `coverage` com α = 0.35.
- **Histerese** nos limites: entra em "centralizado" com |dx| < 0.08, só sai com |dx| > 0.13.
- **Debounce de estado:** um novo estado só é anunciado após persistir por ≥ 3 frames.
- **Máquina de estados:**
  `SEM_FOLHA → PARCIAL → AJUSTE_LATERAL → AJUSTE_VERTICAL → AJUSTE_DISTANCIA → PRONTO`
  com prioridade: distância grosseira primeiro, depois eixo com maior desvio.
- Anunciar **um eixo por vez**. Nunca "mova para a esquerda e para cima".

---

## 6. Feedback

### 6.1 Auditivo — duas camadas

**Camada contínua (tom):** já existe base no `app.js`, manter e refinar.
- Frequência codifica distância: 250 Hz (muito longe) → 500 Hz (faixa boa) → 880 Hz (pronto).
- Pan estéreo codifica desvio horizontal (`StereoPannerNode`, −1..1).
- Taxa de pulsação codifica desvio vertical: pulsos lentos (2 Hz) longe, contínuo quando alinhado.
- Silêncio + bip curto duplo quando entra em PRONTO.

**Camada falada (TTS):** curta, imperativa, com cooldown de 2 s e supressão de repetição.
Frases padronizadas (máx. 5 palavras): "Para a esquerda", "Para a direita", "Para cima",
"Para baixo", "Aproxime", "Afaste", "Pronto, pode capturar", "Folha não encontrada".

### 6.2 Tátil — `navigator.vibrate`

Vocabulário de padrões (documentar no README e num tutorial de voz na primeira execução):

| Estado | Padrão (ms) | Repetição |
|---|---|---|
| Folha não encontrada | `[400]` | a cada 1500 ms |
| Mover à esquerda | `[80, 120, 80]` (duplo curto) | a cada 700 ms |
| Mover à direita | `[250]` (um longo) | a cada 700 ms |
| Mover para cima | `[80, 80, 80, 80, 80]` (tremido) | a cada 800 ms |
| Mover para baixo | `[300, 100, 300]` | a cada 800 ms |
| Aproximar | pulsos acelerando conforme aproxima | contínuo |
| Afastar | pulsos desacelerando | contínuo |
| **PRONTO** | `[60,60,60,60,60]` seguido de silêncio | uma vez |

Regras:
- `navigator.vibrate` não existe no iOS Safari — detectar (`'vibrate' in navigator`) e,
  se ausente, reforçar a camada auditiva (não deixar o usuário sem sinal).
- Chamar `vibrate` no máximo a cada 500 ms; sempre `vibrate(0)` antes de trocar padrão.
- Requer gesto do usuário prévio na página (o botão "iniciar câmera" já serve).
- Botão de configuração para desligar vibração ou som independentemente.

---

## 7. Otimização para aparelhos de baixo custo

Requisitos não negociáveis:

1. **Resolução de trabalho 160×120** (não a resolução do vídeo). Detecção de folha
   não precisa de mais; o custo cai ~16× vs 640×480.
2. **Zero alocação no loop.** Alocar `cv.Mat` uma única vez fora do loop e reutilizar
   (`src`, `gray`, `blur`, `bin`, `hierarchy`, kernel). `contours` é `MatVector` —
   reutilizar e chamar `.delete()` disciplinadamente. **Vazamento de Mat é o bug número 1
   de OpenCV.js**: adicionar um contador de Mats em modo debug (`cv.Mat` count).
3. **Throttle adaptativo:** medir o tempo do último frame; se > 120 ms, aumentar o
   intervalo (450 → 700 ms) e/ou baixar para 120×90. Se < 40 ms, permitir 300 ms.
4. **Build reduzido do OpenCV.js:** compilar apenas os módulos `core` + `imgproc`
   (excluir `objdetect`, `dnn`, `features2d`, `video`, `photo`, `calib3d`).
   Alvo: **< 1.5 MB WASM** (o build padrão passa de 8 MB). Se recompilar não for viável,
   usar `opencv.js` oficial mas servir com `Content-Encoding: br/gzip` e cachear no
   Service Worker.
5. **Carregamento assíncrono e não bloqueante:** o app abre e funciona com o detector
   heurístico atual; OpenCV.js carrega em segundo plano e o app anuncia por voz
   "modo de precisão ativado" quando pronto.
6. **Cache no `sw.js`:** adicionar `opencv.js` e `opencv_wasm` ao precache com
   versionamento explícito; o download pesado acontece uma única vez.
7. **Pausar tudo** em `visibilitychange` (aba oculta), quando o dispositivo entra em
   economia de bateria, e após 60 s sem mudança significativa de frame.
8. **Sem WebGL / sem TFJS / sem dependências extras.** Só OpenCV.js.
9. `requestVideoFrameCallback` quando disponível, com fallback para `setTimeout`
   (evitar `setInterval`, que enfileira sob carga).

---

## 8. Estrutura de arquivos proposta

```
index.html                 (adicionar: toggles de som/vibração, região aria-live)
app.js                     (remover detectSheetBounds; integrar FramingGuide)
js/framing/frame-worker.js (Worker: OpenCV.js + pipeline)
js/framing/guide.js        (FramingGuide: loop, throttle, ciclo de vida)
js/framing/stabilizer.js   (EMA, histerese, máquina de estados)
js/framing/audio.js        (oscilador, pan, pulsação, TTS com cooldown)
js/framing/haptics.js      (padrões de vibração)
vendor/opencv.js           (build reduzido) + opencv.wasm
sw.js                      (precache versionado dos assets do OpenCV)
```

Sem bundler — módulos ES nativos (`<script type="module">`), coerente com o projeto atual.

### Contrato do Worker

```js
// main → worker
{ type: 'init' }
{ type: 'frame', width, height, buffer /* ArrayBuffer transferível */ }
{ type: 'config', targetCoverage: [0.35, 0.80] }

// worker → main
{ type: 'ready' }
{ type: 'result', found, cx, cy, coverage, aspect, tilt, confidence, mode, ms }
{ type: 'error', message }
```
Usar **Transferable** (`postMessage(msg, [buffer])`) para o ImageData — sem cópia.

---

## 9. Fases de implementação

| Fase | Entrega | Critério de saída |
|---|---|---|
| **F0** | Instrumentação: medir fps, tempo/frame, heap no dispositivo alvo com o código atual | baseline registrada |
| **F1** | Integrar OpenCV.js (build reduzido) + Worker; pipeline Otsu; log das métricas na tela | detecção funcional a ≥ 5 fps |
| **F2** | Cascata de binarização (CLAHE / adaptive / Canny) + score de candidatos | A1 atingido no dataset de teste |
| **F3** | Estabilizador + máquina de estados | sem oscilação de anúncio em vídeo de teste |
| **F4** | Áudio refinado (pan, pulsação, cooldown de TTS) | A5 atingido |
| **F5** | Vibração + tutorial de padrões + toggles de acessibilidade | padrões distinguíveis em teste com usuário |
| **F6** | Otimização: throttle adaptativo, precache SW, auditoria de vazamento de Mat | A2, A3, A4 atingidos |
| **F7** | Fallback e degradação (sem Worker, sem WASM, sem vibração, iOS) | A7 atingido |
| **F8** | Testes com usuários cegos e ajuste de vocabulário | A6 atingido |

---

## 10. Estratégia de testes

**Dataset:** gravar 20–30 clipes curtos (5 s, 480p) cobrindo:
papel branco sobre mesa branca / madeira clara / madeira escura / toalha estampada;
luz de teto amarela, luz natural, contraluz, sombra da própria mão;
folha inclinada 0°/15°/30°, parcialmente fora do quadro, dois papéis na cena,
folha com desenho denso vs quase em branco.

**Testes automatizados (Node + opencv4nodejs ou headless):**
- Rodar o pipeline sobre frames anotados; medir precisão de `found` e erro de centro (px).
- Teste de vazamento: 1000 iterações, verificar contagem de Mats constante.
- Teste do estabilizador com séries sintéticas: nenhum estado deve alternar > 1×/s.

**Testes manuais obrigatórios:**
- Aparelho Android de entrada real (não emulador): fps, aquecimento, bateria em 5 min de uso.
- Teste com TalkBack ativo — verificar que o TTS do app não conflita com o leitor de tela
  (usar `aria-live="polite"` com moderação; a fala do guia deve ser via `speechSynthesis`,
  e a UI não deve disparar anúncios duplicados).
- Teste com ao menos 2 usuários cegos, cronometrando o tempo até enquadrar.

---

## 11. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| WASM de 8 MB inviável em 3G | Build reduzido + precache SW + app funcional sem ele |
| Vazamento de `cv.Mat` derruba a aba | Mats pré-alocados, contador em debug, teste de 1000 iterações |
| Otsu falha em fundo homogêneo | Cascata CLAHE → adaptive → Canny |
| Vibração indisponível no iOS | Detecção de recurso + reforço auditivo |
| Feedback simultâneo som+voz+vibração satura o usuário | Prioridade: tom contínuo sempre; voz só em mudança de estado; vibração só direção |
| TTS conflita com TalkBack | Cooldown, frases curtas, opção de desligar voz e usar só tom+vibração |
| Superaquecimento/bateria | Throttle adaptativo, pausa em inatividade e aba oculta |

---

## 12. Definição de pronto

- Todos os critérios A1–A7 verificados em aparelho de referência.
- Nenhum vazamento de memória em sessão de 10 minutos.
- App funcional (modo degradado) sem OpenCV.js, sem Worker e sem vibração.
- Documentação dos padrões de vibração e do vocabulário falado no README.
- Tutorial de áudio na primeira execução explicando os sinais.

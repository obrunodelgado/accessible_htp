---
agent: devin-local
session: basalt-speech
created: 2026-07-31T16:55:35Z
revised: 2026-07-31 (rev. 3 — verificada contra o código real de app.js / sw.js / index.html)
---
# Guia de Enquadramento — OpenCV.js + WebRTC

Substituir o detector heurístico de folha em `app.js` por um pipeline OpenCV.js em Web Worker, com feedback auditivo refinado, vibração, estabilização anti-oscilação e degradação graciosa — cobrindo as fases F0–F7 do `PLANO_GUIA_ENQUADRAMENTO.md`.

> **Mudanças desta revisão** (rev. 3, após conferir o código-fonte linha a linha):
> 1. **Canvas 160×120 fixo estava errado** — distorce a imagem e invalida o `aspectScore`. Passa a ser 160×round(160·vh/vw), preservando o aspecto (como o código atual já faz com 96 px).
> 2. **O "bug do AudioContext" foi rebaixado de fato para hipótese** — sticky activation torna provável que o contexto já esteja `running` em Chrome/Android. Vira um passo de *verificação* em F0, não uma premissa que reorganiza F1.
> 3. **`sw.js` já contém `index.html`, `app.js` e `manifest.json` no `addAll`** — a revisão anterior mandava adicioná-los. Faltam só os ícones e os módulos novos.
> 4. **Colisão de nomes A3/A4 resolvida**: A3 no spec-mãe é *fps*, não latência. A latência ponta-a-ponta vira **A8** (novo critério), e "A4" como formato de papel passa a ser "ISO A4" para não colidir com o critério A4 (memória).
> 5. **A6 marcado explicitamente como não verificável neste escopo** (exige usuários cegos; F8 está fora).
> 6. **Faixa de cobertura alvo unificada** — o código usa 0.30–0.65; o contrato do worker usava 0.35–0.80 sem justificativa.
> 7. Seção de riscos deduplicada (era repetição literal das decisões).

## Decisões confirmadas

- **OpenCV.js**: build oficial (~8 MB) em `vendor/opencv-<versão>.js` (path versionado para cache-first imutável — **verificar a versão atual no momento do download**, não assumir 4.10.0), gzip/brotli negociado pelo servidor (GitHub Pages/Netlify/Vercel já fazem para `.js`; nada a implementar no app), **rota cache-first dedicada no SW para `vendor/`**, carregamento **não-bloqueante** (app abre com `FallbackDetector`; OpenCV entra em segundo plano e anuncia "modo de precisão ativado"). Fallback permanente se falhar/timeout (~20 s). Build customizado (core+imgproc) fica como item de F6 com gate objetivo medido em F1: só se o tempo até "modo de precisão ativado" em 3G no aparelho de referência exceder 45 s.
- **Worker**: **clássico** (`new Worker(new URL('./frame-worker.js', import.meta.url))` sem `{type:'module'}`) — `importScripts` não existe em module workers. `importScripts` resolve contra `self.location` (URL do próprio worker), então de `js/framing/frame-worker.js` o caminho é `../../vendor/opencv-<versão>.js` (dois níveis). **Sem pool de buffers** — `getImageData` devolve um `ImageData` cujo `.data.buffer` é um `ArrayBuffer` fresco e transferível; transferir diretamente (`postMessage(msg, [img.data.buffer])`). Uma cópia (a transferência evita a cópia main→worker, mas `src.data.set(...)` copia ~76 KB para o heap WASM em todo frame — irrelevante em performance, mas "zero cópia" seria retórica falsa). Backpressure é um booleano `inFlight` — se true, descartar o frame. O worker **não devolve o buffer** — ele morre e o próximo `getImageData` cria outro.
- **Canvas de análise com aspecto preservado**: `w = 160`, `h = max(1, round(160 * video.videoHeight / video.videoWidth))` — **não 160×120 fixo**. Com `getUserMedia` pedindo 1280×1280 (ver `startCamera`), o frame real costuma sair 4:3 ou 16:9 dependendo do aparelho; forçar 120 de altura distorce a imagem e faz o `aspectScore` (proximidade de 1,414) medir a razão errada. O código atual já acerta isso com 96 px de largura. Em modo degradado, `w = 120` com a mesma regra.
- **Resolução variável**: cada `getImageData` cria um buffer do tamanho certo; `width`/`height` vão na mensagem; o worker realoca Mats quando `width`/`height` mudam em relação ao frame anterior. **Sem mensagem `{type:'resize'}` coordenada**, sem drenagem, sem throttle de resize.
- **Faixa de cobertura alvo = 0.30–0.65** (mesma do código atual, `GUIDE_TARGET_COVERAGE_MIN/MAX`). Manter até que o harness de F0 mostre outra coisa; qualquer mudança precisa de justificativa medida, não de chute no contrato do worker.
- **A8 (novo) = latência ponta-a-ponta movimento→frase, derivada de tabela de orçamento**: fps (A3 do spec-mãe) é proxy ruim para a experiência; o que importa é o tempo entre o movimento da câmera e a frase de correção. Um número fixo (≤800 ms) é inatingível por aritmética: intervalo 450 ms + `ms` do worker ~120 + debounce 400 + latência de início do `speechSynthesis` no Android (~150–300) = 1120–1270 ms em modo normal; ~1500 ms em degradado. Em vez de chutar, **F0 mede os termos reais** (intervalo, `ms` do worker/fallback, latência de `speechSynthesis`) e **A8 é derivado da soma** em `BENCHMARK.md`. Provavelmente ~1200 ms normal / ~1600 ms degradado — defensável e, mais importante, verdadeiro. Implica: debounce **temporal (400 ms), não em frames**; EMA com **α em função do intervalo** (`α = 1 - exp(-interval/τ)` com τ≈300 ms), não fixo. Se o modo degradado estoura o orçamento derivado, é falha silenciosa — o throttle respeita a latência, não só o `ms` do worker. **A3 permanece como está no spec-mãe (5–8 fps)** para não quebrar referências cruzadas.
- **Cooldown de TTS suprime frase idêntica, não bloqueia mudança de estado**: o `speakGuide` atual já faz a coisa certa — exige `text === guideLastPhrase` **e** `now - guideLastSpokenAt < 2200`, ou seja, só suprime repetição idêntica dentro da janela. O cooldown **não é um gate global sobre novas falas** — uma mudança de estado fala imediatamente. Preservar esse comportamento; um gate global estouraria A8 por design.
- **Escopo**: F0–F7. F8 (testes com usuários) fica fora — exige usuários cegos. **Consequência: A6 (tempo até enquadrar, mediana ≤ 20 s) não é verificável neste escopo** e deve ficar marcado como pendente em `BENCHMARK.md`, não aprovado por proxy.
- **Fontes intercambiáveis desde F1**: o detector heurístico **nunca é removido** — vira `js/framing/fallback-detector.js` (extraído em F0) com a mesma interface de saída do worker. `FramingGuide` tem duas fontes desde o primeiro commit; estabilizador, áudio e hápticos são agnósticos à fonte. F7 fica quase trivial.
- **WASM assíncrono**: aguardar `cv.onRuntimeInitialized` (ou `cv` como Promise em builds recentes) antes de emitir `ready` e pré-alocar Mats. Frames que cheguem antes são descartados (buffer não é enviado; `inFlight` fica false).
- **tilt**: mantido no contrato mas **não consumido no feedback** nesta versão (folha inclinada ainda é legível pelo Gemini; um sexto sinal saturaria o usuário).
- **Sem `navigator.getBattery()`**: removido no Firefox, nunca existiu no Safari, irregular no Chrome. Economia via proxy já instrumentado: se `ms` do worker subir consistentemente (throttling térmico), aumentar intervalo.
- **Direção = movimento da câmera**: frases fixas como "Câmera para a esquerda" (referencial explícito). Tratamento de `screen.orientation` — em landscape os eixos trocam. **Nota**: o código atual já diz "Mova a câmera…", então isso é refinamento de fraseado, não correção de semântica.
- **Voz pt-BR**: carregar via evento `voiceschanged` (Android retorna vazio no primeiro `getVoices()`); fallback para voz padrão. O código atual só seta `utter.lang = 'pt-BR'` e não escolhe voz — aceitável, mas em aparelhos sem voz pt-BR instalada a fala sai com fonética errada.
- **AudioContext e user activation — hipótese a verificar, não fato**: `ensureGuideAudio()` é chamado dentro de `analyzeFrameForGuide()` (callback de `setInterval`), fora do gesto do usuário. Isso *pode* nascer `suspended`, e não há `resume()` em lugar nenhum. Mas: (a) o guia só inicia depois de um clique em `captureBtn` → `startCamera()`, e Chrome usa **sticky activation** (uma interação qualquer no documento basta, não precisa ser a tarefa do gesto); (b) `beep()` já cria e fecha `AudioContext`s a cada clique. Logo, em Chrome/Android — o alvo — o contexto provavelmente está `running` e o guia **não** está mudo. O risco real é iOS Safari e políticas mais estritas. **F0 passo 6b verifica `guideAudioCtx.state` em aparelho real antes de qualquer refatoração.** Independentemente do resultado, a correção defensiva é barata e entra em F1: criar/resumir o contexto **sincronamente** no handler de `captureBtn`/`guideToggleBtn`, com `resume()` explícito. O `createStereoPanner` tem fallback em `ensureGuideAudio` (verificar a função, não a linha — referências de linha envelhecem) — preservar na migração (Safari antigo não tem).
- **TTS com fila/prioridade compartilhada**: `speak()` do `app.js` chama `speechSynthesis.cancel()` quando `interrupt: true`, e `setStatus()` chama `speak()` com o default (`interrupt: true`) — qualquer mudança de status durante o guia mata a frase de direção no meio. Hoje o guia usa `interrupt: false`, o que atenua num sentido só. **`js/speech.js`** (módulo separado, consumido por `app.js` e `audio.js` — não dentro de `audio.js`, para não inverter dependência: o fluxo principal do app não deve depender do módulo de enquadramento) implementa uma fila/prioridade compartilhada: status do app > direção do guia > tom contínuo. `app.js` passa a usar o `SpeechQueue` em vez de `speechSynthesis` direto. **`js/speech.js` + `audio.js` mínimo entram em F1** (tom + TTS, sem pulsação/pan/orientação) para que o guia não fique mudo entre F1 e F3; o `audio.js` completo é refinado em F4.
- **Canvas**: reutilizar `<canvas id="guideCanvas" class="visually-hidden">` já existente no `index.html` — não criar um novo.

## Resumo da arquitetura

```
<video> → guideCanvas (existente; 160×round(160·vh/vw), willReadFrequently) → getImageData
   → postMessage({type:'frame', width, height, buffer: img.data.buffer}, [img.data.buffer])
        (transfere o ArrayBuffer fresco; uma cópia para o heap WASM via src.data.set)
   → frame-worker.js (OpenCV.js WASM, worker clássico, importScripts ../../vendor/opencv-<versão>.js)
        realoca Mats quando width/height mudam vs frame anterior
   → { found, cx, cy, coverage, aspect, tilt, touchesEdge, confidence, mode, ms, wasmHeap }
        (sem buffer de volta — não há pool)
   → FramingGuide (main thread, inFlight = false ao receber)
       ├── Source: Worker OU FallbackDetector (intercambiáveis, mesma interface)
       ├── Stabilizer (EMA + histerese + máquina de estados com PARCIAL por touchesEdge)
       ├── AudioFeedback (oscilador contínuo + pan + pulsação + TTS via SpeechQueue)
       └── HapticFeedback (navigator.vibrate, padrões por estado)
```

## Estrutura de arquivos

```
index.html                       (checkboxes de som/vibração em <details>, região aria-live, script type=module)
app.js                           (remover pipeline heurístico inline; integrar FramingGuide via import)
js/framing/fallback-detector.js  (detectSheetBounds reescrito com interface {found,cx,cy,coverage,...})
js/framing/frame-worker.js       (Worker clássico: importScripts ../../vendor/opencv-<versão>.js, pipeline, cascata, score)
js/framing/guide.js              (FramingGuide: loop, inFlight backpressure, throttle temporal, ciclo de vida, troca de fonte)
js/framing/stabilizer.js         (EMA com α=1-exp(-interval/τ), histerese, debounce temporal 400ms, máquina de estados com PARCIAL)
js/framing/audio.js              (oscilador contínuo, StereoPanner com fallback, pulsação, TTS, voiceschanged; consome js/speech.js)
js/speech.js                     (SpeechQueue com prioridade compartilhada; consumido por app.js e audio.js)
js/framing/haptics.js            (padrões de vibração por estado, throttle 500ms, feature detect)
js/framing/test-harness.js       (playback de fotos/vídeos + comparação com ground truth para A1/A5)
vendor/opencv-<versão>.js        (build oficial, path versionado)
sw.js                            (rota cache-first para vendor/opencv-*.js; ASSETS += ícones e módulos novos)
BENCHMARK.md                     (baseline de F0 + gates de F1 + medições de F6)
dataset/stills/ + dataset/clips/ (fotos estáticas p/ A1 + clipes p/ A5 + anotações JSON; fora do repo)
```

`app.js` e `js/framing/*.js` (exceto worker) usam módulos ES nativos (`<script type="module">`). O **worker é clássico** (`importScripts`) — sem bundler.

> **Nota sobre `type="module"`**: módulos são `defer` por padrão. O `app.js` atual roda `initApiKeyUI()` etc. no fim do arquivo com `<script src="app.js">` **sem** `defer` — hoje funciona porque a tag está no fim do `<body>`. Com `type="module"` continua funcionando (o DOM já está pronto); nenhuma reordenação é necessária, mas confirmar que nenhum `els.*` é `null` no console após a migração.

## Contrato do Worker (sem pool, sem resize coordenado)

```js
// main → worker
{ type: 'init' }
{ type: 'frame', width, height, buffer }      // buffer = img.data.buffer do getImageData, transferido (fresco)
{ type: 'config', targetCoverage: [0.30, 0.65] }

// worker → main
{ type: 'ready' }                             // só após cv.onRuntimeInitialized
{ type: 'result', found, cx, cy, coverage, aspect, tilt, touchesEdge,
  confidence, mode, ms, wasmHeap }            // sem buffer de volta — não há pool
{ type: 'error', message }                    // sem buffer
```

**Backpressure**: `guide.js` mantém um booleano `inFlight`. Antes de `getImageData`+`postMessage`, se `inFlight === true`, **descartar o frame**. Ao receber `result`/`error`, `inFlight = false`.

**Throttle temporal**: tanto no ramo `requestVideoFrameCallback` quanto no `setTimeout`, gate explícito: `if (now - lastFrameTime < interval) return schedule()`. `rVFC` dispara a ~30 fps — sem o gate, o throttle de 450 ms só existiria no ramo `setTimeout`.

**Resize implícito**: cada frame traz `width`/`height`. O worker compara com o frame anterior; se mudaram, deleta e realoca os Mats no novo tamanho.

**Frames antes de `ready`**: worker responde `{type:'error', message:'not-ready'}`. `inFlight` volta a false.

**wasmHeap**: worker reporta `cv.HEAPU8.buffer.byteLength` em cada `result` — a memória do OpenCV vive num ArrayBuffer fora do heap JS e domina o critério A4.

## Implementation Steps

### Pré-F0 — Rollback safety
0. Criar branch dedicada (`framing-opencv`) e tag `pre-framing` no commit atual. F1 remove do `app.js`: as seis funções (`analyzeFrameForGuide`, `ensureGuideAudio`, `stopGuideAudio`, `speakGuide`, `startFramingGuide`, `stopFramingGuide`), mais `initGuideToggle`, `updateGuideToggleLabel`, as variáveis de estado (`framingGuideEnabled`, `guideAudioCtx`, `guideOsc`, `guideGain`, `guidePanner`, `guideIntervalId`, `guideLastSpokenAt`, `guideLastPhrase`), as constantes (`GUIDE_TARGET_COVERAGE_MIN/MAX`, `GUIDE_CENTER_MARGIN`) e os dois call sites em `startCamera`/`stopCamera`. `detectSheetBounds` já terá sido extraída em F0. Ter ponto de retorno limpo.

### F0 — Extrair fallback-detector + dataset + harness + baseline
1. **Extrair `js/framing/fallback-detector.js`** (refactor puro, sem mudança de comportamento): mover `detectSheetBounds` de `app.js` para o módulo, reescrevendo a saída para a interface `{ found, cx, cy, coverage, aspect, tilt, touchesEdge, confidence, mode:'heuristic', ms, wasmHeap:0 }`. Mapeamento: `found = bounds !== null`, `cx = centerX`, `cy = centerY`, `aspect = (maxX-minX)/(maxY-minY)`, `tilt = 0` (o heurístico não mede inclinação), `confidence` derivado de `coverage`. `touchesEdge`: bounding box encosta em ≤2 px de qualquer borda. Exportar `detect(imageData, width, height)`. `app.js` passa a importar e chamar o módulo no lugar da função inline.
2. **Dataset dividido em duas partes** (começar pequeno — ver passo 8):
   - **`dataset/stills/` (para A1)**: fotos estáticas anotadas com 4 cliques cada (bbox), cobrindo a matriz de condições (papel branco sobre mesa branca/madeira clara/escura/toalha; luz amarela/natural/contraluz/sombra; folha 0°/15°/30°; parcialmente fora do quadro; dois papéis; desenho denso vs vazio). A1 é métrica por-frame — não precisa de vídeo.
   - **`dataset/clips/` (para A5)**: 6–8 clipes curtos de vídeo, anotados por-frame. A5 é temporal (falsos PRONTO) e precisa da cadeia detector→estabilizador. A ferramenta de anotação de keyframes+interpolação só se aplica aqui.
3. **Formato de anotação (ground truth)**: JSON por imagem/clipe em `dataset/annotations/`. Por-frame: `{ frame, found: bool, bbox: [minX, minY, maxX, maxY] (normalizado 0..1), touchesEdge: bool }`. Para stills, uma entrada por foto.
4. **Criar `js/framing/test-harness.js`**: playback de stills (via `<img>` + `drawImage`) e clipes (via `<video src>` + `drawImage`) no lugar de `getUserMedia`; chama `detect()` importado de `fallback-detector.js`; compara `found`/`bbox`/`touchesEdge` com a ground truth; reporta precisão de `found` e erro de centro (px). Aceita `detect` injetado — em F1 troca para o worker, em F3 encadeia detector→estabilizador para A5. **A página do harness não registra o SW** (ou chama `navigator.serviceWorker.unregister()` no topo) — `?nocache` não faz bypass do SW (o fetch handler intercepta tudo e faz `cache.put` em toda resposta; query string só muda a chave do cache). Não registrar o SW é mais simples e nada no `sw.js` precisa mudar.
5. **`dataset/` fora do repo**: adicionar `dataset/` ao `.gitignore` (50–150 MB num projeto de 30 KB). **Sem early-return no `sw.js`** — o dataset é gitignored e nunca deployado; early-return seria código morto em produção.
6. **Instrumentação no `fallback-detector.js`** (definitiva): medir `ms` por frame, fps efetivo. A4 baseline: `performance.memory.usedJSHeapSize` tirado **antes do `start()`**; delta medido 60 s depois. **Nota**: `performance.memory` é não-padrão, só Chrome, granularidade reduzida sem headers de isolamento — registrar em `BENCHMARK.md` que A4 é medível só em Chrome. **Tabela de orçamento de latência para A8**: medir os termos reais — intervalo do loop (450 ms), `ms` do detector, latência de início do `speechSynthesis` no Android (`performance.now()` antes de `speak()` e dentro de `utterance.onstart`). Somar e registrar em `BENCHMARK.md`; A8 é derivado da soma, não chute.
6b. **Verificar a hipótese do AudioContext** (5 minutos, antes de qualquer refatoração de áudio): em aparelho Android real, com o guia rodando, logar `guideAudioCtx.state` e `guideGain.gain.value`. Se `running`, o guia nunca esteve mudo e o item vira endurecimento defensivo; se `suspended`, é bug confirmado e vira correção prioritária. Repetir em iOS Safari se houver aparelho. Registrar o resultado em `BENCHMARK.md` — a prioridade dentro de F1 depende disso.
7. Registrar baseline com `fallback-detector` sobre o dataset: fps, ms/frame, heap, taxa de `found` correta vs ground truth. Em aparelho de referência se disponível (senão, desktop Chrome com throttling de CPU 4×).
8. **F0 entrega 40–50 fotos primeiro** (não 150–200). Medir baseline. Só expandir o dataset se o gate de Otsu de F1 ficar na zona cinzenta (80–88%). Se Otsu passar folgado, as outras fotos nunca precisaram existir — mesmo argumento que o plano já usa para adiar a cascata. Saída: tabela de baseline em `BENCHMARK.md`.

### F1 — Integração OpenCV.js + Worker + pipeline Otsu + fonte intercambiável
9. Baixar `opencv.js` oficial para `vendor/opencv-<versão>.js` (**verificar a versão atual no momento do download** — não assumir 4.10.0; path versionado para cache-first imutável).
10. Criar `js/framing/frame-worker.js` (worker **clássico**):
    - `importScripts('../../vendor/opencv-<versão>.js')` — **dois níveis** (resolve contra `self.location`, a URL do worker em `js/framing/`).
    - Aguardar `cv.onRuntimeInitialized` (callback) ou `cv` como Promise (`if (cv instanceof Promise) cv = await cv`). Só então emitir `{type:'ready'}` e pré-alocar Mats.
    - **Pré-alocar `cv.Mat` fora do loop**: `src`, `gray`, `blur`, `bin`, `hierarchy`, `kernel5x5`, `kernel3x3`, `contours` (MatVector), **`clahe` (`cv.createCLAHE`)** — CLAHE aloca por frame se não for pré-alocado. Contador de Mats em debug.
    - **Vazamento explícito**: `contours` é `MatVector` — precisa `.delete()`; os Mats individuais de `contours.get(i)` **também vazam** se não deletados. Comentar isso no código; deletar cada `Mat` retornado por `.get(i)` após uso.
    - **Resize implícito**: ao receber `{type:'frame', width, height}`, comparar com o frame anterior; se mudaram, deletar e realocar `src`/`gray`/`blur`/`bin` no novo tamanho.
    - Pipeline: `cvtColor RGBA→GRAY` → `GaussianBlur 3×3` → `threshold OTSU` → `morphologyEx CLOSE 5×5` → `findContours RETR_EXTERNAL` → `approxPolyDP 0.02*peri` → selecionar quadrilátero convexo de maior `contourArea`.
    - Emitir `{ found, cx, cy, coverage, aspect, tilt, touchesEdge, confidence, mode:'otsu', ms, wasmHeap: cv.HEAPU8.buffer.byteLength }`. `found` exige 4 vértices + convexo + área ≥8% (score formal vem em F2).
    - Frames antes de `ready`: responder `{type:'error', message:'not-ready'}`.
    - **Recuperação de erro**: `self.onerror`/`self.onmessageerror` → emitir `{type:'error', message}`; main thread termina worker, cai para `FallbackDetector`, tenta reinicializar uma única vez.
11. Criar `js/framing/guide.js` (`FramingGuide`):
    - `start(video)`: reutiliza `guideCanvas` existente do `index.html` (não cria novo), configura `w=160`, `h=max(1, round(160*video.videoHeight/video.videoWidth))` (`willReadFrequently`), instancia `FallbackDetector` (fonte ativa inicial), instancia worker via `new Worker(new URL('./frame-worker.js', import.meta.url))`. `inFlight = false`, `lastFrameTime = 0`.
    - `loop()`: gate temporal **em ambos os ramos** — `if (now - lastFrameTime < interval) return schedule()`. Se `inFlight === true`, **descartar frame** e agendar próximo. Senão: desenha video→guideCanvas, `img = ctx.getImageData(0,0,w,h)`, `inFlight = true`, `lastFrameTime = now`, `postMessage({type:'frame', width:w, height:h, buffer: img.data.buffer}, [img.data.buffer])`, agenda próximo via `requestVideoFrameCallback` (fallback `setTimeout`).
    - `onWorkerReady`: troca fonte ativa de `FallbackDetector` para worker; anuncia "modo de precisão ativado"; **instrumenta e registra**: (a) tempo desde `start()` até `ready` (gate de F6); (b) **`cv.HEAPU8.buffer.byteLength` do primeiro `result`** (gate de A4 — ver passo 14).
    - `onWorkerError`: troca fonte ativa de volta para `FallbackDetector`; tenta reinicializar worker uma vez; se falhar de novo, fica no fallback permanentemente. `inFlight = false`.
    - `onResult(metrics)`: `inFlight = false`; log na tela (debug) + encaminha para estabilizador (F3).
    - `stop()`: termina worker (`terminate`), limpa timers, `inFlight = false`, **limpa a fila de fala** (`SpeechQueue.clear()` → `speechSynthesis.cancel()`), **`navigator.vibrate(0)`**.
    - Throttle adaptativo: medir `ms` da fonte; se >120 ms aumentar intervalo (450→700 ms) e/ou baixar a largura para 120; se <40 ms permitir 300 ms. **Nota**: o limiar de degradação (120 ms) é intencionalmente abaixo do critério A2 (≤150 ms) — defesa em profundidade. O throttle respeita **A8** (latência), não só o `ms` do worker; se 700 ms torna o guia inutilizável (debounce 400 ms + EMA + cooldown estourando o orçamento derivado), o modo degradado é falha silenciosa, não degradação graciosa.
11b. Criar `js/speech.js` + `js/framing/audio.js` **mínimo** (junto com F1, para o guia não ficar mudo entre F1 e F3):
    - `js/speech.js`: `SpeechQueue` com prioridade básica (status do app > direção do guia) e `clear()`. `app.js` passa a usar a fila em vez de `speechSynthesis` direto — em particular, `setStatus()` deixa de cancelar a fala do guia no meio.
    - `js/framing/audio.js` mínimo: oscilador contínuo (tom) + TTS via `SpeechQueue`, com `activate()` que cria **e dá `resume()`** no `AudioContext`, chamada no handler de botão. **Sem** pulsação, pan, orientation, voiceschanged — esses vêm em F4.
    - `app.js` chama `audio.activate()` no handler de `captureBtn`/`guideToggleBtn` (sincronamente, dentro do gesto).
12. Em `app.js`:
    - Remover tudo listado no passo 0. `detectSheetBounds` já extraída em F0.
    - Importar `FramingGuide` via `import`; substituir call sites por `framingGuide.start(els.camera)` / `framingGuide.stop()`.
    - O worker faz `importScripts` do OpenCV; nenhum `<script>` extra no `index.html`. App abre com `FallbackDetector` imediatamente.
13. Atualizar `sw.js`:
    - **Não adicionar `vendor/opencv-*.js` ao `addAll` do install** — 8 MB em 3G falha/estoura timeout e quebra o SW inteiro.
    - **Rota cache-first dedicada para `vendor/opencv-*.js`**: `caches.match(request)` → retorna se hit; senão `fetch` → guarda no cache → retorna.
    - **Path versionado**: cache-first imutável; bump de versão = novo path, nunca stale.
    - **Atualizar `ASSETS`**: o array atual é `['./', './index.html', './app.js', './manifest.json']` — **`index.html`, `app.js` e `manifest.json` já estão lá**. Adicionar: `./js/speech.js`, `./js/framing/fallback-detector.js`, `./js/framing/guide.js`, `./js/framing/stabilizer.js`, `./js/framing/audio.js`, `./js/framing/haptics.js`, `./icon-192.png`, `./icon-512.png`. (Não adicionar `frame-worker.js`, `test-harness.js` nem `vendor/opencv-*.js` — worker é sob demanda, harness é só dev, opencv tem rota própria.)
    - Bump `CACHE_NAME` (`leitor-desenho-v1` → `v2`).
14. **Gates de F1 (medir logo após `ready`)**:
    - **Gate de A4**: registrar `cv.HEAPU8.buffer.byteLength` do primeiro `result`. Heap WASM inicial do build oficial costuma ficar em 30–50 MB. Se já estourar 40 MB, **parar e decidir** antes de F2: build customizado, ou renegociar A4.
    - **Gate de carga**: registrar tempo desde `start()` até `ready`. Se > 45 s em 3G no aparelho de referência, build customizado passa a ser necessário (item de F6).
    - **Gate de Otsu puro**: rodar o harness com Otsu-only contra o baseline heurístico de F0. **Se já passar de 85% (A1), a cascata vira opcional** e F2 encolhe para só o score. Se ficar na zona cinzenta (80–88%), **expandir o dataset de stills** (F0 passo 8) antes de decidir. Cada ramo da cascata é caminho a mais de vazamento de `cv.Mat`.

### F2 — Cascata de binarização + score (condicional ao gate de Otsu)
15. **Só se o gate de Otsu puro (passo 14) não tiver passado A1**: em `frame-worker.js`, implementar cascata com cache de modo:
    - **CLAHE condicional**: `cv.meanStdDev` em `gray`; se std < 18, aplicar `clahe.apply(gray, gray)` (clahe pré-alocado em F1).
    - **Adaptive fallback**: `cv.adaptiveThreshold(GAUSSIAN_C, 31, 5)` quando Otsu der limiar extremo (<40 ou >215) ou separabilidade baixa.
    - **Canny fallback**: `cv.Canny(50,150)` + `cv.dilate 3×3` quando nenhum quadrilátero válido.
    - Cache do modo que funcionou no frame anterior; reavaliar cascata a cada ~10 frames ou em falha.
16. Implementar score (sempre — independe do gate):
    ```
    score = 0.40*areaNorm + 0.25*aspectScore + 0.20*convexityScore + 0.15*centerBias
    ```
    - `areaNorm` = área/áreaFrame saturado em 0.85.
    - `aspectScore` = proximidade de 1,414 (proporção do papel **ISO A4**) ou de seu inverso, tolerância ±25%. **Depende do canvas preservar o aspecto** (passo 11) — num canvas distorcido esse termo mede ruído.
    - `convexityScore` = área contorno / área hull.
    - `centerBias` = 1 − distância normalizada do centroide ao centro.
    - Se nenhum quadrilátero: `cv.minAreaRect` do maior contorno (folha parcial).
    - `found = score ≥ 0.45`.
17. `touchesEdge`: bounding rect do candidato encosta em ≤2 px de qualquer borda do frame.
18. **Medir A1 sobre `dataset/stills/` via `test-harness.js`**: rodar pipeline (Otsu-only ou com cascata) vs baseline heurístico; registrar taxa de `found` correto e erro de centro (px) em `BENCHMARK.md`. **A5 não é medível aqui** — PRONTO é estado do estabilizador (F3).

### F3 — Estabilizador + máquina de estados com PARCIAL
19. Criar `js/framing/stabilizer.js`:
    - EMA com **α em função do intervalo** (`α = 1 - exp(-interval/τ)`, τ≈300 ms), não fixo — α fixo em 0,35 leva ~3 frames para convergir 70%, e a 700 ms/frame isso são 2,1 s de atraso.
    - Histerese: entra "centralizado" com |dx|<0.08; só sai com |dx|>0.13 (idem Y). O código atual usa um limiar único (`GUIDE_CENTER_MARGIN = 0.08`) sem histerese — daí a oscilação.
    - **Debounce temporal (400 ms), não em frames** — 3 frames a 700 ms = 2,1 s antes de anunciar mudança, mais EMA + cooldown de TTS = 3–4 s de latência ponta-a-ponta. O usuário cego já passou do ponto e o guia manda corrigir para o lado errado.
    - **Máquina com PARCIAL**: `SEM_FOLHA → PARCIAL → AJUSTE_LATERAL → AJUSTE_VERTICAL → AJUSTE_DISTANCIA → PRONTO`.
    - **PARCIAL** alimentado por `touchesEdge=true`: folha cortada pela borda. **Prioridade acima de distância** — "a folha está saindo do quadro" antes de qualquer "afaste". Instrução: mover câmera no sentido oposto à borda tocada.
    - Prioridade restante: distância grosseira primeiro, depois eixo de maior desvio.
    - Um eixo por vez — nunca combinar direções.
20. `FramingGuide.onResult` roda métricas pelo estabilizador e emite `state` estável.
21. **Medir A5 sobre `dataset/clips/` via `test-harness.js`**: harness encadeia detector→estabilizador; medir taxa de `state=PRONTO` em condições não-ideais vs ground truth; registrar em `BENCHMARK.md`. A5 só é medível aqui.

### F4 — Áudio refinado (refina o mínimo de F1)
22. Refinar `js/framing/audio.js`:
    - **`createStereoPanner` com fallback**: preservar o padrão de `ensureGuideAudio` (verificar a função, não a linha); Safari antigo não tem.
    - **Fade-out correto no `stop()`**: `stopGuideAudio` hoje chama `gain.setTargetAtTime(0, …, 0.05)` e em seguida `osc.stop()` + `ctx.close()` no mesmo tick — a rampa nunca é ouvida, o som corta seco. Agendar `osc.stop(now + 0.2)` e fechar o contexto no `onended`.
    - **Voz pt-BR**: `speechSynthesis.getVoices()` pode retornar vazio no primeiro acesso (Android). Escutar `voiceschanged`, selecionar voz pt-BR, fallback para a padrão.
    - **TTS com fila/prioridade compartilhada**: `js/speech.js` já existe desde F1; F4 refina as prioridades (status do app > direção do guia > tom contínuo). **Cooldown de ~2 s suprime frase idêntica** (como `speakGuide` atual), **não bloqueia mudança de estado**.
    - **Camada contínua (tom)**: 250 Hz (longe) → 500 Hz (faixa boa) → 880 Hz (pronto) — mantém o mapeamento que o código já usa; pan estéreo = desvio horizontal (−1..1); taxa de pulsação = desvio vertical (2 Hz longe → contínuo alinhado); silêncio + bip duplo curto ao entrar PRONTO.
    - **Camada falada (TTS)**: frases ≤5 palavras, sempre movimento da câmera: "Câmera para a esquerda", "…direita", "…cima", "…baixo", "Aproxime", "Afaste", "Pronto, pode capturar", "Folha não encontrada", "Folha saindo do quadro". As frases atuais são longas demais — "Não encontro a folha. Aponte a câmera para ela e melhore a iluminação." leva ~4 s para falar, quase dez vezes o intervalo do loop.
    - **Orientação**: ler `screen.orientation.type`; em landscape, trocar eixos horizontal/vertical no mapeamento de `dx`/`dy`.
23. `FramingGuide` consome `state` do estabilizador e aciona `audio.update(state, metrics, orientation)`.

### F5 — Vibração + toggles de acessibilidade
24. Criar `js/framing/haptics.js`:
    - Feature detect: `'vibrate' in navigator`. Se ausente (iOS), reforçar camada auditiva.
    - Padrões por estado: SEM_FOLHA `[400]`/1500 ms; esquerda `[80,120,80]`/700 ms; direita `[250]`/700 ms; cima `[80,80,80,80,80]`/800 ms; baixo `[300,100,300]`/800 ms; aproximar pulsos acelerando; afastar desacelerando; PRONTO `[60,60,60,60,60]` uma vez; PARCIAL padrão distinto (ex. `[200,100,200,100,200]`).
    - Throttle 500 ms; `vibrate(0)` antes de trocar padrão.
    - **Nota**: `navigator.vibrate` no Android exige engajamento prévio — a primeira vibração pode ser ignorada. Não é bug; o botão "Tirar foto do desenho" serve de gesto prévio.
25. Em `index.html`: **dois checkboxes num `<details>` de config** (cada um com estado próprio anunciado pelo leitor de tela), não um ciclo de 4 estados no `#guideToggleBtn` — um ciclo exigiria que o usuário cego memorizasse a posição e ouvisse o rótulo a cada toque, regressão de acessibilidade. `#guideToggleBtn` continua sendo o liga/desliga geral (comportamento atual preservado); os checkboxes controlam som e vibração independentemente. Região `aria-live="polite"` dedicada ao guia — **separada de `#status`**, que já é `aria-live="polite"` e pertence ao fluxo principal.
26. Tutorial de áudio na primeira execução (flag em localStorage) explicando os sinais — incluindo que "Câmera para a esquerda" significa mover o aparelho, não a folha.

### F6 — Otimização (com baseline de F0 e gates de F1)
27. Throttle adaptativo (iniciado em F1): medir `ms` da fonte, ajustar intervalo e resolução. **Validar contra baseline de F0** — se piorar, reverter.
28. Pausar tudo em `visibilitychange` (aba oculta) e após 60 s sem mudança significativa de frame. **Sem `navigator.getBattery()`** — usar `ms` do worker como proxy de throttling térmico.
29. Auditoria de vazamento de `cv.Mat`: contador em debug; `.delete()` de todos os Mats temporários **incluindo os de `contours.get(i)`** e do `clahe`; teste de 1000 iterações com contagem constante.
30. **Gate do build customizado**: usar o tempo até "modo de precisão ativado" medido em F1; se > 45 s em 3G no aparelho de referência, compilar OpenCV core+imgproc via emscripten. **Gate de A4**: se o heap WASM medido em F1 já estourar 40 MB, build customizado também pode ser necessário.
31. **Nota de deploy** (não é passo de código): gzip/brotli é negociado pelo servidor — GitHub Pages, Netlify e Vercel já fazem para `.js`. Documentar no README o servidor alvo. Lembrar que `getUserMedia` exige HTTPS (ou localhost).

### F7 — Fallback e degradação (quase trivial com fontes intercambiáveis)
32. Em `guide.js` (já estruturado em F1):
    - Sem Worker: `FallbackDetector` é a única fonte, síncrono, largura 120, intervalo 500 ms.
    - Worker falha ao carregar WASM: `onWorkerError` já troca para `FallbackDetector` permanentemente.
    - Sem vibração: já tratado em `haptics.js`.
    - iOS Safari: sem `navigator.vibrate` (detectado), sem `OffscreenCanvas` (não usado), TTS via `speechSynthesis` com `voiceschanged`.
33. Confirmar que o app abre e funciona (modo degradado) sem OpenCV.js, sem Worker e sem vibração (A7).

## Files to Modify

- `app.js` — remover pipeline heurístico inline (seis funções + `initGuideToggle` + `updateGuideToggleLabel` + variáveis + constantes + call sites); integrar `FramingGuide` via import; usar `SpeechQueue` de `js/speech.js` em vez de `speechSynthesis` direto; chamar `audio.activate()` no handler de botão.
- `index.html` — `<script type="module" src="app.js">`; dois checkboxes num `<details>` de config; `#guideToggleBtn` mantido como liga/desliga geral; região `aria-live` própria do guia. (`guideCanvas` já existe — reutilizado.)
- `sw.js` — bump `CACHE_NAME`; rota cache-first para `vendor/opencv-*.js`; **não** adicionar opencv ao `addAll`; adicionar aos `ASSETS` os módulos novos e os dois ícones (`index.html`, `app.js` e `manifest.json` já estão lá).

## Files to Create

- `js/framing/fallback-detector.js` — `detectSheetBounds` reescrito com interface comum (extraído em F0).
- `js/framing/frame-worker.js` — Worker clássico, `importScripts ../../vendor/opencv-<versão>.js`, pipeline + cascata + score + resize implícito + wasmHeap.
- `js/framing/guide.js` — `FramingGuide` (loop, backpressure `inFlight`, throttle temporal nos dois ramos, ciclo de vida, troca de fonte, guideCanvas com aspecto preservado).
- `js/framing/stabilizer.js` — EMA, histerese, debounce temporal, máquina de estados com PARCIAL.
- `js/framing/audio.js` — oscilador contínuo, pan com fallback, pulsação, TTS com cooldown, voiceschanged, orientation, `activate()` com `resume()`; consome `js/speech.js`.
- `js/speech.js` — `SpeechQueue` com prioridade compartilhada; consumido por `app.js` e `audio.js`.
- `js/framing/haptics.js` — padrões de vibração, feature detect, throttle.
- `js/framing/test-harness.js` — playback de stills + clipes + comparação com ground truth; aceita `detect` injetado; **página não registra o SW**.
- `vendor/opencv-<versão>.js` — build oficial (path versionado, versão verificada no download).
- `BENCHMARK.md` — baseline de F0 + gates de F1 (carga WASM, heap WASM, Otsu puro) + orçamento de latência (A8) + resultado da verificação do AudioContext + medições de F6.
- `dataset/stills/` + `dataset/clips/` + `dataset/annotations/` — fotos (A1) + clipes (A5) + anotações JSON (**fora do repo via `.gitignore`**).
- `.gitignore` — adicionar `dataset/`.

## Verification (critérios A1–A7 do spec-mãe + A8 novo)

**Medição de critérios (requer dataset + harness de F0):**
- [ ] **A1 (≥85% detecção em fundo baixo contraste)**: `test-harness.js` sobre `dataset/stills/`; taxa de `found=true` correto vs ground truth, comparada ao baseline heurístico de F0.
- [ ] **A2 (≤150 ms por frame)**: `ms` mediano do worker sobre o dataset, em `BENCHMARK.md`. (Throttle degrada em >120 ms — defesa em profundidade.)
- [ ] **A3 (5–8 fps em aparelho de referência)**: fps efetivo do loop. Mantido como no spec-mãe.
- [ ] **A4 (<40 MB heap adicional)**: **soma** de `performance.memory.usedJSHeapSize` + `cv.HEAPU8.buffer.byteLength`. Baseline antes do `start()`; delta 60 s depois. **Gate de F1**: se o heap WASM inicial já estourar 40 MB, parar antes de F2. **`performance.memory` é não-padrão, só Chrome** — registrar a limitação.
- [ ] **A5 (<2% falsos "pronto")**: harness encadeando detector→estabilizador sobre `dataset/clips/`. **Só medível após F3.**
- [ ] **A6 (mediana ≤20 s até enquadrar, usuário cego)**: **fora de escopo** — exige F8. Marcar como pendente em `BENCHMARK.md`; não aprovar por proxy.
- [ ] **A7 (app utilizável sem OpenCV.js)**: ver checklist funcional.
- [ ] **A8 (novo — latência movimento→frase)**: derivado da tabela de orçamento de F0 (intervalo + `ms` da fonte + debounce + latência de início do `speechSynthesis`). Provavelmente ~1200 ms normal / ~1600 ms degradado. Se o modo degradado estourar o orçamento derivado, é falha silenciosa, não degradação graciosa.

**Funcionais (binários):**
- [ ] Tag `pre-framing` criada; rollback possível.
- [ ] `app.js` sem erros de sintaxe; nenhum `els.*` null após a migração para `type="module"`.
- [ ] App abre e funciona com `FallbackDetector` antes do OpenCV carregar.
- [ ] Após OpenCV carregar, "modo de precisão ativado" é anunciado; tempo de carga e heap WASM registrados.
- [ ] Worker emite `result` com `found=true` ao apontar a câmera para folha A4 sobre mesa clara.
- [ ] Canvas de análise preserva o aspecto do vídeo (h derivado de `videoHeight/videoWidth`, não 120 fixo).
- [ ] Backpressure: `inFlight` true descarta frame; volta a false ao receber `result`/`error`.
- [ ] Throttle temporal presente **nos dois ramos** (`rVFC` e `setTimeout`).
- [ ] Resize implícito: throttle baixa a largura para 120; worker realoca Mats ao detectar mudança.
- [ ] Frames antes de `ready` recebem `{type:'error'}`; `inFlight` volta a false.
- [ ] `touchesEdge` detecta folha cortada; PARCIAL tem prioridade sobre distância.
- [ ] `guideAudioCtx.state === 'running'` durante o guia (F0 passo 6b e após a refatoração); `activate()` chama `resume()`; `createStereoPanner` tem fallback.
- [ ] Fade-out do oscilador é audível (`osc.stop(now+0.2)`, `ctx.close()` no `onended`).
- [ ] **SpeechQueue compartilhada**: `setStatus` não mata a frase de direção do guia no meio.
- [ ] Direção falada é movimento da câmera; eixos trocam em landscape via `screen.orientation`.
- [ ] Voz pt-BR carrega via `voiceschanged`; fallback para a padrão.
- [ ] Vibração: padrões distintos por estado em Android Chrome; ausência tratada em iOS com reforço auditivo.
- [ ] Estabilizador: nenhum anúncio alterna >1×/s em série sintética.
- [ ] Throttle adaptativo aumenta o intervalo se `ms` >120; valida contra baseline de F0.
- [ ] Pausa em `visibilitychange` e após 60 s sem mudança.
- [ ] Auditoria de Mat: contador constante após 1000 iterações, incluindo `contours.get(i)` e `clahe`.
- [ ] Recuperação de erro do worker: `onerror`/`onmessageerror` → fallback + reinicialização única.
- [ ] SW: rota cache-first para `vendor/opencv-<versão>.js`; não está no `addAll`; `ASSETS` inclui módulos novos e ícones; SW instala mesmo sem OpenCV; path versionado não fica stale; `CACHE_NAME` bumpado.
- [ ] Sem Worker: `FallbackDetector` síncrono funciona.
- [ ] Sem WASM: `FallbackDetector` permanente funciona.
- [ ] Sem vibração: camada auditiva reforçada.
- [ ] `sw.js` funciona offline após o primeiro carregamento.
- [ ] Dois checkboxes independentes (som, vibração) num `<details>`; `#guideToggleBtn` segue como liga/desliga geral.
- [ ] Região `aria-live` do guia separada de `#status`.
- [ ] `tilt` no contrato mas não no feedback.
- [ ] `guideCanvas` reutilizado do HTML, não duplicado.
- [ ] `stop()` limpa a fila de fala e chama `navigator.vibrate(0)`.
- [ ] `test-harness.js` roda stills via `<img>` e clipes via `<video src>`; **página do harness não registra o SW**.

## Risks/Considerations

Riscos que **não** são repetição das decisões acima:

- **Canvas distorcido invalida o `aspectScore`** (risco introduzido pela revisão anterior): `160×120` fixo sobre vídeo 4:3 ou 16:9 muda a razão largura/altura da folha, e o termo de 25% do score passa a medir distorção do canvas em vez de forma do papel. Preservar o aspecto é pré-requisito de F2.
- **Vazamento de `cv.Mat`** é o bug nº 1 de OpenCV.js: Mats pré-alocados fora do loop, `.delete()` disciplinado, contador em debug, teste de 1000 iterações. `contours.get(i)` retorna Mats que também vazam; `cv.createCLAHE` também aloca. Cada ramo da cascata é um caminho a mais de vazamento — daí o gate de Otsu puro em F1.
- **`importScripts` resolve contra `self.location`**, não contra o documento: de `js/framing/frame-worker.js` são dois níveis. O worker **não pode ser module**.
- **SW network-first re-baixaria 8 MB a cada visita**: rota cache-first dedicada, path versionado, opencv fora do `addAll`.
- **`requestVideoFrameCallback` dispara a ~30 fps** e não existe em todos os navegadores: gate temporal explícito nos dois ramos + fallback `setTimeout`.
- **`performance.memory` não enxerga o heap WASM** e é só Chrome: A4 é a soma dos dois heaps e só é medível em Chrome.
- **A hipótese do AudioContext pode ser falsa** (F0 passo 6b): reorganizar F1 em torno de um bug não confirmado custa tempo. A correção defensiva é barata e entra de qualquer forma; a *prioridade* depende da medição.
- **A6 não é verificável no escopo atual** — o critério que mais importa para o usuário final (tempo real até enquadrar) depende de F8. Todos os outros são proxies dele.
- **Conflito de TTS entre `app.js` e o guia** é real e já existe hoje (`setStatus` → `speak(interrupt:true)` → `speechSynthesis.cancel()`).
- **Frases atuais do guia são longas demais** para o intervalo de 450 ms; encurtar não é cosmético — é o que permite o feedback acompanhar o movimento.
- **`navigator.vibrate` no Android exige engajamento prévio**; iOS Safari não tem vibração alguma.
- **Dataset superdimensionado**: A1 é métrica por-frame — 40–50 fotos primeiro; expandir só se o gate de Otsu ficar na zona cinzenta. Vídeo só para A5 (6–8 clipes).
- **`?nocache` não faz bypass de Service Worker** — o fetch handler intercepta tudo; a página do harness simplesmente não registra o SW.
- **Aparelho de baixo custo**: largura 160 não-negociável, Mats pré-alocados, throttle adaptativo, baseline de F0 como referência.

# BENCHMARK — Guia de Enquadramento

Medições de F0 (baseline heurística) + gates de F1 + orçamento de latência (A8)
+ medições de F6. Os campos marcados `[PENDENTE]` exigem dataset físico e/ou
aparelho Android de referência (Moto E / Redmi 9A) — não são preenchíveis só
com código. O que é mensurável em desktop já está instrumentado no
`fallback-detector.js` (`getStats()`, `jsHeapBytes()`) e no `test-harness.js`.

> Convenção: `ms` = tempo do detector por frame; `fps` = frames processados
> por segundo efetivo (derivado do intervalo real, não do throttle nominal).

> **Servidor local obrigatório desde F0.** `app.js` e os módulos em `js/`
> usam `import`/`export` (ES modules), que o navegador recusa sob `file://`
> (CORS). Abrir `index.html` ou `harness.html` por duplo-clique não funciona
> mais — sirva por HTTP, ex.: `python3 -m http.server 8765`.

---

## F0 — Baseline heurística (FallbackDetector)

### A1 — Detecção (stills)  `[PENDENTE: dataset]`

Meta: ≥85% dos frames com `found` correto vs ground truth.

| Métrica | Valor |
|---|---|
| Frames no dataset | `[PENDENTE]` |
| Acurácia de `found` | `[PENDENTE]` % |
| Erro de centro mediano (px) | `[PENDENTE]` |
| Erro de centro médio (px) | `[PENDENTE]` |
| Acurácia `touchesEdge` | `[PENDENTE]` % |

Como medir: abrir `harness.html`, botão "Rodar stills". Saída formatada pelo
`formatStillsReport()` do `test-harness.js`.

### A2 — Latência do ciclo detecção→feedback  `[PENDENTE: aparelho]`

Meta: ≤150 ms por frame processado.

| Métrica | Valor |
|---|---|
| `ms` mediano (FallbackDetector) | `[PENDENTE]` |
| `ms` médio | `[PENDENTE]` |
| `ms` máx | `[PENDENTE]` |

`ms` do heurístico em desktop é <5 ms (sem WASM); o número relevante é no
aparelho de referência. Em desktop Chrome com throttling de CPU 4× como proxy.

### A3 — Taxa de processamento  `[PENDENTE: aparelho]`

Meta: 5–8 fps no aparelho de referência.

| Métrica | Valor |
|---|---|
| fps efetivo (loop 450 ms) | `[PENDENTE]` |
| Intervalo nominal | 450 ms |

### A4 — Heap JS adicional  `[PENDENTE: aparelho Chrome]`

Meta: <40 MB acima da baseline. **Soma** de `performance.memory.usedJSHeapSize`
+ `cv.HEAPU8.buffer.byteLength` (WASM, só a partir de F1).

| Métrica | Valor |
|---|---|
| `usedJSHeapSize` baseline (antes do start) | `[PENDENTE]` |
| `usedJSHeapSize` 60 s depois | `[PENDENTE]` |
| Delta JS heap | `[PENDENTE]` MB |
| Heap WASM (F1) | `[PENDENTE]` MB |

**Limitação**: `performance.memory` é não-padrão, só Chrome, granularidade
reduzida sem headers de isolamento. A4 só é medível em Chrome. O heap WASM
vive num ArrayBuffer fora do heap JS e domina o critério a partir de F1.

### A5 — Falsos "pronto"  `[PENDENTE: dataset de clipes + F3]`

Meta: <2% dos frames em condição não-ideal. **Só mensurável após F3**
(estabilizador). Em F0 não há estado PRONTO (só detector puro).

**Definição da métrica (pinada antes de gerar números):**

- `falseReadyRate = falseReady / readyTotal` — fração de frames em que o
  sistema disse "pronto" mas o ground truth diz que não estava. É a
  **precisão do sinal de pronto** (a métrica primária do gate de F3).
- Denominador é `readyTotal` (frames em que o sistema disse pronto), **não**
  o total de frames do clipe. Reportar também:
  - `falseReadyPerMin = falseReady / clipDurationS * 60` — para comparar
    clipes de duração diferente (densidade temporal de erros).
  - `readyRate = readyTotal / totalFrames` — para contextualizar quão
    "falador" o detector é (não é a métrica do gate, só diagnóstico).

> A partir de F3, "pronto" vira transição de estado do estabilizador (não
> por-frame). Nesse caso `readyTotal` conta transições para PRONTO, e
> `falseReady` as transições que o ground truth marca como não-ideal. A
> definição do ratio é a mesma; muda só a unidade do numerador/denominador
> (transições em vez de frames).

### A6 — Tempo até enquadrar (usuário cego)  `[FORA DE ESCOPO]`

Exige F8 (testes com usuários cegos). Marcar como pendente — não aprovar por
proxy.

### A7 — App utilizável sem OpenCV.js  `[OK em F0]`

Em F0 o app **só** usa o FallbackDetector — A7 é verdade por construção nesta
fase. Verificação funcional completa vem em F7.

### A8 — Latência ponta-a-ponta movimento→frase  `[PENDENTE: aparelho]`

Derivado da tabela de orçamento abaixo (não chute fixo). fps (A3) é proxy ruim
para a experiência; o que importa é o tempo entre o movimento da câmera e a
frase de correção.

#### Tabela de orçamento (medir os termos reais em F0)

| Termo | Nominal | Medido | Observação |
|---|---|---|---|
| Intervalo do loop | 450 ms | `[PENDENTE]` | throttle nominal |
| `ms` do detector | ~5 ms (heur.) | `[PENDENTE]` | `getStats().medianMs` (só o loop de pixels do detector — **não** inclui `drawImage`/`getImageData`) |
| `ms` do pipeline completo | — | `[PENDENTE]` | `report.frameMs.avg` do harness (drawImage + getImageData + detect). É este que vira a baseline de "não piorar" contra o OpenCV em F1 — senão o WASM parece pior do que é, pois o custo de cópia do frame some da conta do heurístico. |
| Debounce (F3) | 400 ms | `[PENDENTE]` | temporal, não em frames |
| Latência início `speechSynthesis` | 150–300 ms | `[PENDENTE]` | `performance.now()` antes de `speak()` e dentro de `utterance.onstart` |
| **A8 normal (soma)** | ~1120–1270 ms | `[PENDENTE]` | |
| **A8 degradado (intervalo 700 ms)** | ~1500 ms | `[PENDENTE]` | se estourar, é falha silenciosa, não degradação graciosa |

Como medir a latência de `speechSynthesis`:
```js
const t0 = performance.now();
const u = new SpeechSynthesisUtterance('teste');
u.lang = 'pt-BR';
u.onstart = () => console.log('latência TTS:', performance.now() - t0, 'ms');
speechSynthesis.speak(u);
```

---

## F0 passo 6b — Verificar hipótese do AudioContext  `[PENDENTE: aparelho]`

5 minutos, antes de qualquer refatoração de áudio (F1). Em aparelho Android
real, com o guia rodando, logar `guideAudioCtx.state` e `guideGain.gain.value`.

- [ ] Chrome/Android: `guideAudioCtx.state` = `[PENDENTE: running ou suspended?]`
- [ ] iOS Safari (se houver aparelho): `[PENDENTE]`

**Interpretação**:
- Se `running`: o guia nunca esteve mudo; a correção defensiva em F1
  (`audio.activate()` com `resume()` no handler do botão) vira endurecimento,
  não correção prioritária.
- Se `suspended`: bug confirmado; vira correção prioritária em F1.

A hipótese é que `ensureGuideAudio()` é chamado dentro do callback de
`setInterval` (fora do gesto), mas o guia só inicia após um clique em
`captureBtn` → `startCamera()`, e Chrome usa **sticky activation** (uma
interação qualquer no documento basta). Logo, em Chrome/Android o contexto
provavelmente já está `running`. O risco real é iOS Safari.

---

## F0 passo 7 — Baseline sobre o dataset  `[PENDENTE: dataset + aparelho]`

Rodar `harness.html` com o FallbackDetector sobre `dataset/stills/`. Em
aparelho de referência se disponível; senão, desktop Chrome com throttling de
CPU 4× (DevTools → Performance → CPU 4× slowdown).

| Métrica | Desktop (proxy) | Aparelho ref. |
|---|---|---|
| fps | `[PENDENTE]` | `[PENDENTE]` |
| ms/frame mediano | `[PENDENTE]` | `[PENDENTE]` |
| Acurácia `found` | `[PENDENTE]` | `[PENDENTE]` |
| Erro de centro mediano (px) | `[PENDENTE]` | `[PENDENTE]` |

## F0 passo 8 — Tamanho do dataset

Começar com 40–50 fotos. Só expandir se o gate de Otsu de F1 ficar na zona
cinzenta (80–88%). Se Otsu passar folgado, as outras fotos nunca precisaram
existir.

- [ ] 40–50 stills gravados e anotados
- [ ] 6–8 clipes gravados e anotados (para A5 em F3)

---

## F1 — Gates (medir logo após `ready` do worker)  `[PENDENTE: F1]`

- [ ] **Gate de A4**: `cv.HEAPU8.buffer.byteLength` do primeiro `result`. Build
  oficial costuma ficar em 30–50 MB. Se estourar 40 MB, **parar antes de F2**:
  build customizado ou renegociar A4.
- [ ] **Gate de carga**: tempo desde `start()` até `ready`. Se >45 s em 3G no
  aparelho de referência, build customizado passa a ser necessário (item de F6).
- [ ] **Gate de Otsu puro**: rodar harness com Otsu-only contra a baseline
  heurística de F0. Se ≥85% (A1), a cascata vira opcional e F2 encolhe para só
  o score. Se 80–88%, expandir o dataset de stills antes de decidir.

---

## F6 — Otimização  `[PENDENTE: F6]`

- [ ] Throttle adaptativo validado contra baseline de F0 (não piorar)
- [ ] Pausa em `visibilitychange` e após 60 s sem mudança
- [ ] Auditoria de `cv.Mat`: contador constante após 1000 iterações
      (incluindo `contours.get(i)` e `clahe`)
- [ ] Build customizado (core+imgproc) só se gate de carga ou A4 exigir

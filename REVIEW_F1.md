# Code review — F1 (OpenCV.js + Worker + Otsu + fonte intercambiável)

Escopo: working tree não commitado sobre `d7cdb4f` (F0).
Arquivos: `js/framing/frame-worker.js`, `guide.js`, `audio.js`, `stats.js`,
`js/speech.js`, `app.js`, `sw.js`, `harness.html`, `test-harness.js`.

Veredito: a arquitetura está certa (fonte intercambiável, backpressure,
worker vivo entre toggles, cache-first versionado do vendor). Mas há **4
bugs que invalidam objetivos declarados de F1** e um que é exatamente o
"bug nº 1 de OpenCV.js" que o plano manda evitar. Não medir os gates até
corrigir B1 e B4 — as medições sairão erradas.

---

## Bloqueadores

### B1 — Vazamento de `cv.Mat` na seleção do melhor quadrilátero
`frame-worker.js:184-187`

```js
if (approx.rows === 4 && cv.isContourConvex(approx)) {
  best = approx;                                   // ← já sobrescreveu
  if (best !== approx) try { best.delete(); } catch (e) {}  // ← sempre falso
  bestArea = area;
}
```

A guarda é lógica morta: depois de `best = approx`, `best !== approx` é
sempre `false`. **Todo `best` anterior vaza**, um `Mat` por candidato
melhor por frame. Em cena com múltiplos quadriláteros isso é vazamento
contínuo no heap WASM — e contamina o gate de A4 (`wasmHeap` cresce a cada
frame, então o "heap inicial" medido no primeiro result não representa o
regime).

Correção:

```js
if (approx.rows === 4 && cv.isContourConvex(approx)) {
  if (best) { try { best.delete(); } catch (e) {} }
  best = approx;
  bestArea = area;
}
```

Relacionado: se `processFrame` lançar entre a seleção e o `best.delete()`
final (extração de vértices, `minAreaRect`, `postMessage`), o `best` também
vaza — o `catch` está lá em cima, no `onmessage`. Envolver o corpo pós-loop
em `try/finally { best && best.delete() }`.

### B2 — `setStatus()` continua matando a fala do guia
`app.js` (`speak`) + `js/speech.js`

O objetivo explícito do passo 11b é: *"`setStatus()` deixa de cancelar a
fala do guia no meio"*. Mas:

```js
function speak(text, { interrupt = true } = {}) {
  if (interrupt) speechQueue.clear();   // clear() sem argumento = cancela TUDO
  speechQueue.speak(text, PRIORITY.STATUS);
}
```

`setStatus()` → `speak()` com `interrupt` default `true` → `clear()` sem
argumento → esvazia a fila inteira, inclusive GUIDE. Comportamento idêntico
ao `speechSynthesis.cancel()` que se queria substituir. Toda a máquina de
prioridades fica sem efeito no caminho principal.

Correção: `speak()` não deveria chamar `clear()` — a preempção por
prioridade já faz o trabalho. Se quiser preservar semântica de "descartar
pendentes da mesma classe", use `speechQueue.clear(PRIORITY.STATUS)` (remove
STATUS e tudo de prioridade menor, incluindo GUIDE)… o que ainda mata o
guia. O correto é remover o `clear()` e deixar a preempção agir, ou
introduzir um `clearOwn(priority)` que filtre só a própria faixa.

### B3 — Race de `onend`/`onerror` órfãos na SpeechQueue
`js/speech.js:57-71, 81-100`

`speechSynthesis.cancel()` dispara `onerror` (ou `onend`) do utterance
cancelado **de forma assíncrona**. O código zera `this.current`
sincronamente e já dá `_pump()` na próxima fala. Quando o handler órfão
finalmente roda:

```js
entry.utterance.onerror = () => {
  this.current = null;      // ← zera o utterance NOVO, que está tocando
  this._speaking = false;
  this._pump();             // ← inicia um segundo utterance em paralelo
};
```

Resultado: duas falas simultâneas e estado interno mentindo. Cabeça de
série para o sintoma "o guia às vezes fala por cima de si mesmo".

Correção: no `_pump`, guardar identidade — `onend = () => { if
(this.current !== entry) return; … }` — e/ou desanexar
(`entry.utterance.onend = entry.utterance.onerror = null`) antes de cada
`cancel()`.

Bônus: `speech.js:57-62` — o `if (this.current.priority > priority)` aninhado
dentro de `if (priority < this.current.priority)` é a mesma condição.
Sempre verdadeiro; remover.

### B4 — O harness do gate de Otsu não espera o worker e quebra com `null`
`harness.html` (bloco `runStillsWorker`) + `test-harness.js:154-168`

Dois problemas compostos:

1. A "espera pelo ready" é um `setTimeout(3000)` que resolve
   incondicionalmente. O `check()` de polling ao lado **nunca é chamado** —
   é código morto. OpenCV.js de ~10 MB não sobe em 3 s em nenhum cenário
   realista de primeira carga.
2. Antes de `ready`, `detect()` resolve `null`. `runStills` faz
   `compareStill(result, …)` e `result.tilt` sem guarda → `TypeError`, ou,
   se sobreviver, contabiliza frames descartados como falha de detecção.

Ou seja: o **gate de Otsu de F1** — o que decide se F2 (cascata) precisa
existir — está medindo lixo ou estourando. Corrigir antes de rodar
qualquer medição.

Correção: resolver a Promise no handler de `type:'ready'` (sem timeout,
com timeout longo só como erro), e em `runStills` tratar `result == null`
como "frame descartado" explícito (contador próprio), nunca como resultado.

---

## Importantes (não bloqueiam, corrigir antes do commit)

**G1 — `cancelAnimationFrame` sobre handle de `requestVideoFrameCallback`.**
`guide.js:118-121` vs `_schedule():210-214`. Os dois têm espaços de ID
separados; o cancelamento correto é `video.cancelVideoFrameCallback(id)`.
Hoje o guard `if (!this._running) return` no topo de `_loop` salva a
execução, mas você pode estar cancelando um rAF alheio com ID colidente.
Guardar qual API agendou (`this._rafKind`) e cancelar com a certa.

**G2 — Throttle adaptativo assimétrico e alimentado com a métrica errada.**
`guide.js:315-329`. Uma vez que `this.w` cai para 120 nunca volta a 160,
mesmo com `ms < 40`. E `metrics.ms` do worker mede só o pipeline OpenCV —
não inclui `drawImage` + `getImageData` + transfer + round-trip, que é
justamente o que o `BENCHMARK.md` avisa não ser comparável. O plano diz que
o throttle deve respeitar **A8 (latência ponta a ponta)**, não o `ms` da
fonte. Medir o round-trip no main thread (`postMessage` → `onmessage`) e
usar esse número.

**G3 — Métricas cruzadas entre fontes.** `_onResult` só registra em
`workerStats` quando `activeSource === 'worker'`, o que está certo. Mas um
`result` atrasado que chegue depois de `_onWorkerError` ainda alimenta
`_adaptThrottle` e `audio.update()` — feedback de áudio vindo de uma fonte
já rebaixada. Descartar results cujo `mode` não bate com a fonte ativa.

**G4 — SW cacheia respostas de erro no vendor.** `sw.js`, rota `vendor/`:
`cache.put(event.request, clone)` sem checar `resp.ok`. Um 404/502 durante
o primeiro download fica gravado **permanentemente** num path declarado
imutável — o "modo de precisão" nunca mais ativa nesse dispositivo, sem
caminho de recuperação. Guardar `if (resp.ok) cache.put(...)`. (O mesmo
vale para o ramo network-first do app shell, mas lá o bump de cache
resolve.)

**G5 — Guia mudo se a câmera abrir por comando de voz.** `audio.update()`
retorna cedo se `!this.ctx`, e `ctx` só nasce em `audio.activate()`, chamado
nos handlers de `captureBtn` e `guideToggleBtn`. `startCamera()` também é
alcançável por `initVoiceCommands` (`app.js:356`) — nesse caminho o
`AudioContext` nunca é criado e o guia fica silencioso. Chamar `activate()`
no gesto que inicia o reconhecimento de voz também.

---

## Menores

- `audio.js stop()`: `setTargetAtTime(0, …)` seguido de `suspend()` imediato
  congela a rampa no valor corrente. No próximo `start()`+`resume()` o tom
  volta no volume antigo até o primeiro result. Zerar o gain com
  `setValueAtTime` antes de suspender, ou zerar em `start()`.
- `frame-worker.js:161`: `new cv.Size(3, 3)` por frame. É value_object
  (não vaza), mas hoistar é grátis.
- `frame-worker.js`: `contours` (MatVector) reusado entre frames confiando
  em `findContours` limpar internamente. Confirmar no build 4.13 ou chamar
  `contours.delete()` + recriar; um MatVector que acumula é vazamento
  silencioso.
- `app.js`, toggle do guia: `audio.activate()` roda mesmo quando a ação é
  *desligar* o guia — cria um AudioContext para nada.
- `pagehide` com `{ once: true }`: após restauração de bfcache, o worker
  nunca mais é terminado no fim de vida. Remover o `once`.
- `speech.js`: perdeu `utter.rate = 1` do original (default é 1, então é
  cosmético — mas se um dia mudar a taxa, é aqui).
- `sw.js ASSETS` inclui `frame-worker.js` mas não o `opencv-*.js` — correto
  por desenho, mas significa que offline-first não tem modo de precisão até
  a primeira carga online. Vale registrar no `BENCHMARK.md`.

---

## O que está bom

- Separação `stats.js` como factory (B1 da rev. 4) resolve de fato a
  ambiguidade de "qual fonte estou medindo".
- `notready` como tipo distinto de `error` — evita o retry-storm que um
  `error` genérico causaria durante a init de 10 MB.
- Worker vivo entre `start()`/`stop()` com `destroy()` separado: o custo de
  reinit do WASM a cada toggle teria sido brutal.
- Dois caches no SW com `activate` filtrando por prefixo: preserva os 10 MB
  entre bumps do app. Esse detalhe costuma passar batido.
- `deleteMats` no resize implícito e `.delete()` de cada `contours.get(i)`
  no `finally` — a disciplina está lá; só o `best` escapou.

---

## Ordem sugerida

1. B1 (vazamento) e B4 (harness) — sem isso nenhuma medição vale.
2. B2 e B3 (fala) — são regressões de comportamento visíveis ao usuário.
3. G1, G4, G5.
4. Rodar os gates de F1 e preencher `BENCHMARK.md`.
5. G2 depois dos gates — o throttle precisa da baseline de A8 para ser
   calibrado, não antes.

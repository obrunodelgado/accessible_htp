# Plano de implementação — F2: cascata de binarização e score de candidatos

**Projeto:** Mega Vision  
**Fase:** F2 do `PLANO_GUIA_ENQUADRAMENTO.md`  
**Plano de execução relacionado:** `PLANO_ENQUADRAMENTO_OPENCV.md`  
**Status:** plano revisado; implementação bloqueada pela execução do gate de entrada  
**Pré-requisito:** F1 integrada e gates medidos com dataset válido

---

## 1. Objetivo

A F2 deve tornar o detector OpenCV mais robusto nos casos em que o pipeline
Otsu da F1 não separa a folha do fundo: papel branco sobre mesa clara, sombras
fracas, iluminação desigual e bordas definidas principalmente por contorno.

A fase tem duas entregas possíveis, escolhidas pelo gate de entrada:

1. **Score geométrico de candidatos**, sempre implementado, substituindo a
decisão F1 baseada apenas no maior quadrilátero por uma seleção que considera
área, proporção ISO A4, convexidade e proximidade do centro.
2. **Cascata de processamento**, com CLAHE condicional, binarização adaptativa
e Canny como fallback, implementada somente se Otsu não atingir A1 no dataset
confirmado; quando necessária, o cache evita executar os três caminhos em todos
os frames.

O resultado continua sendo uma fonte de métricas para o `FramingGuide`. F2 não
implementa estabilização temporal, máquina de estados, novos padrões sonoros,
vibração ou tutorial de acessibilidade; esses itens permanecem em F3–F5.

---

## 2. Estado de partida confirmado

A implementação atual da F1 está na `main` e contém:

- `js/framing/frame-worker.js`: worker clássico com OpenCV.js 4.13.0,
pipeline Otsu, Mats reutilizados, transferência de `ArrayBuffer` e saída
`mode: 'otsu'`.
- `js/framing/guide.js`: fonte heurística durante a carga e fonte worker após
`ready`, com backpressure, throttle e descarte de resultados incompatíveis.
- `js/framing/fallback-detector.js`: fallback heurístico com a interface comum.
- `js/framing/test-harness.js` e `harness.html`: execução do baseline e do
worker sobre `dataset/stills/`.
- `BENCHMARK.md`: gate de Otsu da F1, baseline F0 e medições de heap, latência
e fps ainda pendentes quando dependem de dataset/aparelho.

**Estado factual do gate:** no momento desta revisão, todos os campos da seção
F1 de `BENCHMARK.md` continuam `[PENDENTE]`, portanto a F1 ainda não está
verificada experimentalmente. O dataset local já contém 73 stills JPEG, e
`dataset/index.json` contém 73 entradas com `truth.found`, `bbox` e
`touchesEdge`; não há clipes no índice. O diretório `dataset/annotations/` está
vazio, mas isso não bloqueia o harness atual porque as anotações estão embutidas
no índice. A tabela de decisão da seção 3 continua inaplicável até o gate ser
executado e os números serem registrados; a existência dos arquivos, por si só,
não justifica score-only nem cascata completa.

Há uma diferença importante entre o plano original da F1 e o código real: o
plano previa `clahe` pré-alocado, mas o worker atual ainda não possui esse Mat.
A implementação da F2 deve corrigir isso antes de usar CLAHE, incluindo o
`delete()` no caminho de resize/destruição.

Também há uma dependência de contrato: o `guide.js` atual aceita somente
`mode === 'otsu'` para resultados do worker. Depois da F2 ele deverá aceitar os
modos `otsu`, `adaptive` e `canny`, sem aceitar resultados heurísticos atrasados
quando a fonte ativa for o worker.

---

## 3. Gate de entrada e decisão de escopo

Este gate é **bloqueante e ainda não foi executado**. A integração da F1 no
código não equivale à verificação da F1. Nenhuma decisão entre score-only e
cascata completa, e nenhum critério de saída da F2 que dependa de A1, pode ser
aprovado enquanto os dados abaixo não existirem.

### 3.1 Pré-requisitos materiais

Antes de rodar o gate, o operador precisa:

1. confirmar que o conjunto local atende ao F0. Atualmente há 73 stills, acima
da amostra inicial de 40–50; não adicionar mais arquivos apenas para obter um
número maior;
2. validar que `dataset/index.json` lista os arquivos existentes e contém as
anotações de ground truth `found`, `bbox` e `touchesEdge`;
3. confirmar que o harness consegue carregar pelo menos um still em uma
execução de fumaça.

Uma amostra menor pode validar o encanamento do harness, mas **não pode ser
usada para aprovar A1 nem escolher o escopo da F2**. O dataset é gitignored e
precisa ser fornecido localmente; os 73 arquivos atuais não substituem a
execução do gate nem a verificação da matriz de condições.

### 3.2 Execução do gate

Com o dataset válido, antes de alterar o worker:

1. rodar o FallbackDetector e o worker Otsu sobre `dataset/stills/`;
2. registrar em `BENCHMARK.md` o número de frames avaliados, falhas de carga e
frames descartados separadamente;
3. confirmar o gate de heap WASM inicial. Se o heap inicial já ultrapassar a
meta de A4, interromper F2 para decidir entre build customizado e renegociação
da meta; não mascarar o problema adicionando a cascata;
4. confirmar o tempo até `ready` e registrar se o gate de carga de F1 foi
ultrapassado;
5. registrar a versão das anotações, a resolução do harness e os valores de
A1, erro de centro, `ms` e fps usados na decisão.

Só depois dessa execução a decisão sobre a cascata deve obedecer esta ordem:

| Resultado do gate Otsu | Escopo da F2 |
|---|---|
| Acurácia folgadamente acima de A1, após dataset válido | Implementar o score; a cascata pode ser mantida desativada por configuração de desenvolvimento. |
| Zona cinzenta de 80–88% | Expandir/analisar o dataset antes de decidir; não aprovar F2 com amostra insuficiente. |
| Abaixo de A1 após o dataset confirmado | Implementar e medir CLAHE → adaptive → Canny. |

A zona cinzenta tem prioridade sobre a decisão imediata: primeiro aumenta-se a
amostra e repete-se a medição. Se o resultado final atingir A1, a cascata não é
obrigatória para a saída da fase, mas o código deve permanecer planejado de
forma que possa ser habilitado para aparelhos ou condições específicas.

O gate é também um gate de **esforço**, não apenas de valor padrão. Se, após
uma amostra válida, Otsu atingir A1 e o score não regredir, a F2 implementa e
valida apenas Otsu/CLAHE + score; adaptive/Canny permanecem fora da implementação
da fase, protegidos pelo contrato `cascadeEnabled`, para uma futura fase
condicional. Se Otsu ficar abaixo de A1 após o dataset confirmado, a F2 inclui a
implementação e validação dos três caminhos. Assim, a decisão score-only
realmente economiza trabalho, em vez de apenas trocar uma flag no final.

Mesmo quando a cascata for opcional pelo gate, o score deve ser implementado,
pois ele corrige a seleção de candidatos e estabelece a confiança geométrica
usada pelas fases seguintes.

---

## 4. Contrato de saída da F2

O worker continuará emitindo um resultado compatível com a interface da F1:

```js
{
  type: 'result',
  found: Boolean,
  cx: Number,              // centro do bbox, normalizado 0..1
  cy: Number,              // centro do bbox, normalizado 0..1
  coverage: Number,        // área do contorno / área do frame
  bboxAspect: Number,      // largura / altura do bbox alinhado aos eixos
  tilt: Number,            // graus; calculado, mas ainda não usado no áudio
  touchesEdge: Boolean,
  confidence: Number,      // score final, normalizado 0..1
  score: Number,            // mesmo score, útil para diagnóstico do harness
  mode: 'otsu' | 'adaptive' | 'canny',
  ms: Number,
  wasmHeap: Number,
  width: Number,
  height: Number
}
```

Definir uma única constante no worker e reutilizá-la em todos os caminhos:

```js
const SCORE_FOUND_THRESHOLD = 0.45;
```

Esse valor tem deliberadamente os dois papéis: (a) permite que a cascata pare
cedo quando o modo atual já produziu um candidato suficiente e (b) define
`found: true` no resultado final. Não criar um segundo limiar para esses papéis
sem uma medição que justifique a separação; a coincidência é intencional e deve
ficar explícita no código e no benchmark.

Adicionar um comentário de alerta nos dois pontos de uso — no short-circuit da
cascata e na atribuição final de `found` — informando que alterar a constante
muda simultaneamente custo/latência e acurácia. Um futuro ajuste de performance
não pode ser feito silenciosamente como se fosse apenas uma otimização.

`score` pode ser omitido em uma build de produção se o contrato precisar ficar
mínimo, mas deve existir durante a validação para que o harness consiga
inspecionar a decisão. `confidence` deixa de ser o placeholder da F1 e passa a
ser o score geométrico.

CLAHE é pré-processamento, não uma quarta fonte de detecção. Portanto, um frame
processado com CLAHE e Otsu continua tendo `mode: 'otsu'`. Isso mantém o cache
de modo simples e não cria uma combinação de modos (`otsu-clahe`,
`adaptive-clahe`, etc.) que o `guide.js` teria de conhecer.

### 4.1 Configuração explícita da cascata

A decisão score-only versus cascata não deve virar uma constante ad hoc no meio
do worker. O worker deve aceitar, antes do primeiro frame, uma mensagem de
configuração:

```js
// main → worker
{ type: 'config', cascadeEnabled: Boolean }
```

Sem configuração, `cascadeEnabled` começa como `false`, preservando o
comportamento Otsu + score durante o gate e evitando que a medição de F1 seja
contaminada. Quando o gate demonstrar que a cascata é necessária, o
`FramingGuide` deve receber essa opção explicitamente no construtor ou em
`start()` e enviá-la ao worker antes de liberar frames. `false` significa
Otsu/CLAHE + score, sem adaptive/Canny; `true` habilita cache, probing e os
fallbacks da seção 5.4.

O harness deve enviar a mesma configuração para executar comparações F1
(`false`) e F2 (`true`) sobre o mesmo dataset. A escolha do valor padrão de
produção, depois do gate, deve ser registrada em `BENCHMARK.md`; não alterar
silenciosamente o default para fazer uma medição passar.

Quando nenhum candidato atingir o limiar, o worker ainda deve devolver o melhor
candidato geométrico encontrado, com `found: false` e o score correspondente.
Se nenhum contorno utilizável existir, devolver a forma sem candidato da F1,
com `score: 0`, `confidence: 0` e centro em `(0.5, 0.5)`.

---

## 5. Alterações no `frame-worker.js`

### 5.1 Recursos pré-alocados e ciclo de vida

Adicionar ao estado do worker:

- `clahe`, criado uma vez por conjunto de Mats com `cv.createCLAHE(2.0, new cv.Size(8, 8))`;
- `edges`, para a saída de `cv.Canny`;
- Mats temporários de média e desvio padrão usados por `cv.meanStdDev`, ou
uma alternativa equivalente que não aloque a cada frame;
- contador de frames e estado do cache: `cachedMode`, `framesSinceProbe` e
`probeCooldownFrames` para evitar repetir um probing caro em frames consecutivos.

Se `width` ou `height` mudar:

1. deletar todos os Mats do tamanho anterior, incluindo `clahe`, `edges` e
Mats estatísticos;
2. recriar o conjunto com o novo tamanho;
3. limpar o modo em cache, pois a mudança de resolução invalida a medição
anterior;
4. reiniciar o contador de reavaliação.

Os caminhos de exceção e de encerramento devem deletar cada Mat. Em especial,
continuar deletando os Mats individuais retornados por `contours.get(i)`;
`MatVector.delete()` não libera esses objetos individuais.

### 5.2 Pré-processamento e diagnóstico do Otsu

Para cada frame:

1. copiar o `ArrayBuffer` transferido para `src`;
2. converter RGBA para cinza;
3. medir o desvio padrão do cinza original;
4. se `std < 18`, aplicar CLAHE com clip limit `2.0` e grid `8×8`;
5. aplicar Gaussian blur `3×3` sobre o cinza que será usado pela cascata;
6. executar Otsu e guardar o limiar retornado por `cv.threshold`;
7. calcular uma medida de separabilidade entre classes para distinguir um
limiar aparentemente válido de uma divisão pouco informativa.

A separabilidade deverá ser a razão entre a variância entre classes e a
variância total do histograma (`eta = sigmaBetween² / sigmaTotal²`). O valor
inicial para considerar Otsu pouco confiável será documentado como constante
no worker e validado no dataset; não alterar esse limiar apenas para melhorar
um único caso. Além de `eta` baixo, Otsu será considerado suspeito quando o
limiar retornado for `< 40` ou `> 215`, conforme os dois planos.

Se Otsu for confiável e produzir um candidato com
`score >= SCORE_FOUND_THRESHOLD`, ele será aceito sem executar os fallbacks.
Se o limiar for extremo, a separabilidade for baixa ou o candidato não atingir
essa constante, seguir para a próxima estratégia.

O teste de confiabilidade do Otsu não é uma etapa global que sempre precede o
cache. Ele só é aplicado quando Otsu é a estratégia que está sendo tentada.
Assim, a precedência fica definida: em um frame de operação normal, tentar
primeiro `cachedMode`; se ele produzir `score >= SCORE_FOUND_THRESHOLD`, parar
sem rodar Otsu. Em um frame de probing — primeiro frame, a cada 10 frames ou
após falha — ignorar a prioridade do cache e usar a ordem fixa
`otsu → adaptive → canny`; nessa ordem, Otsu pode parar cedo somente se passar
pelo teste de confiabilidade e pelo limiar único de score. Se o cache for
`adaptive` ou `canny`, não executar Otsu como pré-teste antes do modo cacheado.

### 5.3 Implementação das estratégias

Criar funções internas pequenas e testáveis, sem duplicar a análise de
contornos:

- `runOtsu()`:
  `threshold(blur, bin, 0, 255, THRESH_BINARY | THRESH_OTSU)` e retorno do
  limiar, separabilidade e máscara.
- `runAdaptive()`:
  `adaptiveThreshold(blur, bin, 255, ADAPTIVE_THRESH_GAUSSIAN_C,
  THRESH_BINARY, 31, 5)`.
- `runCanny()`:
  `Canny(blur, edges, 50, 150)` seguido de `dilate(edges, bin, kernel3x3)`.

Para cada máscara, aplicar o fechamento morfológico `MORPH_CLOSE` com o kernel
`5×5` antes de procurar contornos. No Canny, a dilatação deve ocorrer antes
do fechamento para unir trechos da borda da folha.

O fechamento deve reutilizar `bin` e os kernels existentes. Nenhum `cv.Mat`
deve ser criado por frame sem ser liberado no mesmo frame ou sem fazer parte
do conjunto explicitamente pré-alocado.

### 5.4 Cache do modo

Quando `cascadeEnabled === true`, o worker deve evitar executar a cascata inteira
em todos os frames. A precedência entre o cache e o short-circuit do Otsu deve
ser implementada como esta tabela, que é a fonte normativa antes do código.
Quando `cascadeEnabled === false`, executar somente Otsu/CLAHE + score e não
criar probing nem cache de modo.

| Estado/resultado | Próxima ação |
|---|---|
| Primeiro frame, resize ou probing periódico | Ignorar o cache; tentar `otsu → adaptive → canny`. Otsu só encerra se for confiável e `score >= SCORE_FOUND_THRESHOLD`. |
| Frame normal com `cachedMode = otsu` | Tentar Otsu; se limiar/separabilidade e score passarem, emitir. Caso contrário, tentar `adaptive` e depois `canny`. |
| Frame normal com `cachedMode = adaptive` | Tentar adaptive; se o score passar, emitir sem pré-testar Otsu. Caso contrário, tentar `otsu` e `canny`. |
| Frame normal com `cachedMode = canny` | Tentar Canny; se o score passar, emitir sem pré-testar Otsu. Caso contrário, tentar `otsu` e `adaptive`. |
| Modo tentado produz score abaixo do limiar ou nenhum candidato | Não emitir sucesso desse modo; continuar na ordem da linha aplicável e manter o melhor candidato para o resultado final. |
| Qualquer probing atinge o deadline | Interromper novas tentativas, emitir o melhor candidato disponível, invalidar o cache e iniciar `probeCooldownFrames`. |
| Modo produz score suficiente | Emitir o candidato, atualizar `cachedMode` para esse modo e não executar os modos seguintes. |

A tabela resolve explicitamente a divergência entre cache e Otsu: o cache manda
em frames normais; a ordem fixa de probing manda nos frames de reavaliação.

A reavaliação periódica é necessária para acompanhar mudanças de iluminação,
distância e fundo. O cache é uma otimização, não uma decisão permanente. A
reavaliação ocorre no primeiro frame, a cada 10 frames e imediatamente depois
de uma falha do modo cacheado.

Para limitar o custo de um probing, definir uma salvaguarda explícita:

```js
const CASCADE_PROBE_BUDGET_MS = 100;
```

O orçamento começa no `t0` do frame. Antes de iniciar cada modo e durante a
varredura dos contornos, verificar `performance.now() < deadline`. Ao atingir
o deadline, interromper novas tentativas, devolver o melhor candidato já
extraído (ou nenhum candidato), marcar o cache como inválido e definir dois
frames de `probeCooldownFrames`. Durante esse cooldown, executar somente Otsu
e só depois voltar ao probing completo. Isso evita repetir três pipelines em todos os
frames quando o aparelho não consegue completar a reavaliação.

O guard é cooperativo: não pode interromper uma chamada OpenCV já em execução,
mas impede iniciar o próximo modo e deve ser consultado entre operações e no
loop de contornos. `CASCADE_PROBE_BUDGET_MS` é um **suborçamento do worker**,
não um teto independente que possa ser somado livremente ao A2. O orçamento
completo deve ser medido como:

```text
A2_frame = captura + getImageData + transferência + workerMs
            + dispatch do resultado + feedback
A2_frame <= 150 ms
workerMs <= CASCADE_PROBE_BUDGET_MS = 100 ms
```

Os demais termos têm, portanto, uma reserva inicial de até 50 ms. Se a medição
mostrar que captura, transferência ou feedback consomem mais que essa reserva,
reduzir o suborçamento ou a resolução/throttle; não declarar A2 aprovado apenas
porque `workerMs <= 100`. O guard é cooperativo e não aprovação de A2; deve ser
medido e ajustado somente com os dados do aparelho de referência. Ele também
deve ser aplicado quando uma falha de cache dispara a cascata no meio do frame.

A análise deve conservar o melhor candidato de todas as tentativas feitas no
frame. Assim, um resultado parcial de baixo score não é perdido se todas as
estratégias falharem, mas também não impede que uma estratégia posterior seja
tentada enquanto ainda houver orçamento. A ordem de fallback remove duplicatas:
se o cache for `adaptive`, a ordem normal é `adaptive → otsu → canny`; em um
probing, volta a ser `otsu → adaptive → canny`.

---

## 6. Seleção e score geométrico

### 6.1 Extração de candidatos

Criar uma função comum, usada por Otsu, adaptive e Canny, que:

1. execute `findContours(..., RETR_EXTERNAL, CHAIN_APPROX_SIMPLE)`;
2. ignore contornos com área menor que `8%` da área do frame para a seleção
principal e para o fallback parcial;
3. enquanto o contorno ainda existir, calcule `cv.moments(contour)` e derive o
centroide normalizado para `centerBias`; copie esse valor para o candidato;
4. calcule `perimeter` e `approxPolyDP(contour, approx, 0.02 * perimeter, true)`;
5. marque como quadrilátero válido somente `approx.rows === 4` e
`cv.isContourConvex(approx)`;
6. calcule o hull e a convexidade;
7. extraia os pontos para objetos JavaScript simples antes de liberar os Mats;
8. libere, em `finally`, o contorno individual, `approx` e `hull` de cada
iteração.

O candidato não deve manter uma referência a um Mat depois que a função
retornar. Isso evita repetir o vazamento de `best` corrigido durante a revisão
da F1 e simplifica o `finally` do frame.

Se não houver quadrilátero válido, usar `minAreaRect` do maior contorno
qualificado como candidato parcial. "Qualificado" significa que o contorno
passou pelo mesmo filtro de área `>= 8%` do frame; não usar um contorno menor
apenas para fabricar uma detecção parcial. Se nenhum contorno passar esse
filtro, não há candidato parcial. Os quatro pontos do retângulo rotacionado
devem ser convertidos para objetos JavaScript e usados somente para métricas;
`found` continuará dependendo do score final.

Se houver vários quadriláteros, avaliar todos, em vez de escolher
prematuramente o de maior área. Isso permite rejeitar uma folha pequena mas
geometricamente plausível quando um falso retângulo muito grande domina a
imagem, ou vice-versa.

### 6.2 Componentes do score

Implementar exatamente os pesos especificados:

```text
score = 0.40 * areaNorm
      + 0.25 * aspectScore
      + 0.20 * convexityScore
      + 0.15 * centerBias
```

Componentes:

- `areaNorm = min(contourArea / frameArea, 0.85)`;
- `aspectScore`: proximidade da proporção ISO A4 em qualquer orientação,
comparando a razão orientada do `minAreaRect` com `1.414` e `0.707`; a melhor
comparação recebe a pontuação. Dentro da tolerância de `±25%`, a pontuação
cai linearmente até zero fora da tolerância;
- `convexityScore = contourArea / hullArea`, limitado ao intervalo `0..1`;
- `centerBias = 1 - distância normalizada do centroide ao centro do frame`,
limitado ao intervalo `0..1`.

A razão usada no score deve ser a do retângulo orientado, não apenas a razão do
bbox alinhado, para que uma folha inclinada não seja penalizada duas vezes.
`bboxAspect` de saída continua sendo largura/altura do bbox alinhado, mantendo
o contrato da F1.

O centroide para `centerBias` pode ser calculado com `cv.moments` enquanto o
contorno ainda estiver disponível. `cx` e `cy` de saída continuam sendo o
centro do bbox dos pontos selecionados, como na F1; a diferença deve ser
registrada no comentário do código.

Extrair a fórmula numérica para um helper puro em
`js/framing/score.js`, sem dependência de DOM, OpenCV ou estado do worker. O
worker clássico carrega esse helper com `importScripts('./score.js')` — relativo à
URL de `js/framing/frame-worker.js` — e o harness o carrega como script clássico
para executar os testes determinísticos. O helper deve
expor funções puras para normalizar/saturar `areaNorm`, calcular
`aspectScore`, limitar `convexityScore`/`centerBias` e aplicar os pesos fixos em
`computeScore(parts)`. Como o mesmo arquivo roda nos dois contextos, não usar
`export` ESM: encapsular as funções e anexar explicitamente o objeto aos dois
globais com um padrão compatível com script clássico:

```js
(function (root) {
  // declara as funções puras neste escopo
  root.ScoreLib = { computeScore, areaNorm, aspectScore, clamp01 };
})(typeof self !== 'undefined' ? self : window);
```

No worker, consumir `self.ScoreLib`; no harness, consumir `window.ScoreLib` (ou
`globalThis.ScoreLib`). O worker fornece os dados geométricos, e a decisão
`found` continua usando a constante do worker.

Escolher o candidato com maior score. Declarar:

```js
found = score >= SCORE_FOUND_THRESHOLD;
confidence = score;
```

`SCORE_FOUND_THRESHOLD` é o limiar único de F2 e não deve ser substituído pelo
limiar de estabilização da F3.

### 6.3 Métricas derivadas

Para o candidato escolhido:

- `coverage` é a área do contorno dividido pela área do frame;
- `bboxAspect` é a razão do bbox alinhado aos eixos;
- `tilt` vem do `minAreaRect`, preservando o comportamento já disponível na F1;
- `touchesEdge` é verdadeiro se qualquer ponto estiver a até 2 px da borda,
com a mesma convenção da F1 (`x <= 2`, `y <= 2`, `x >= w - 3` ou
`y >= h - 3`);
- `mode` é a estratégia que produziu o candidato escolhido;
- `ms` mede toda a execução do frame, incluindo tentativas extras da cascata;
- `wasmHeap` continua sendo reportado para os gates de memória.

---

## 7. Alterações no `guide.js`

A mudança deve ser mínima e preservar o fallback:

1. substituir a comparação exata `mode === 'otsu'` por uma validação de conjunto
para os modos do worker: `otsu`, `adaptive` e `canny`;
2. continuar aceitando apenas `mode === 'heuristic'` quando a fonte ativa for o
fallback;
3. descartar resultados atrasados de um worker depois de um erro ou troca de
fonte;
4. garantir que um resultado `adaptive` ou `canny` alimente as mesmas estatísticas,
throttle e `audio.update()` que um resultado Otsu;
5. preservar `activeSource`, `workerStats`, `inFlight` e o fallback permanente;
6. aceitar `cascadeEnabled` como opção explícita do `FramingGuide` e enviar
`{ type: 'config', cascadeEnabled }` ao criar/reutilizar o worker, sempre antes
de enviar o primeiro frame. O valor padrão permanece `false` até o gate decidir
que a cascata deve ser ativada; se o gate exigir adaptive/Canny, `app.js` deve
passar `true` na construção do `FramingGuide` ou em `start()`.

Se necessário, associar os handlers a uma geração/instância do worker para que
uma mensagem atrasada do worker antigo não seja aceita depois de uma
reinicialização. Não alterar ainda o fluxo de estabilização ou a semântica do
áudio da F3/F4.

O `guide.js` não deve inferir que `mode: 'adaptive'` significa fallback; os três
modos são algoritmos do mesmo worker.

---

## 8. Alterações no harness e no benchmark

### 8.1 `harness.html`

- Atualizar o título e os rótulos de F1 para mencionar F2/cascata.
- Carregar `js/framing/score.js` como script clássico antes do módulo do
harness.
- Adicionar um botão "Testar score puro" que execute os casos da seção 9.1 e
mostre falhas no log.
- Manter o botão Otsu para comparação reproduzível da F1 e enviar
`{ type: 'config', cascadeEnabled: false }`.
- Adicionar um botão ou opção explícita para rodar o worker com a cascata F2,
enviando `cascadeEnabled: true`, sem destruir o worker reutilizado entre
execuções.
- Mostrar no log a distribuição de modos (`otsu`, `adaptive`, `canny`) e o
score médio/mediano, quando disponível.
- O wrapper deve aceitar qualquer modo de worker válido e continuar tratando
`notready`, erro e frames descartados separadamente.

Para comparar F1 e F2 honestamente, a execução Otsu deve continuar disponível,
com a mesma resolução, mesmo índice e mesmas anotações.

### 8.2 `test-harness.js`

Estender `runStills` sem quebrar o contrato atual:

- contabilizar quantos resultados vieram de cada `mode`;
- coletar `score`/`confidence` para mediana e p95, se o campo existir;
- manter `foundAccuracy`, erro de centro, `touchesEdgeAccuracy`, load failures e
discarded separados;
- manter `frameMs` separado de `stats.medianMs`, pois o primeiro inclui o
round-trip do worker e o segundo é a métrica registrada pela fonte;
- incluir o modo usado no callback de progresso para diagnosticar os casos em
que a cascata foi acionada.

A comparação com ground truth continua usando a definição de A1 existente.
Não transformar `found: false` com score baixo em frame descartado.

### 8.3 `sw.js`

Como `frame-worker.js` carregará `js/framing/score.js` via `importScripts`,
adicionar o helper à lista `ASSETS` para preservar o modo de precisão offline.
Bump a versão do cache de aplicação conforme a convenção existente (`v3` para
`v4` ou a próxima versão real no momento da implementação). O cache separado do
vendor não deve ser alterado.

### 8.4 `BENCHMARK.md`

Adicionar uma seção F2 com duas tabelas:

1. comparação F1 Otsu × F2 cascata × baseline heurístico;
2. distribuição de modos e custo da cascata.

Registrar, no mínimo:

- dataset, versão das anotações e número de frames avaliados;
- acurácia de `found`;
- erro de centro mediano e médio;
- acurácia de `touchesEdge`;
- distribuição de `mode`;
- score mediano e p95;
- `ms` mediano, p95 e máximo;
- `frameMs` médio/mínimo/máximo do harness;
- fps efetivo;
- heap WASM inicial e após a janela de teste;
- taxa de frames descartados e falhas de carregamento.

A5 não deve ser preenchido na F2: `PRONTO` ainda não é um estado do
estabilizador. A8 também só deve ser recalculado se a alteração de custo for
relevante e os termos de áudio estiverem medidos.

---

## 9. Estratégia de validação

### 9.1 Validação estática e teste unitário puro

- `node --check` em todos os arquivos JavaScript alterados.
- Verificar que `frame-worker.js` continua sendo um worker clássico, sem
`import`, `export` ou top-level `await`.
- Verificar que `score.js` não usa export ESM e expõe `ScoreLib` tanto no
`self` do worker quanto no `window`/`globalThis` do harness.
- Verificar que o vendor carregado pelo `importScripts` permanece o mesmo
arquivo versionado e que não há dependência nova.
- Revisar todos os caminhos de `delete()` dos Mats adicionados e temporários.
- Executar no harness o teste unitário de `js/framing/score.js`, sem dataset,
OpenCV ou Worker, cobrindo:
  - soma ponderada de um vetor conhecido;
  - saturação de `areaNorm` em `0.85`;
  - proporção A4 em orientação normal e invertida;
  - limites interno e externo da tolerância de `±25%`;
  - `convexityScore` e `centerBias` nos limites `0` e `1`;
  - monotonicidade: melhorar um componente não pode reduzir o score;
  - separação entre score numérico e `found`, que usa
  `SCORE_FOUND_THRESHOLD` no worker.

O teste deve falhar com mensagem identificável e ser executável por um botão ou
função explícita do harness; não depender de inspeção visual de uma foto.

### 9.2 Testes funcionais no harness

Executar na mesma sessão e com o mesmo dataset:

1. baseline FallbackDetector;
2. worker Otsu puro;
3. worker com score, mantendo apenas Otsu;
4. worker com cascata habilitada.

Verificar visualmente e pelos logs:

- fundo de alto contraste;
- papel branco sobre mesa branca ou madeira clara;
- iluminação desigual, sombra e contraluz;
- folha inclinada em 15° e 30°;
- folha parcial tocando a borda;
- dois papéis no quadro;
- desenho denso e folha quase vazia;
- ausência de folha e falsos retângulos no fundo.

Confirmar que cada modo é acionado quando esperado e que um score baixo
retorna `found: false`, sem ser contado como frame perdido.

### 9.3 Testes de ciclo de vida e memória

- alternar `start()`/`stop()` sem recriar o worker a cada toggle;
- mudar a resolução entre 160 px e 120 px e confirmar que o conjunto de Mats é
recriado sem erro;
- processar pelo menos 1000 frames, incluindo cenas com vários contornos e
alternância entre os três modos;
- confirmar que o heap WASM não cresce continuamente depois do aquecimento;
- exercitar erro de `findContours`, erro de inicialização e `onmessageerror`,
confirmando retorno ao fallback;
- confirmar que o worker não entrega um resultado de modo inválido ao
`FramingGuide`.

A contagem formal de Mats permanece um gate de F6, mas F2 não pode introduzir
um crescimento evidente ou deixar um Mat vivo por candidato/contorno.

### 9.4 Validação de desempenho

Medir desktop e, quando disponível, o aparelho Android de referência:

- registrar a largura/altura do frame junto com toda métrica;
- comparar `ms` Otsu contra `ms` da cascata;
- observar p95 e máximo, não somente a média;
- verificar que o `CASCADE_PROBE_BUDGET_MS` interrompe um probing longo e
retorna o melhor candidato disponível, sem bloquear o loop;
- verificar se o throttle existente reage ao custo real sem quebrar o feedback;
- confirmar que o acréscimo da cascata não inviabiliza A2/A3. O guard é uma
salvaguarda de design, não substitui a medição no aparelho de referência.

Não declarar A2, A3 ou A4 aprovados somente com desktop. Esses critérios
continuam pendentes de medição no aparelho definido pelo plano-mãe.

---

## 10. Critérios de saída da F2

A F2 poderá ser considerada concluída quando todos os itens aplicáveis abaixo
estiverem satisfeitos:

- [ ] `dataset/stills/` contém um conjunto F0 validado (atualmente 73 stills),
`dataset/index.json` é carregável e a execução de fumaça do harness passou.
- [ ] O gate de entrada de F1 foi realmente executado; seus números foram
registrados em `BENCHMARK.md` e não há bloqueio de heap/carga.
- [ ] Score implementado com pesos `0.40 / 0.25 / 0.20 / 0.15`, usando a
constante única `SCORE_FOUND_THRESHOLD = 0.45` documentada.
- [ ] CLAHE, adaptive e Canny estão pré-alocados/reutilizados conforme o
caminho executado, sem vazamentos conhecidos.
- [ ] O cache de modo funciona, é reavaliado a cada aproximadamente 10 frames
e é invalidado após falha ou resize.
- [ ] `cascadeEnabled` está definido no contrato, tem default documentado e é
enviado antes do primeiro frame; o harness consegue reproduzir F1 e F2 com a
flag explícita.
- [ ] O `guide.js` aceita todos os modos do worker e mantém o fallback quando o
worker falha.
- [ ] O `CASCADE_PROBE_BUDGET_MS` é tratado como suborçamento do A2, com
cooldown após estouro e medição dos demais termos do frame.
- [ ] O harness compara F1 e F2 no mesmo dataset e reporta modo, score,
acurácia, erro de centro, custo e descartes.
- [ ] Se a cascata foi necessária, a acurácia final de `found` atinge A1
(≥85%) no dataset confirmado.
- [ ] Se o gate Otsu já atingiu A1, o score sozinho não reduz a acurácia abaixo
do resultado de F1 e a decisão de não habilitar a cascata por padrão está
registrada.
- [ ] O resultado parcial é reportado com `found: false` quando apropriado;
nenhuma detecção parcial vira PRONTO — essa decisão só existe após F3.
- [ ] Sintaxe, fallback, troca de resolução, erro do worker e teste prolongado
foram verificados.
- [ ] As medições que dependem de dataset físico ou aparelho permanecem
marcadas como `[PENDENTE]`, sem transformar proxy em aprovação.

---

## 11. Fora de escopo

Não implementar durante F2:

- `stabilizer.js`, EMA, histerese ou debounce temporal;
- máquina de estados `SEM_FOLHA`/`PARCIAL`/`PRONTO`;
- mudança de vocabulário, cooldown ou prioridade de TTS;
- pulsação, orientação, `voiceschanged` ou novos efeitos de áudio;
- vibração e toggles de acessibilidade;
- pausa por visibilidade, otimizações térmicas e auditoria formal de 1000 Mats
como gate de F6;
- testes com usuários cegos e medição A6.

---

## 12. Ordem de implementação

1. **Bloqueador obrigatório:** validar os 73 stills locais, o
`dataset/index.json`, executar o smoke test do harness e rodar o gate F1 de
FallbackDetector × Otsu. Enquanto o gate não for executado e os campos F1 de
`BENCHMARK.md` estiverem `[PENDENTE]`, não iniciar a implementação nem aplicar
a tabela de decisão. Se os arquivos ou anotações atuais não cobrirem a matriz
F0, corrigir o dataset antes de medir; não iniciar F2 com uma amostra enviesada.
2. Adicionar os Mats/objetos de ciclo de vida e corrigir o pré-alocamento de
CLAHE.
3. Extrair a análise comum de contornos e implementar o score, inicialmente
com Otsu apenas.
4. Atualizar contrato, confiança, `cascadeEnabled` e métricas; validar Otsu +
score contra F1.
5. **Somente se Otsu ficar abaixo de A1:** implementar adaptive e Canny usando o
mesmo avaliador de candidatos.
6. **Somente se a cascata estiver habilitada:** implementar cache, probing
periódico, cooldown e invalidação por falha/resize.
7. Atualizar `guide.js` para os modos realmente implementados e proteger
resultados atrasados.
8. Atualizar harness, `sw.js` e `BENCHMARK.md`, mantendo as execuções
`cascadeEnabled: false` e, quando aplicável, `true`.
9. Rodar validações estáticas, teste unitário do score, validações funcionais,
de memória e de desempenho.
10. Registrar no `BENCHMARK.md` a decisão final de escopo e o valor padrão de
`cascadeEnabled`; não adiar essa decisão para uma flag implícita no código.

---

## 13. Entregáveis

### Arquivos modificados

- `js/framing/frame-worker.js`
- `js/framing/score.js` — helper clássico compartilhado da fórmula pura e dos
casos de teste
- `js/framing/guide.js`
- `js/framing/test-harness.js`
- `harness.html`
- `sw.js` — precache de `score.js` e bump do cache de aplicação
- `BENCHMARK.md`

### Arquivos que só mudam condicionalmente

- `app.js`, somente se o gate exigir ativar `cascadeEnabled: true` na criação ou
no `start()` do `FramingGuide`; no caminho score-only, não deve mudar.

### Arquivos que não devem mudar por causa da F2

- `js/framing/fallback-detector.js`;
- `js/framing/audio.js`;
- `js/speech.js`;
- vendor OpenCV, que continua sendo servido pelo cache separado da F1.

### Resultado esperado

O app passa a identificar candidatos de folha com maior robustez em baixo
contraste quando a cascata for exigida pelo gate, usando o caminho barato que
funcionou no frame anterior e uma seleção geométrica explicável. No caminho
score-only, entrega Otsu/CLAHE + score sem implementar fallbacks desnecessários.
A saída permanece intercambiável com o fallback e pronta para receber o
estabilizador da F3 sem acoplar a lógica temporal ao worker.

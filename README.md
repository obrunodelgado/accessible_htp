# Leitor de Desenho Projetivo — Protótipo (Câmera → IA → Voz)

PWA simples (HTML/JS puro) que tira uma foto de um desenho projetivo (HTP, DFH etc.),
envia para o Gemini e lê em voz alta uma descrição objetiva + hipóteses interpretativas
(nunca diagnóstico). Feito para ser operável sem depender de enxergar a tela.

**Fora de escopo neste protótipo:** login, histórico de pacientes, exportação de laudo em PDF.

## Arquivos

- `index.html` — interface (botões grandes, alto contraste, aria-labels)
- `app.js` — captura de câmera, chamada à API Gemini, voz (fala + comando de voz)
- `js/framing/guide.js` — guia de enquadramento (coordena detector + áudio + UX fallback)
- `js/framing/yolo-worker.js` — detector principal: YOLOv8n via onnxruntime-web (Web Worker)
- `js/framing/frame-worker.js` — detector fallback: OpenCV.js (cascata Otsu/adaptive/Canny + score)
- `js/framing/fallback-detector.js` — detector heurístico (brilho/bordas) — último fallback
- `js/framing/audio.js` — feedback de voz do guia (TTS com cooldowns, sem oscilador)
- `js/framing/score.js` — score geométrico para o pipeline OpenCV (F2)
- `js/speech.js` — fila de utterances com prioridade (STATUS > GUIDE)
- `vendor/paper-yolov8n.onnx` — modelo YOLOv8n treinado (12MB, 1 classe: paper_sheet)
- `vendor/ort.min.js` + `vendor/ort-wasm-*.wasm` — onnxruntime-web (WASM, ~20MB)
- `vendor/opencv-4.13.0.js` — OpenCV.js (fallback, 128MB WASM heap)
- `manifest.json` / `sw.js` / `icon-192.png` / `icon-512.png` — PWA instalável e cache offline
- `scripts/prepare-yolo-dataset.py` — converte dataset/index.json para formato YOLO
- `scripts/gate-f2.mjs` — gate de validação do pipeline OpenCV (Node proxy)
- `scripts/gate-yolo-browser.html` — gate de validação do YOLO no browser
- `dataset/` — stills anotados + dataset YOLO (train/val split)
- `BENCHMARK.md` — medições detalhadas (F0→F3)

## 1. Obter uma chave gratuita do Gemini

1. Acesse **https://aistudio.google.com/apikey** (Google AI Studio).
2. Faça login com uma conta Google.
3. Clique em **"Create API key"** (ou "Criar chave de API").
4. Copie a chave gerada (começa com `AIza...`).
5. O free tier do `gemini-2.5-flash` tem cota gratuita diária generosa — suficiente para testar o protótipo. Consulte os limites atuais em https://ai.google.dev/pricing.

⚠️ Nunca coloque a chave direto no código. Neste protótipo, ela é digitada pelo usuário
na própria tela do app e fica salva apenas no `localStorage` do navegador (local, não vai para nenhum servidor seu).

## 2. Rodar localmente (teste rápido)

Câmera exige HTTPS ou `localhost`. Para testar local:

```bash
cd pasta-do-projeto
python3 -m http.server 8080
```

Abra `http://localhost:8080` no navegador do celular ou computador.

## 3. Deploy gratuito

### Opção A — GitHub Pages
1. Crie um repositório novo no GitHub e suba estes arquivos (`index.html`, `app.js`, `manifest.json`, `sw.js`, ícones).
2. Vá em **Settings → Pages** → Source: branch `main`, pasta `/root`.
3. Aguarde alguns minutos; o link será `https://SEU_USUARIO.github.io/SEU_REPO/`.

### Opção B — Netlify
1. Crie conta em https://app.netlify.com.
2. Arraste a pasta do projeto em "Deploy manually" (drag & drop) na tela inicial.
3. Pronto — Netlify gera uma URL HTTPS automaticamente.

### Opção C — Vercel
1. Crie conta em https://vercel.com.
2. `npm i -g vercel` e rode `vercel` dentro da pasta do projeto (ou conecte o repositório GitHub pelo painel).
3. Confirme as opções padrão (projeto estático, sem build step).

Qualquer uma das três opções entrega HTTPS automaticamente — necessário para câmera, voz e instalação como PWA.

## 4. Usando o app

1. Abra o link publicado.
2. Toque em **"Configurar chave da API do Gemini"**, cole a chave, toque em **Salvar chave**.
3. Toque em **"Tirar foto do desenho"** (ativa a câmera) e toque de novo para capturar.
4. Aguarde a análise — o app fala automaticamente quando estiver pronta.
5. Toque em **"Repetir leitura"** para ouvir de novo, ou use **"Comando de voz"** e diga *"foto"*, *"repetir"* ou *"tentar novamente"*.
5b. Com a câmera ligada, o **guia sonoro de enquadramento** analisa a imagem ao vivo com um modelo YOLOv8n (IA) e dá feedback **só por voz**: "aproxime", "afaste", "câmera para a esquerda/direita/cima/baixo", "pronto, pode capturar" ou "folha não encontrada". O modelo é pré-carregado ao abrir a página (12MB) e roda em Web Worker (onnxruntime-web WASM). Pode ser desligado no botão **"Guia sonoro de enquadramento"**.
6. Para instalar como app (ícone na tela inicial), use a opção "Adicionar à tela inicial" / "Instalar app" do navegador.

## 5. Limitações conhecidas do protótipo

- Sem autenticação/histórico — cada sessão é independente.
- Detecção de foto escura é uma heurística simples (brilho médio); não substitui checagem visual real.
- Reconhecimento de voz (`SpeechRecognition`) tem suporte variável entre navegadores (funciona bem no Chrome desktop/Android; suporte limitado no Firefox e em iOS Safari).
- O modelo YOLOv8n foi treinado em 103 stills — generalização para condições não vistas (iluminação diferente, folhas coloridas, múltiplas folhas) precisa de validação com dataset expandido.
- Inference do YOLO no aparelho-alvo (Moto E / Redmi 9A) ainda não foi medido — estimativa ~150-300ms (vs 63ms no desktop).
- As respostas do Gemini são **apoio técnico** — a decisão clínica é sempre do profissional.

## 6. Guia de enquadramento (detalhes técnicos)

O guia usa uma arquitetura em camadas:

1. **YOLOv8n (detector principal)** — modelo ONNX 12MB, 1 classe `paper_sheet`, roda em Web Worker via onnxruntime-web (WASM). Gate browser: 99% acurácia, 100% sensibilidade, 96.7% especificidade, 63ms mediana (Safari desktop). Pré-carregado ao abrir a página.
2. **OpenCV.js (fallback)** — cascata Otsu→adaptive→Canny + score geométrico. 69.9% acurácia, 0% especificidade (limitação estrutural: score mede forma, não conteúdo). Usado só se o YOLO falhar ao carregar.
3. **Heurístico (último fallback)** — limiar de brilho/bordas. Usado se ambos os workers falharem.

Características do feedback:
- **Só voz** (oscilador removido — buzz era irritante)
- **Histerese temporal**: 3 frames consecutivos com detecção antes de reportar "found" (evita oscilação)
- **Cooldowns**: "Folha não encontrada" a cada 8s, direções a cada 3s, "Pronto" com lock de 5s
- **UX fallback**: se o usuário não atinge "Pronto" em 15s, sugere "aproxime a folha"

Ver `BENCHMARK.md` para medições completas (F0→F3).

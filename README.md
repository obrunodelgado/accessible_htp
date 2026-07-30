# Leitor de Desenho Projetivo — Protótipo (Câmera → IA → Voz)

PWA simples (HTML/JS puro) que tira uma foto de um desenho projetivo (HTP, DFH etc.),
envia para o Gemini e lê em voz alta uma descrição objetiva + hipóteses interpretativas
(nunca diagnóstico). Feito para ser operável sem depender de enxergar a tela.

**Fora de escopo neste protótipo:** login, histórico de pacientes, exportação de laudo em PDF.

## Arquivos

- `index.html` — interface (botões grandes, alto contraste, aria-labels)
- `app.js` — captura de câmera, chamada à API Gemini, voz (fala + comando de voz)
- `manifest.json` / `sw.js` / `icon-192.png` / `icon-512.png` — PWA instalável e cache offline básico

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
6. Para instalar como app (ícone na tela inicial), use a opção "Adicionar à tela inicial" / "Instalar app" do navegador.

## 5. Limitações conhecidas do protótipo

- Sem autenticação/histórico — cada sessão é independente.
- Detecção de foto escura é uma heurística simples (brilho médio); não substitui checagem visual real.
- Reconhecimento de voz (`SpeechRecognition`) tem suporte variável entre navegadores (funciona bem no Chrome desktop/Android; suporte limitado no Firefox e em iOS Safari).
- As respostas do Gemini são **apoio técnico** — a decisão clínica é sempre do profissional.

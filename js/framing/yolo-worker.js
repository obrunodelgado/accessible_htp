/* =========================================================================
   yolo-worker.js — Worker clássico com YOLOv8n via onnxruntime-web

   Detector principal de folha de papel (substitui o pipeline OpenCV.js
   da F2 para especificidade). Worker clássico (não módulo) — usa
   importScripts para carregar o onnxruntime-web.

   Contrato de mensagens (compatível com frame-worker.js):
   - Entrada: { type:'config', conf } antes do primeiro frame.
   - Entrada: { type:'frame', width, height, buffer } — RGBA ImageData.
   - Saída: { type:'ready' } quando o modelo carrega.
   - Saída: { type:'notready' } se frame chega antes do modelo.
   - Saída: { type:'result', found, cx, cy, coverage, bboxAspect, tilt,
       touchesEdge, confidence, score, mode:'yolo', ms, wasmHeap, width, height }
   - Saída: { type:'error', message } em erro fatal.

   Métricas de saída mapeiam o contrato do frame-worker para o guide.js
   consumir sem mudanças: cx/cy em [0,1], coverage = área do bbox / área
   do frame, touchesEdge = bbox toca borda, tilt = 0 (YOLO não dá ângulo),
   confidence = confiança da detecção, score = confidence (alias).

   Modelo: vendor/paper-yolov8n.onnx (12MB, YOLOv8n, 1 classe paper_sheet,
   imgsz=320, exportado com opset=12). Treinado em 103 stills (73 pos +
   30 neg), gate browser: 99% acurácia, 96.7% especificidade, 63ms med.
   ========================================================================= */

// onnxruntime-web é carregado via importScripts no init.
var ort = null;
var session = null;
var ready = false;

var IMGSZ = 320;
var CONF_THRESHOLD = 0.35;
var inputName = 'images';
var outputName = 'output0';

// Pré-aloca o tensor de input [1, 3, 320, 320] float32.
var inputTensor = null;

function initInputTensor() {
  inputTensor = new Float32Array(1 * 3 * IMGSZ * IMGSZ);
}

/**
 * Pré-processamento: RGBA ImageData → tensor NCHW [1,3,320,320] float32 0..1.
 * Resize via canvas interno do worker (OffscreenCanvas se disponível, senão
 * resize manual nearest-neighbor no tensor).
 */
function preprocess(rgba, w, h) {
  // Se o frame já é 320x320, copia direto. Senão, resize no tensor.
  // Nearest-neighbor é suficiente — o YOLO é robusto a resize.
  if (w === IMGSZ && h === IMGSZ) {
    for (var y = 0; y < IMGSZ; y++) {
      for (var x = 0; x < IMGSZ; x++) {
        var si = (y * IMGSZ + x) * 4;
        var di = y * IMGSZ + x;
        inputTensor[di] = rgba[si] / 255.0;
        inputTensor[IMGSZ * IMGSZ + di] = rgba[si + 1] / 255.0;
        inputTensor[2 * IMGSZ * IMGSZ + di] = rgba[si + 2] / 255.0;
      }
    }
    return;
  }

  // Resize nearest-neighbor: mapeia coords do tensor para coords da imagem.
  var xRatio = w / IMGSZ;
  var yRatio = h / IMGSZ;
  for (var y2 = 0; y2 < IMGSZ; y2++) {
    var sy = Math.min(h - 1, Math.floor(y2 * yRatio));
    for (var x2 = 0; x2 < IMGSZ; x2++) {
      var sx = Math.min(w - 1, Math.floor(x2 * xRatio));
      var si = (sy * w + sx) * 4;
      var di = y2 * IMGSZ + x2;
      inputTensor[di] = rgba[si] / 255.0;
      inputTensor[IMGSZ * IMGSZ + di] = rgba[si + 1] / 255.0;
      inputTensor[2 * IMGSZ * IMGSZ + di] = rgba[si + 2] / 255.0;
    }
  }
}

/**
 * Pós-processamento: output YOLOv8 [1, 5, 2100] → detecções.
 * Formato: [cx, cy, w, h, conf] por anchor, normalizado em [0, IMGSZ].
 * Retorna a detecção de maior confiança acima do threshold, ou null.
 */
function postprocess(outputData) {
  // output shape: [1, 5, 2100] — 5 = 4 bbox + 1 class conf
  var numAnchors = 2100;
  var bestConf = 0;
  var bestIdx = -1;
  for (var i = 0; i < numAnchors; i++) {
    var conf = outputData[4 * numAnchors + i];
    if (conf > bestConf && conf >= CONF_THRESHOLD) {
      bestConf = conf;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;

  // Coordenadas em pixels do espaço 320x320 — normalizar para [0,1].
  var cx = outputData[bestIdx] / IMGSZ;
  var cy = outputData[numAnchors + bestIdx] / IMGSZ;
  var bw = outputData[2 * numAnchors + bestIdx] / IMGSZ;
  var bh = outputData[3 * numAnchors + bestIdx] / IMGSZ;
  return { cx: cx, cy: cy, w: bw, h: bh, conf: bestConf };
}

/**
 * Processa um frame: pré-processa, roda inference, pós-processa, emite result.
 */
function processFrame(msg) {
  var t0 = performance.now();
  var w = msg.width, h = msg.height;
  var rgba = new Uint8ClampedArray(msg.buffer);

  preprocess(rgba, w, h);

  // Cria tensor ONNX e roda inference (assíncrono — mas o worker é single-
  // threaded, então usamos await via async wrapper).
  var tensor = new ort.Tensor('float32', inputTensor, [1, 3, IMGSZ, IMGSZ]);
  var feeds = {};
  feeds[inputName] = tensor;

  session.run(feeds).then(function(results) {
    var output = results[outputName];
    var det = postprocess(output.data);
    var ms = performance.now() - t0;

    if (!det) {
      self.postMessage({
        type: 'result',
        found: false, cx: 0.5, cy: 0.5, coverage: 0, bboxAspect: 0,
        tilt: 0, touchesEdge: false, confidence: 0, score: 0,
        mode: 'yolo', ms: ms, wasmHeap: 0, width: w, height: h,
      });
      return;
    }

    // Métricas no contrato do guide.js (mesmo formato do frame-worker).
    var coverage = det.w * det.h; // área normalizada do bbox
    var bboxAspect = det.h > 0 ? det.w / det.h : 0;
    var touchesEdge = (det.cx - det.w / 2 <= 0.02) || (det.cy - det.h / 2 <= 0.02) ||
                      (det.cx + det.w / 2 >= 0.98) || (det.cy + det.h / 2 >= 0.98);

    self.postMessage({
      type: 'result',
      found: true, cx: det.cx, cy: det.cy, coverage: coverage,
      bboxAspect: bboxAspect, tilt: 0, touchesEdge: touchesEdge,
      confidence: det.conf, score: det.conf,
      mode: 'yolo', ms: ms, wasmHeap: 0, width: w, height: h,
    });
  }).catch(function(err) {
    self.postMessage({ type: 'error', message: 'inference: ' + (err && err.message || err) });
  });
}

// -------------------------------------------------------------------------
// Init: carrega onnxruntime-web via importScripts, cria a sessão ONNX.
// -------------------------------------------------------------------------
self.onmessage = function(e) {
  var msg = e.data;
  if (!msg) return;

  if (msg.type === 'config') {
    if (msg.conf !== undefined) CONF_THRESHOLD = msg.conf;
    return;
  }

  if (msg.type !== 'frame') return;

  if (!ready || !session) {
    self.postMessage({ type: 'notready' });
    return;
  }

  try {
    processFrame(msg);
  } catch (err) {
    self.postMessage({ type: 'error', message: 'processFrame: ' + (err && err.message || err) });
  }
};

// Init assíncrono — carrega ort, cria sessão, emite ready.
(async function() {
  try {
    // importScripts resolve contra self.location (URL do worker em js/framing/).
    // vendor está dois níveis acima: ../../vendor/
    self.importScripts('../../vendor/ort.min.js');
    ort = self.ort || self.onnxruntime;
    if (!ort) throw new Error('onnxruntime-web não carregou');

    // Configura o path dos arquivos .wasm — ort procura em self.location
    // por padrão, mas o worker está em js/framing/ e os wasm estão em vendor/.
    ort.env.wasm.wasmPaths = '../../vendor/';

    initInputTensor();

    // Carrega o modelo via fetch + ArrayBuffer (mais robusto que path direto).
    var resp = await fetch('../../vendor/paper-yolov8n.onnx');
    if (!resp.ok) throw new Error('fetch modelo: ' + resp.status);
    var buf = await resp.arrayBuffer();

    session = await ort.InferenceSession.create(buf, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    inputName = session.inputNames[0];
    outputName = session.outputNames[0];
    ready = true;
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: 'init: ' + (err && err.message || err) });
  }
})();

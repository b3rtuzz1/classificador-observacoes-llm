// ════════════════════════════════════════════════════════════════════════════
// ui.js — interface, estimativa de custo e leitura de planilhas
//
// Controles da tela: seletor de provedor/modelo, estimador de custo (antes e
// durante a execução), lista de categorias e de prioridade (arrastar-e-soltar)
// e importação do arquivo .xlsx/.csv.
// ════════════════════════════════════════════════════════════════════════════

// ─── INTERFACES E SLIDERS ─────────────────────────────────────────────────────
const concurrencySlider = document.getElementById('concurrency');
const concurrencyVal = document.getElementById('concurrencyVal');
concurrencySlider.oninput = () => { concurrencyVal.textContent = `${concurrencySlider.value} workers`; };

const batchSizeSlider = document.getElementById('batchSize');
const batchSizeVal = document.getElementById('batchSizeVal');
batchSizeSlider.oninput = () => { batchSizeVal.textContent = `${batchSizeSlider.value} linhas/req`; calcCostEstimate(); };

// ─── SELETOR DE PROVEDOR (Groq / OpenRouter) E MODELO ────────────────────────
// Retorna a configuração completa (preço, endpoint etc.) do modelo
// atualmente selecionado na interface. Usada tanto pela chamada real da API
// quanto pelo estimador de custo.
function getSelectedModelConfig() {
  const providerCfg = PROVIDERS[currentProvider];
  const modelId = document.getElementById('modelSelect').value;
  const modelCfg = providerCfg.models.find(m => m.id === modelId) || providerCfg.models[0];
  return { provider: currentProvider, providerCfg, ...modelCfg };
}

// Repopula o <select> de modelos de acordo com o provedor escolhido e
// atualiza placeholder/link de ajuda da chave de API.
function populateModelSelect() {
  const providerCfg = PROVIDERS[currentProvider];
  const sel = document.getElementById('modelSelect');
  sel.innerHTML = providerCfg.models.map(m => `<option value="${m.id}">${escHtml(m.label)}</option>`).join('');

  // Pré-seleciona o DeepSeek V4 Flash quando o provedor é OpenRouter.
  if (currentProvider === 'openrouter') {
    sel.value = 'deepseek/deepseek-v4-flash-0731';
  }

  document.getElementById('apiKey').placeholder = providerCfg.keyPlaceholder;
  document.getElementById('apiHint').innerHTML = providerCfg.keyHintHtml;

  // Jev (Decisions API) responde UMA linha por chamada — não existe "lote".
  // Trava o slider em 1 e mostra a nota explicativa; restaura ao sair do Jev.
  const isJev = !!providerCfg.isDecisionModel;
  document.getElementById('jevNote').style.display = isJev ? '' : 'none';
  const batchRow = document.getElementById('batchSize').closest('.concurrency-row');
  if (isJev) {
    document.getElementById('batchSize').value = 1;
    document.getElementById('batchSizeVal').textContent = '1 linha/req (fixo no Jev)';
    document.getElementById('batchSize').disabled = true;
    if (batchRow) batchRow.style.opacity = '0.5';
  } else {
    document.getElementById('batchSize').disabled = false;
    if (batchRow) batchRow.style.opacity = '1';
    document.getElementById('batchSizeVal').textContent = `${document.getElementById('batchSize').value} linhas/req`;
  }

  updateModelPriceTag();
  calcCostEstimate();
}

function updateModelPriceTag() {
  const cfg = getSelectedModelConfig();
  const tag = document.getElementById('modelPriceTag');
  if (cfg.priceIn === 0 && cfg.priceOut === 0) {
    tag.textContent = 'Gratuito (cota do Groq)';
  } else if (cfg.priceOut === 0) {
    tag.textContent = `US$ ${cfg.priceIn.toFixed(3)} / 1M tokens entrada · saída gratuita`;
  } else {
    tag.textContent = `US$ ${cfg.priceIn.toFixed(3)} / 1M tokens entrada · US$ ${cfg.priceOut.toFixed(3)} / 1M tokens saída`;
  }
}

document.getElementById('modelSelect').onchange = () => { updateModelPriceTag(); calcCostEstimate(); };

document.querySelectorAll('.provider-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.provider-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentProvider = tab.dataset.provider;
    populateModelSelect();
    updateRunBtn();
  };
});

// ─── ESTIMADOR DE CUSTO (antes de rodar) ──────────────────────────────────────
// Estratégia de estimativa: em vez de "chutar" um número fixo de tokens por
// observação, medimos o tamanho REAL do texto na coluna selecionada
// (workbookData) e convertemos caracteres → tokens usando uma razão média de
// ~3.5 caracteres por token (aproximação razoável para português em modelos
// tipo GPT/Llama/Qwen — o valor exato varia por tokenizador, por isso o
// resultado é uma ESTIMATIVA, não um valor exato).
//
// Importante: o system prompt (categorias + contexto + instruções) é
// reenviado em TODA requisição de lote — não é enviado uma única vez. Isso é
// a principal fonte de "desperdício" de tokens de entrada quando o lote é
// pequeno, por isso lotes maiores = menos reenvio do prompt = mais barato
// (ver comentário em buildSystemPrompt).
const CHARS_PER_TOKEN = 3.5;
function estimateTokensFromText(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

function calcCostEstimate() {
  const elIn = document.getElementById('estInputTokens');
  const elOut = document.getElementById('estOutputTokens');
  const elReq = document.getElementById('estRequests');
  const elCost = document.getElementById('estCost');

  if (!workbookData.length) {
    elIn.textContent = elOut.textContent = elReq.textContent = elCost.textContent = '–';
    return;
  }

  const colSelectEl = document.getElementById('colSelect');
  const colIdx = colSelectEl ? +colSelectEl.value : 0;
  const cats = getCatNames();
  const context = document.getElementById('aiContext') ? document.getElementById('aiContext').value.trim() : '';
  const numRows = workbookData.length;
  const modelCfg = getSelectedModelConfig();

  // Tamanho real do texto das observações (soma de caracteres), reutilizado
  // pelos dois modelos de estimativa abaixo.
  let obsCharsTotal = 0;
  for (const row of workbookData) {
    obsCharsTotal += String(row[colIdx] ?? '').length;
  }

  let totalInputTokens, totalOutputTokens, numRequests;

  if (modelCfg.providerCfg && modelCfg.providerCfg.isDecisionModel) {
    // ─── Modelo de estimativa para o JEV (Decisions API) ─────────────────
    // 1 requisição POR LINHA (sem lote). Cada requisição carrega: o texto da
    // observação (state) + N perguntas sim/não (uma por categoria, com nome +
    // critérios curtos). Saída é gratuita (priceOut = 0).
    numRequests = numRows;
    const perRowObsTokens = estimateTokensFromText('x'.repeat(obsCharsTotal)) / numRows; // média por linha
    const contextTokens = estimateTokensFromText(context);
    // ~25-35 tokens por pergunta sim/não (nome da categoria + instructions + criteria).
    const perRowQuestionsTokens = cats.length * 30;
    totalInputTokens = Math.ceil((perRowObsTokens + contextTokens + perRowQuestionsTokens) * numRows);
    totalOutputTokens = 0; // Jev: saída sempre gratuita, nem entra na conta de custo
  } else {
    // ─── Modelo de estimativa para chat (Groq / OpenRouter) ───────────────
    // Importante: o system prompt (categorias + contexto + instruções) é
    // reenviado em TODA requisição de lote — não é enviado uma única vez.
    // Isso é a principal fonte de "desperdício" de tokens de entrada quando
    // o lote é pequeno, por isso lotes maiores = menos reenvio do prompt =
    // mais barato (ver comentário em buildSystemPrompt).
    const batchSize = +document.getElementById('batchSize').value || 30;
    const systemPrompt = buildSystemPrompt(cats, context);
    const systemPromptTokens = estimateTokensFromText(systemPrompt);
    numRequests = Math.ceil(numRows / batchSize);

    // + ~4 caracteres por linha de overhead de numeração ("12. ", quebras de linha).
    const obsTokens = estimateTokensFromText('x'.repeat(obsCharsTotal + numRows * 4));
    totalInputTokens = (systemPromptTokens * numRequests) + obsTokens;

    // Saída: cada linha vira um OBJETO {"principal":N,"secundarias":[..]},
    // o que ocupa mais tokens do que um ID numérico solto.
    totalOutputTokens = (numRows * 12) + (numRequests * 20);
  }

  const cost = (totalInputTokens / 1e6) * modelCfg.priceIn + (totalOutputTokens / 1e6) * modelCfg.priceOut;

  elIn.textContent = totalInputTokens.toLocaleString('pt-BR');
  elOut.textContent = totalOutputTokens.toLocaleString('pt-BR');
  elReq.textContent = numRequests.toLocaleString('pt-BR');
  elCost.textContent = cost === 0 ? 'Gratuito' : `US$ ${cost.toFixed(4)}`;
}

// ─── PAINEL DE CUSTO EM TEMPO REAL (durante o processamento) ─────────────────
// Chamado a cada resposta da API que contenha "usage" (ver classifyBatchAPI).
// Groq e OpenRouter seguem o formato OpenAI-compatible:
// { usage: { prompt_tokens, completion_tokens, total_tokens } }
function addLiveUsage(usage) {
  if (!usage) return;
  liveUsage.promptTokens += usage.prompt_tokens || 0;
  liveUsage.completionTokens += usage.completion_tokens || 0;

  const modelCfg = getSelectedModelConfig();
  const cost = (liveUsage.promptTokens / 1e6) * modelCfg.priceIn + (liveUsage.completionTokens / 1e6) * modelCfg.priceOut;

  document.getElementById('liveCostPanel').style.display = '';
  document.getElementById('liveInputTokens').textContent = liveUsage.promptTokens.toLocaleString('pt-BR');
  document.getElementById('liveOutputTokens').textContent = liveUsage.completionTokens.toLocaleString('pt-BR');
  document.getElementById('liveCost').textContent = cost === 0 ? 'Gratuito' : `US$ ${cost.toFixed(4)}`;
}

// Inicializa o <select> de modelos assim que a página carrega.
populateModelSelect();

function renderCatList() {
  const list = document.getElementById('catList');
  list.innerHTML = '';
  CATEGORIES.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'cat-item';
    div.innerHTML = `
      <div class="cat-dot" style="background:${c.color}"></div>
      <input type="text" value="${escHtml(c.name)}" data-idx="${i}" />
      <button class="cat-del" data-idx="${i}" title="Remover">✕</button>
    `;
    list.appendChild(div);
  });

  list.querySelectorAll('.cat-del').forEach(b => {
    b.onclick = () => {
      CATEGORIES.splice(+b.dataset.idx, 1);
      syncPriorityOrder();
      renderCatList();
      renderPriorityList();
      updateRunBtn();
      if (typeof calcCostEstimate === 'function') calcCostEstimate();
    };
  });
  list.querySelectorAll('input').forEach(inp => {
    inp.oninput = () => {
      CATEGORIES[+inp.dataset.idx].name = inp.value;
      renderPriorityList(); // nomes mudam na lista de prioridade também
      if (typeof calcCostEstimate === 'function') calcCostEstimate();
    };
  });
}

function getCatNames() { return CATEGORIES.map(c => c.name); }

document.getElementById('btnAddCat').onclick = () => {
  CATEGORIES.push({ id: _nextCatId++, name: "Nova categoria", color: COLORS[CATEGORIES.length % COLORS.length] });
  syncPriorityOrder();
  renderCatList();
  renderPriorityList();
  if (typeof calcCostEstimate === 'function') calcCostEstimate();
};

// ─── RENDERIZAÇÃO DA LISTA DE PRIORIDADE (arrastar-e-soltar + setas) ──────────
let _dragFromId = null;

function renderPriorityList() {
  const list = document.getElementById('priorityList');
  if (!list) return;
  const idToCat = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
  list.innerHTML = '';

  PRIORITY_ORDER.forEach((id, i) => {
    const cat = idToCat[id];
    if (!cat) return;
    const div = document.createElement('div');
    div.className = 'priority-item';
    div.draggable = true;
    div.dataset.id = id;
    div.innerHTML = `
      <span class="priority-rank">${i + 1}º</span>
      <span class="priority-handle">⠿</span>
      <div class="cat-dot" style="background:${cat.color}"></div>
      <span class="priority-name">${escHtml(cat.name)}</span>
      <div class="priority-arrows">
        <button data-dir="up" data-id="${id}" title="Subir" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button data-dir="down" data-id="${id}" title="Descer" ${i === PRIORITY_ORDER.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
    `;
    list.appendChild(div);
  });

  // Setas: forma acessível e sempre confiável de reordenar (drag-and-drop
  // abaixo é um complemento, não a única forma).
  list.querySelectorAll('.priority-arrows button').forEach(btn => {
    btn.onclick = () => {
      const id = +btn.dataset.id;
      const idx = PRIORITY_ORDER.indexOf(id);
      const swapWith = btn.dataset.dir === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= PRIORITY_ORDER.length) return;
      [PRIORITY_ORDER[idx], PRIORITY_ORDER[swapWith]] = [PRIORITY_ORDER[swapWith], PRIORITY_ORDER[idx]];
      renderPriorityList();
      if (typeof calcCostEstimate === 'function') calcCostEstimate();
    };
  });

  // Drag-and-drop nativo (HTML5) para reordenar arrastando.
  list.querySelectorAll('.priority-item').forEach(item => {
    item.addEventListener('dragstart', () => {
      _dragFromId = +item.dataset.id;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const targetId = +item.dataset.id;
      if (_dragFromId === null || _dragFromId === targetId) return;
      const fromIdx = PRIORITY_ORDER.indexOf(_dragFromId);
      const toIdx = PRIORITY_ORDER.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      PRIORITY_ORDER.splice(fromIdx, 1);
      PRIORITY_ORDER.splice(toIdx, 0, _dragFromId);
      _dragFromId = null;
      renderPriorityList();
      if (typeof calcCostEstimate === 'function') calcCostEstimate();
    });
  });
}

renderCatList();
renderPriorityList();

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.onchange = e => { if (e.target.files[0]) handleFile(e.target.files[0]); };

document.getElementById('btnChangeFile').onclick = () => {
  document.getElementById('fileInfo').classList.remove('show');
  dropZone.style.display = '';
  ['step-col','step-cats','step-api','step-run'].forEach(id => document.getElementById(id).classList.remove('show'));
  workbookData = []; headers = []; results = [];
  document.getElementById('resultsSection').classList.remove('show');
  document.getElementById('divResults').classList.remove('show');
  fileInput.value = '';
};

function handleFile(file) {
  originalFileName = file.name.replace(/\.[^.]+$/, '');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const ext = file.name.split('.').pop().toLowerCase();
      let data;

      if (ext === 'csv') {
        const text = new TextDecoder('utf-8').decode(e.target.result);
        const lines = text.trim().split('\n');
        const sep = lines[0].includes(';') ? ';' : ',';
        data = lines.map(l => l.split(sep).map(v => v.replace(/^"|"$/g, '').trim()));
      } else {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      }

      if (data.length < 2) { alert('Planilha vazia ou sem dados.'); return; }

      // Corrige caracteres mal formatados em TODA a planilha (cabeçalhos e
      // dados) logo na importação — assim a tela, a IA e o arquivo exportado
      // no final usam texto limpo de ponta a ponta.
      data = fixMojibakeGrid(data);

      headers = data[0].map(String);
      workbookData = data.slice(1).filter(r => r.some(c => c !== undefined && c !== ''));

      document.getElementById('fiName').textContent = file.name;
      document.getElementById('fiMeta').textContent = `${workbookData.length} linhas · ${headers.length} colunas`;
      document.getElementById('fileInfo').classList.add('show');
      dropZone.style.display = 'none';

      const sel = document.getElementById('colSelect');
      sel.innerHTML = headers.map((h, i) => `<option value="${i}">${escHtml(h)}</option>`).join('');
      const obsIdx = headers.findIndex(h => /obs/i.test(h));
      if (obsIdx >= 0) sel.value = obsIdx;

      ['step-col','step-cats','step-api','step-run'].forEach(id => document.getElementById(id).classList.add('show'));
      updateRunBtn();
      calcCostEstimate();
    } catch (err) { alert('Erro ao carregar o arquivo: ' + err.message); }
  };
  reader.readAsArrayBuffer(file);
}

function updateRunBtn() {
  const hasData = workbookData.length > 0;
  const hasCats = CATEGORIES.length > 0;
  const hasKey = document.getElementById('apiKey').value.trim().length > 8;
  document.getElementById('btnRun').disabled = !(hasData && hasCats && hasKey);

  const hint = document.getElementById('runHint');
  if (!hasKey) hint.textContent = `Insira sua chave de API ${PROVIDERS[currentProvider].label}`;
  else if (!hasCats) hint.textContent = 'Defina as categorias';
  else hint.textContent = `${workbookData.length} observações prontas`;
}

document.getElementById('apiKey').oninput = updateRunBtn;
document.getElementById('colSelect').onchange = () => { updateRunBtn(); calcCostEstimate(); };
document.getElementById('aiContext').oninput = () => calcCostEstimate();


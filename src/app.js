// ════════════════════════════════════════════════════════════════════════════
// app.js — botão Processar, resultados e exportação
//
// Orquestra a execução (botões Processar/Parar), renderiza estatísticas,
// tabela filtrável com paginação, exporta para XLSX/CSV e testa a chave.
// ════════════════════════════════════════════════════════════════════════════

// ─── CLICK PROCESSAR ──────────────────────────────────────────────────────────
document.getElementById('btnStop').onclick = () => { stopRequested = true; };

document.getElementById('btnRun').onclick = async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('modelSelect').value;
  const provider = currentProvider;
  const colIdx = +document.getElementById('colSelect').value;
  const cats = getCatNames();
  const customContext = document.getElementById('aiContext').value.trim();
  const batchSize = +document.getElementById('batchSize').value;
  const workers = +document.getElementById('concurrency').value;

  stopRequested = false;
  results = [];

  // Zera o painel de custo em tempo real a cada nova execução.
  liveUsage = { promptTokens: 0, completionTokens: 0 };
  document.getElementById('liveCostPanel').style.display = '';
  document.getElementById('liveInputTokens').textContent = '0';
  document.getElementById('liveOutputTokens').textContent = '0';
  document.getElementById('liveCost').textContent = 'US$ 0.0000';

  // Limpa o log detalhado e o alerta de segurança de execuções anteriores.
  document.getElementById('processLog').innerHTML = '';
  document.getElementById('processLog').style.display = 'none';
  document.getElementById('safetyAlert').classList.remove('show');
  document.getElementById('safetyAlert').textContent = '';

  // ─── Define o TETO DE CUSTO DE SEGURANÇA para esta execução ────────────────
  // Calculado como 5x a estimativa pré-execução (com piso mínimo de US$0.05
  // para não disparar por ruído em planilhas muito pequenas/baratas). Se o
  // gasto real ultrapassar isso, o processamento para sozinho (ver
  // tripSafetyBreaker em runQueue). Só se aplica a provedores pagos.
  const preRunModelCfg = getSelectedModelConfig();
  if (preRunModelCfg.priceIn === 0 && preRunModelCfg.priceOut === 0) {
    costSafetyCeiling = null; // Groq gratuito: sem teto de custo
  } else {
    calcCostEstimate(); // garante que a estimativa reflita a config atual
    const estText = document.getElementById('estCost').textContent.replace('US$', '').trim();
    const estValue = parseFloat(estText.replace(',', '.')) || 0;
    costSafetyCeiling = Math.max(0.05, estValue * 5);
  }

  const btn = document.getElementById('btnRun');
  btn.classList.add('loading');
  btn.disabled = true;
  document.getElementById('btnStop').style.display = '';
  document.getElementById('progressBar').classList.add('show');
  document.getElementById('progressText').textContent = 'Iniciando lotes...';
  document.getElementById('batchNote').classList.remove('show');
  document.getElementById('successNote').classList.remove('show');

  const rows = workbookData.map(r => ({
    row: r,
    obs: String(r[colIdx] ?? '').trim(),
    category: null
  }));

  const totalLotes = Math.ceil(rows.length / batchSize);
  const estSegundos = Math.ceil((totalLotes * 1200) / workers / 1000) || 2;
  const tempoLabel = estSegundos > 60 ? `~${Math.ceil(estSegundos/60)} min` : `${estSegundos}s`;

  const note = document.getElementById('batchNote');
  note.textContent = `ℹ️ Agrupado em ${totalLotes} lotes de ${batchSize} linhas. Tempo aproximado estimado: ${tempoLabel}`;
  note.classList.add('show');

  const taskResults = await runQueue(provider, rows, apiKey, model, cats, customContext, (done, total, lastCat, lastError) => {
    const pct = Math.round((done / total) * 100);
    document.getElementById('progressFill').style.width = pct + '%';
    let label = lastCat && !lastCat.startsWith('Erro') && lastCat !== 'Sem categoria' ? ` — Último: ${lastCat}` : '';
    if (lastError) label = ` ❌ Erro no lote: ${lastError.substring(0,40)}`;
    document.getElementById('progressText').textContent = `${done} / ${total} processados (${pct}%)${label}`;
  });

  results = taskResults;

  btn.classList.remove('loading');
  btn.disabled = false;
  document.getElementById('btnStop').style.display = 'none';

  const finalModelCfg = getSelectedModelConfig();
  const finalCost = (liveUsage.promptTokens / 1e6) * finalModelCfg.priceIn + (liveUsage.completionTokens / 1e6) * finalModelCfg.priceOut;
  const custoLabel = finalCost === 0 ? 'gratuito (Groq)' : `US$ ${finalCost.toFixed(4)}`;

  // Considera "falha" qualquer linha marcada como Sem categoria/Cancelada,
  // ou que nunca chegou a ser processada (null, quando o processo foi
  // interrompido antes de chegar naquela linha).
  const isFailure = r => !r || !r.category || r.category.startsWith('Sem categoria') || r.category === 'Cancelado';
  const errCount = results.filter(isFailure).length;
  const processedCount = results.length - errCount;

  const safetyTripped = document.getElementById('safetyAlert').classList.contains('show');
  if (safetyTripped) {
    note.textContent = `⚠️ Execução interrompida pelo disjuntor de segurança (veja o alerta acima). ${processedCount}/${results.length} linhas classificadas. Custo real: ${custoLabel}.`;
    note.classList.add('show');
  } else if (errCount > 0) {
    note.textContent = `⚠️ Processamento concluído, porém ${errCount} de ${results.length} linha(s) não foram classificadas (falha ou interrupção manual). Custo real: ${custoLabel}.`;
    note.classList.add('show');
  } else {
    document.getElementById('successNote').textContent = `✅ Todas as ${results.length} observações foram processadas com sucesso em lotes! Custo real: ${custoLabel}.`;
    document.getElementById('successNote').classList.add('show');
  }

  renderResults();
  updateRunBtn();
};

// ─── RENDERIZAÇÃO DA TABELA DE RESULTADOS ──────────────────────────────────────
function getCatColor(name) {
  const cat = CATEGORIES.find(c => c.name === name);
  if (cat) return cat.color;
  if (name === 'Sem categoria') return '#aaa';
  return '#e45c5c';
}

function getBadgeStyle(name) {
  const color = getCatColor(name);
  const hex2rgb = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const [r,g,b] = hex2rgb(color.length === 7 ? color : '#aaaaaa');
  return { color, bg: `rgba(${r},${g},${b},0.12)`, border: `rgba(${r},${g},${b},0.25)` };
}

function renderResults() {
  document.getElementById('divResults').classList.add('show');
  document.getElementById('resultsSection').classList.add('show');
  activeFilter = null;
  currentPage = 1;
  renderStats();
  renderTable();
}

function getFiltered() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  return results.filter(r => {
    if (!r) return false;
    if (activeFilter && r.category !== activeFilter) return false;
    if (q) {
      const combined = Object.values(r.row || {}).join(' ').toLowerCase() + ' ' + (r.category || '').toLowerCase();
      if (!combined.includes(q)) return false;
    }
    return true;
  });
}

function renderStats() {
  const counts = {};
  results.forEach(r => { if (r) counts[r.category] = (counts[r.category] || 0) + 1; });
  const bar = document.getElementById('statsBar');
  bar.innerHTML = '';

  const totalChip = document.createElement('div');
  totalChip.className = 'stat-chip' + (!activeFilter ? ' active' : '');
  totalChip.innerHTML = `<span>Todas</span><span class="stat-count">${results.length}</span>`;
  totalChip.onclick = () => { activeFilter = null; currentPage = 1; renderStats(); renderTable(); document.getElementById('btnClearFilter').style.display = 'none'; };
  bar.appendChild(totalChip);

  Object.entries(counts).sort((a,b) => b[1]-a[1]).forEach(([name, count]) => {
    const s = getBadgeStyle(name);
    const chip = document.createElement('div');
    chip.className = 'stat-chip' + (activeFilter === name ? ' active' : '');
    chip.innerHTML = `<span class="stat-dot" style="background:${s.color}"></span><span>${escHtml(name)}</span><span class="stat-count">${count}</span>`;
    chip.onclick = () => { activeFilter = name; currentPage = 1; renderStats(); renderTable(); document.getElementById('btnClearFilter').style.display = ''; };
    bar.appendChild(chip);
  });
}

function renderTable() {
  const filtered = getFiltered();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const head = document.getElementById('tableHead');
  head.innerHTML = '<tr>' + headers.map(h => `<th>${escHtml(h)}</th>`).join('') + '<th>Categoria</th></tr>';

  const body = document.getElementById('tableBody');
  body.innerHTML = '';
  pageItems.forEach(item => {
    const s = getBadgeStyle(item.category);
    const tr = document.createElement('tr');
    const principalBadge = `<span class="badge" style="background:${s.bg};color:${s.color};border:1px solid ${s.border}"><span class="badge-dot" style="background:${s.color}"></span>${escHtml(item.category)}</span>`;
    // Categorias secundárias (se houver) aparecem como badges menores,
    // levemente esmaecidos, logo abaixo da principal.
    const secs = (item.secondaryCategories || []);
    const secondaryBadges = secs.length
      ? `<div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:4px;">${secs.map(sc => {
          const sb = getBadgeStyle(sc);
          return `<span class="badge" style="background:${sb.bg};color:${sb.color};border:1px solid ${sb.border};opacity:0.75;font-size:11px;padding:2px 7px;"><span class="badge-dot" style="background:${sb.color}"></span>${escHtml(sc)}</span>`;
        }).join('')}</div>`
      : '';
    tr.innerHTML = headers.map((h, i) => {
      const v = item.row[i] ?? '';
      return `<td class="${i === +document.getElementById('colSelect').value ? 'obs-cell' : ''}">${escHtml(String(v))}</td>`;
    }).join('') + `<td>${principalBadge}${secondaryBadges}</td>`;
    body.appendChild(tr);
  });

  document.getElementById('tableTitle').textContent = activeFilter ? `Categoria: ${activeFilter}` : 'Todas as linhas';
  document.getElementById('tableCount').textContent = `${filtered.length} resultados`;
  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const pg = document.getElementById('pagination');
  pg.innerHTML = '';
  if (totalPages <= 1) return;

  const addBtn = (label, page, isActive, disabled) => {
    const b = document.createElement('button');
    b.className = 'pg-btn' + (isActive ? ' active' : '');
    b.textContent = label; b.disabled = disabled;
    b.onclick = () => { currentPage = page; renderTable(); };
    pg.appendChild(b);
  };

  addBtn('‹', currentPage - 1, false, currentPage === 1);
  const range = [...new Set([1, currentPage - 1, currentPage, currentPage + 1, totalPages])].filter(p => p >= 1 && p <= totalPages).sort((a,b)=>a-b);
  let prev = 0;
  range.forEach(p => {
    if (prev && p - prev > 1) {
      const sp = document.createElement('span'); sp.className = 'pg-info'; sp.textContent = '…'; pg.appendChild(sp);
    }
    addBtn(p, p, p === currentPage, false);
    prev = p;
  });
  addBtn('›', currentPage + 1, false, currentPage === totalPages);
}

document.getElementById('searchInput').oninput = () => { currentPage = 1; renderTable(); };
document.getElementById('btnClearFilter').onclick = () => {
  activeFilter = null; currentPage = 1;
  document.getElementById('btnClearFilter').style.display = 'none';
  renderStats(); renderTable();
};

// ─── EXPORTAÇÃO DE ARQUIVOS ───────────────────────────────────────────────────
// IMPORTANTE: se o processamento foi interrompido (botão "Parar" ou disjuntor
// de segurança) antes de percorrer todas as linhas, o array `results` fica
// com "buracos" (posições nunca preenchidas = null). Para a exportação não
// quebrar ao ler `.row` de null, essas linhas são recuperadas a partir de
// `workbookData` (mesma ordem/index)
// e marcadas como "Não processado (interrompido)", preservando todos os
// dados originais no arquivo exportado.
function buildExportData() {
  // Mostra a coluna de probabilidades (Jev) só se pelo menos uma linha
  // tiver esse dado — não polui a planilha quando outro provedor foi usado.
  const hasJevProbs = results.some(r => r && Array.isArray(r.jevProbs));

  const allHeaders = [...headers, 'Categoria Principal', 'Categorias Secundárias'];
  if (hasJevProbs) allHeaders.push('Probabilidades (Jev)');

  const rows = results.map((r, i) => {
    if (r && r.category) {
      const row = [...(r.row || []), r.category, (r.secondaryCategories || []).join('; ')];
      if (hasJevProbs) {
        // Formato legível para conferência/ajuste manual de limiar no Excel,
        // sem precisar rechamar a API: "CategoriaA: 0.82; CategoriaB: 0.12; ..."
        const probsStr = Array.isArray(r.jevProbs)
          ? r.jevProbs.map(p => `${p.name}: ${p.p.toFixed(2)}`).join('; ')
          : '';
        row.push(probsStr);
      }
      return row;
    }
    const row = [...(workbookData[i] || []), 'Não processado (interrompido)', ''];
    if (hasJevProbs) row.push('');
    return row;
  });
  return [allHeaders, ...rows];
}

document.getElementById('btnExportXlsx').onclick = () => {
  try {
    const data = buildExportData();
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Classificado');
    XLSX.writeFile(wb, `${originalFileName}_classificado.xlsx`);
  } catch (e) {
    alert('Erro ao gerar o arquivo Excel: ' + e.message);
  }
};

document.getElementById('btnExportCsv').onclick = () => {
  try {
    const data = buildExportData();
    const csv = data.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${originalFileName}_classificado.csv`;
    a.click();
  } catch (e) {
    alert('Erro ao gerar o arquivo CSV: ' + e.message);
  }
};

// ─── TESTE DE CHAVE INDIVIDUAL ────────────────────────────────────────────────
document.getElementById('btnTest').onclick = async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('modelSelect').value;
  const providerCfg = PROVIDERS[currentProvider];
  const btn = document.getElementById('btnTest');
  const res = document.getElementById('testResult');

  if (!apiKey) { res.textContent = '⚠️ Insira a chave'; res.style.color = 'var(--amber)'; return; }

  btn.disabled = true; btn.textContent = '⏳ Testando...'; res.textContent = '';

  // Jev usa a Decisions API (schema state/questions), não /chat/completions
  // — um payload de teste diferente é necessário aqui.
  const testBody = providerCfg.isDecisionModel
    ? {
        model: model,
        state: { texto: 'teste de conexão' },
        questions: { ping: { type: 'noul', instructions: 'Isto é um teste?', criteria: { true: 'Sim.', false: 'Não.' } } }
      }
    : { model: model, messages: [{ role: 'user', content: 'Ping' }], max_tokens: 5 };

  try {
    const resp = await fetch(providerCfg.baseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...providerCfg.extraHeaders()
      },
      body: JSON.stringify(testBody)
    });
    if (resp.ok) {
      res.textContent = `✅ Conexão OK! (${providerCfg.label})`; res.style.color = 'var(--green)';
    } else {
      const err = await resp.json().catch(() => ({}));
      res.textContent = `❌ Erro HTTP ${resp.status}: ${err?.error?.message || ''}`; res.style.color = 'var(--red)';
    }
  } catch(e) {
    res.textContent = `❌ Falha de rede.`; res.style.color = 'var(--red)';
  }
  btn.disabled = false; btn.textContent = '🔍 Testar chave de API';
};

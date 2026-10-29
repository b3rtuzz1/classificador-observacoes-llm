// ════════════════════════════════════════════════════════════════════════════
// config.js — categorias, prioridade e estado global
//
// Dados editáveis do classificador (categorias e ordem de prioridade) e as
// variáveis de estado compartilhadas entre os demais arquivos.
// 
// Os scripts são carregados na ordem do index.html: config → providers →
// utils → classifier → ui → app. Todos compartilham o escopo global.
// ════════════════════════════════════════════════════════════════════════════

// ─── CONFIGURAÇÕES E ESTADO GLOBAL ────────────────────────────────────────────
const COLORS = ["#e45c5c","#f5a623","#4a90e2","#7c4dff","#00b38a","#ff6d00","#e91e8c","#29b6f6","#66bb6a","#ab47bc"];

// Cada categoria tem um "id" estável (não muda se a categoria for renomeada
// ou se outras categorias forem adicionadas/removidas). PRIORITY_ORDER
// referencia categorias por esse id, não pela posição no array — assim a
// ordem de prioridade sobrevive a edições na lista.
//
// ATENÇÃO: as categorias abaixo são apenas um EXEMPLO genérico. Em um uso
// real, edite-as pela interface (botão de adicionar/renomear categoria) ou
// diretamente aqui, conforme o seu processo produtivo.
let _nextCatId = 0;
const CATEGORIES = [
  { id: _nextCatId++, name: "Falha de equipamento", color: COLORS[0] },
  { id: _nextCatId++, name: "Falta de material", color: COLORS[1] },
  { id: _nextCatId++, name: "Troca de produto / Setup", color: COLORS[2] },
  { id: _nextCatId++, name: "Defeito de qualidade / Retrabalho", color: COLORS[3] },
  { id: _nextCatId++, name: "Limpeza e organização", color: COLORS[4] },
  { id: _nextCatId++, name: "Pausa programada", color: COLORS[5] },
];

// ─── ORDEM DE PRIORIDADE / DESEMPATE ──────────────────────────────────────────
// Lista de ids de categoria, da MAIOR para a MENOR prioridade. Quando uma
// observação envolve mais de uma categoria, a de maior prioridade vira a
// "principal" e as demais viram "secundárias". A ordem é editável por
// arrastar-e-soltar na interface (ver renderPriorityList) e é a MESMA nos dois
// caminhos de classificação: no texto da regra enviado ao prompt dos modelos
// de chat (ver buildPriorityRuleText) e na escolha da "principal" no Jev
// (ver classifyRowJev).
let PRIORITY_ORDER = [0, 1, 2, 3, 4, 5];

// Mantém PRIORITY_ORDER consistente após adicionar/remover categorias:
// preserva a ordem relativa dos ids que ainda existem e acrescenta ids novos
// no final (prioridade mais baixa por padrão, até o usuário reordenar).
function syncPriorityOrder() {
  const validIds = new Set(CATEGORIES.map(c => c.id));
  const kept = PRIORITY_ORDER.filter(id => validIds.has(id));
  const keptSet = new Set(kept);
  CATEGORIES.forEach(c => { if (!keptSet.has(c.id)) kept.push(c.id); });
  PRIORITY_ORDER = kept;
}

// Gera o texto da regra de desempate a partir da ordem estruturada atual,
// para injetar no system prompt dos modelos de chat (ver buildSystemPrompt).
function buildPriorityRuleText() {
  const idToCat = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
  const ordered = PRIORITY_ORDER.map((id, i) => `${i + 1}.${idToCat[id]?.name}`).filter(s => !s.endsWith('undefined'));
  return ordered.join(' > ');
}

let workbookData = [];
let headers = [];
let results = [];
let activeFilter = null;
let currentPage = 1;
const PAGE_SIZE = 50;
let stopRequested = false;
let originalFileName = '';


// Teto de custo (em US$) calculado a partir da estimativa pré-execução. Se o
// gasto real passar dele, o processamento para sozinho (ver runQueue). É
// definido ao clicar em "Processar" (ver app.js).
let costSafetyCeiling = null;


// ════════════════════════════════════════════════════════════════════════════
// classifier.js — prompts, chamadas às APIs e execução em lotes
//
// Núcleo da ferramenta: monta o prompt, chama as APIs de LLM (chat com saída
// estruturada e Jev), valida/normaliza o JSON, faz fallback em cascata e
// executa tudo em paralelo (workers) com disjuntor de segurança e de custo.
// ════════════════════════════════════════════════════════════════════════════

// ─── PROMPTS E LÓGICA DE MINI-LOTES ───────────────────────────────────────────
//
// ESTRATÉGIAS DE ECONOMIA DE TOKENS EMBUTIDAS NESTE MÓDULO:
//
// 1. CLASSIFICAÇÃO EM LOTE (batching): em vez de 1 requisição por linha da
//    planilha, várias observações (20-50, configurável no slider) são
//    enviadas em uma única chamada. Isso dilui o custo fixo do system
//    prompt (categorias + instruções) entre várias linhas.
//
// 2. SAÍDA MÍNIMA (IDs numéricos, não nomes de categoria): o modelo responde
//    só com um array de números, ex. {"resultados":[1,3,2,...]}, e o
//    mapeamento de volta para o nome da categoria é feito localmente em
//    JS (ver runQueue → resultsMapeados). Pedir para o modelo reescrever o
//    nome completo da categoria em cada linha multiplicaria o custo de
//    saída por vários tokens por item, sem necessidade.
//
// 3. response_format: "json_object": força o modelo a responder só com JSON,
//    sem frases de preâmbulo tipo "Aqui está a classificação:" (que
//    custariam tokens de saída e ainda arriscariam quebrar o parser).
//
// 4. max_tokens calculado dinamicamente (maxTokensEst = itens*5 + 30): evita
//    que o modelo "divague" e gere uma resposta longa por engano — o teto
//    é o suficiente para o tamanho do lote, nem mais, nem menos.
//
// 5. FALLBACK EM CASCATA só quando necessário: se o lote inteiro falhar (ex.:
//    desalinhamento entre nº de itens e nº de respostas), o código só then
//    tenta sub-lotes menores e, em último caso, linha por linha — ou seja,
//    o modo mais caro (1 req/linha) só é usado como exceção, não como regra.
//
// 6. temperature: 0 — não economiza tokens diretamente, mas reduz a chance
//    de respostas "criativas" fora do formato esperado, que gerariam
//    reprocessamento (e gasto duplicado).
//
// COMO REDUZIR AINDA MAIS O CUSTO, SE QUISER:
//   - Aumentar o tamanho do lote (slider "Tamanho do Lote") reduz o número
//     de vezes que o system prompt é reenviado. Ex.: 500 linhas em lotes de
//     50 = 10 requisições; em lotes de 20 = 25 requisições (mais reenvio de
//     prompt fixo). O teto de 50 no slider já é uma escolha consciente para
//     não estourar o limite de tokens de saída de alguns modelos/lotes.
//   - Manter o "Contexto/Instruções Extras" curto (o campo já avisa isso).
//   - Reduzir o número de categorias ao mínimo necessário (cada categoria
//     extra soma ~5-15 tokens ao system prompt, repetidos em toda requisição).
function buildSystemPrompt(cats, context) {
  let prompt = "";
  if (context) prompt += `Contexto do Negócio / Instruções operacionais: ${context}\n\n`;

  prompt += `Você é um classificador de observações de produção (OEE). Leia a lista de observações e, para cada uma, identifique a(s) categoria(s) que se aplicam.\n\n`;
  prompt += `Categorias mapeadas:\n${cats.map((c,i)=>`${i+1}=${c}`).join('\n')}\n0=Sem categoria\n\n`;

  // MULTI-CATEGORIA (principal + secundárias): uma observação pode descrever
  // mais de um evento (ex.: "setup e depois retrabalho por defeito"). Em vez
  // de forçar uma única categoria para tudo, o modelo escolhe uma categoria
  // PRINCIPAL (usando a ordem de prioridade abaixo) e pode, opcionalmente,
  // apontar até 2 categorias SECUNDÁRIAS quando a MESMA observação mencionar
  // claramente outro evento distinto. Isso mantém compatível com análises de
  // Pareto (que usam só a principal) e preserva o sinal extra para quem
  // quiser investigar observações compostas.
  //
  // A regra de prioridade vem da lista estruturada configurada na interface
  // (ver PRIORITY_ORDER/buildPriorityRuleText) — não depende mais do usuário
  // digitar isso corretamente no campo de contexto livre.
  const priorityRule = buildPriorityRuleText();
  if (priorityRule) {
    prompt += `ORDEM DE PRIORIDADE PARA DESEMPATE (da mais grave/raiz para a menos grave): ${priorityRule}.\n\n`;
  }
  prompt += `REGRA DE SAÍDA — CLASSIFICAÇÃO PRINCIPAL + SECUNDÁRIAS (opcional):\n`;
  prompt += `Para cada item, escolha UMA categoria PRINCIPAL (se mais de uma categoria se aplicar, escolha a que aparece primeiro na ORDEM DE PRIORIDADE acima). Se a MESMA observação mencionar claramente outro(s) evento(s) distinto(s) correspondendo a outra(s) categoria(s), liste até 2 IDs adicionais em "secundarias". NÃO force uma categoria secundária: a maioria das observações deve ter "secundarias" vazio — só preencha quando houver múltiplos eventos genuinamente diferentes na mesma observação (não apenas detalhes do mesmo evento).\n\n`;

  prompt += `REGRA INVIOLÁVEL: Responda APENAS com um objeto JSON exato neste formato: {"resultados": [{"principal": id, "secundarias": [id, id]}, ...]}. A quantidade de itens no array DEVE ser EXATAMENTE IGUAL à quantidade de itens na lista. "secundarias" pode ser um array vazio []. Não escreva mais nada.\n\n`;
  // Exemplo curto e concreto do formato esperado — ajuda modelos que não
  // suportam tool calling (caminho de fallback em texto) a manter o formato
  // correto em vez de "inventar" outra estrutura.
  prompt += `Exemplo de resposta correta para uma lista de 3 itens (o 2º item tem 1 categoria secundária, os outros não):\n{"resultados": [{"principal": 2, "secundarias": []}, {"principal": 5, "secundarias": [9]}, {"principal": 1, "secundarias": []}]}`;
  return prompt;
}

// ────────────────────────────────────────────────────────────────────────────
// classifyBatchAPI: faz UMA chamada de classificação em lote para o provedor
// de IA selecionado (Groq ou OpenRouter). Ambos expõem uma API compatível
// com o formato OpenAI (/chat/completions), então a mesma função serve para
// os dois — o que muda é a URL do endpoint e os headers extras (ver PROVIDERS
// no início do script).
//
// Estratégia de saída estruturada: tenta primeiro via TOOL/FUNCTION CALLING
// (mais confiável — a API valida o schema); se o modelo rejeitar esse
// parâmetro, cai automaticamente para o modo alternativo (JSON em texto livre,
// com response_format: json_object). Ver toolCallingDisabled.
//
// Parâmetros:
//   provider       - 'groq' | 'openrouter'
//   apiKey         - chave de API digitada pelo usuário
//   model          - id do modelo (ex.: 'deepseek/deepseek-v4-flash-0731')
//   systemPrompt   - instruções fixas (categorias, contexto, regra de saída)
//   userText       - lista numerada das observações deste lote
//   maxTokensEst   - teto de tokens de saída (evita respostas "fugindo" e
//                     gastando tokens à toa; calculado em runQueue)
//   numItems       - quantidade de itens neste lote (define minItems/maxItems
//                     no schema da tool call)
//
// Retorno: { array: [...] } em caso de sucesso, ou { error }, ou
// { rateLimited, retryAfter }. Quando a API devolve "usage" (tokens reais
// consumidos), ele também é repassado em "usage" para alimentar o painel de
// custo em tempo real (ver addLiveUsage).
// ────────────────────────────────────────────────────────────────────────────
// Cache em memória (válido durante esta execução) indicando se um modelo já
// demonstrou não aceitar "tool calling". Quando isso acontece, alternamos
// automaticamente para o modo alternativo (JSON em texto livre) para esse modelo,
// sem precisar que o usuário faça nada.
const toolCallingDisabled = {};

// Normaliza diferentes formatos que os modelos às vezes devolvem para um
// array de objetos { principal: number, secundarias: number[] }.
// Formatos de resposta tolerados (observados em testes):
//   [{"principal":2,"secundarias":[5]}, ...]   → já é o formato esperado
//   {"1":{"principal":2,...}, "2":{...}}       → objeto c/ chaves numéricas → vira array
//   [2, 5, 1]                                  → modelo "esqueceu" o objeto,
//                                                 devolveu só o número → tratado
//                                                 como principal, sem secundárias
//   {"1":"19","2":"18"}                        → idem, formato simplificado
// Isso evita jogar fora respostas que, na prática, já continham a
// classificação correta — só não na "casca" exata que pedimos.
function normalizeResultArray(parsed) {
  let arr = null;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed);
    if (keys.length && keys.every(k => /^\d+$/.test(k))) {
      arr = keys.sort((a, b) => +a - +b).map(k => parsed[k]);
    }
  }
  if (!arr) return null;

  return arr.map(item => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const principal = typeof item.principal === 'string' ? parseInt(item.principal, 10) : item.principal;
      let secundarias = Array.isArray(item.secundarias) ? item.secundarias : [];
      secundarias = secundarias
        .map(v => (typeof v === 'string' ? parseInt(v, 10) : v))
        .filter(v => Number.isInteger(v));
      return { principal, secundarias };
    }
    // Modelo devolveu só um número (formato simplificado) — vira principal,
    // sem secundárias.
    const principal = typeof item === 'string' ? parseInt(item, 10) : item;
    return { principal, secundarias: [] };
  });
}

async function classifyBatchAPI(provider, apiKey, model, systemPrompt, userText, maxTokensEst, numItems) {
  const providerCfg = PROVIDERS[provider];
  const url = providerCfg.baseURL;
  const useTools = !toolCallingDisabled[model];

  const body = {
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ],
    // temperature 0.1 (não 0): decodificação totalmente gulosa (temp=0) às
    // vezes trava alguns modelos baratos em loops degenerados (repetição de
    // símbolos/caracteres aleatórios — o "gibberish" que você viu no log).
    // Um valor bem baixo mantém a resposta praticamente determinística mas
    // evita esses travamentos.
    temperature: 0.1,
    max_tokens: maxTokensEst,
    stream: false
  };

  if (useTools) {
    // ESTRATÉGIA PRINCIPAL — Tool/Function calling: em vez de pedir "responda
    // em JSON" em texto livre (frágil — o modelo pode "inventar" a chave,
    // devolver objeto em vez de array, ou divagar), definimos uma função
    // com um schema explícito e forçamos o modelo a chamá-la. A própria API
    // valida a estrutura (tipo array, tamanho) antes da resposta chegar até
    // nós. É consideravelmente mais confiável do que response_format
    // json_object sozinho, e a maioria dos modelos atuais (mesmo os
    // "flash" baratos) suporta isso.
    body.tools = [{
      type: 'function',
      function: {
        name: 'submeter_classificacao',
        description: 'Envia o resultado da classificação: para cada observação, a categoria principal e, opcionalmente, até 2 categorias secundárias, na mesma ordem em que as observações foram apresentadas.',
        parameters: {
          type: 'object',
          properties: {
            resultados: {
              type: 'array',
              minItems: numItems,
              maxItems: numItems,
              items: {
                type: 'object',
                properties: {
                  principal: { type: 'integer', description: 'ID da categoria principal (causa mais grave/raiz).' },
                  secundarias: {
                    type: 'array',
                    items: { type: 'integer' },
                    maxItems: 2,
                    description: 'IDs de categorias adicionais claramente mencionadas na mesma observação (0 a 2 itens; normalmente vazio).'
                  }
                },
                required: ['principal']
              },
              description: `Array com exatamente ${numItems} objetos (um por item, na ordem).`
            }
          },
          required: ['resultados']
        }
      }
    }];
    body.tool_choice = { type: 'function', function: { name: 'submeter_classificacao' } };
  } else {
    // Este modelo já rejeitou "tools" antes nesta execução — volta para o
    // modo texto+JSON puro (o que tínhamos originalmente).
    body.response_format = { type: 'json_object' };
  }

  // IMPORTANTE: vários modelos "flash" mais novos (ex.: DeepSeek V4 Flash,
  // Qwen3.7 Flash) são modelos HÍBRIDOS de raciocínio — por padrão eles podem
  // gerar tokens de "pensamento" (chain-of-thought) internos ANTES da
  // resposta final, mesmo em tarefas simples. Esses tokens contam como
  // "completion_tokens" (custam dinheiro) e, pior: se o max_tokens for
  // pequeno, a resposta pode ser CORTADA no meio do raciocínio, antes do
  // JSON final ser gerado — causando falha de parse e retentativas em
  // cascata. Por isso, para o OpenRouter, desativamos explicitamente o
  // raciocínio. Groq não usa esse parâmetro (ignorado se enviado).
  if (provider === 'openrouter') {
    body.reasoning = { enabled: false };
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...providerCfg.extraHeaders() // Headers específicos do provedor (ex.: HTTP-Referer no OpenRouter)
    },
    body: JSON.stringify(body)
  });

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '30');
    return { rateLimited: true, retryAfter };
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${resp.status}`;
    // Se o provedor/modelo rejeitou o parâmetro "tools", desativa para o
    // restante desta execução — a próxima tentativa já usa o modo texto.
    if (useTools && /tool|function.?calling/i.test(msg)) {
      toolCallingDisabled[model] = true;
      return { error: `Modelo não aceitou "tool calling" (${msg}). Alternando para modo JSON de texto nas próximas tentativas.` };
    }
    return { error: msg };
  }

  const data = await resp.json();
  const message = data?.choices?.[0]?.message;
  const finishReason = data?.choices?.[0]?.finish_reason;

  // "usage" é o número REAL de tokens consumidos nesta chamada (não uma
  // estimativa). Ambos os provedores (Groq e OpenRouter) retornam isso no
  // formato OpenAI-compatible: { prompt_tokens, completion_tokens }.
  const usage = data?.usage || null;

  let arrayFinal = null;
  let rawPreview = '';

  // 1) Caminho preferido: resposta veio via chamada de função (tool_calls).
  const toolArgs = message?.tool_calls?.[0]?.function?.arguments;
  if (toolArgs) {
    rawPreview = String(toolArgs).substring(0, 200);
    try {
      const parsedArgs = JSON.parse(toolArgs);
      arrayFinal = normalizeResultArray(parsedArgs.resultados ?? parsedArgs);
    } catch (e) { /* cai para o parsing por texto abaixo */ }
  }

  // 2) Se não veio (ou falhou) por tool_calls, tenta extrair JSON do texto
  //    normal da resposta — mantém compatibilidade com modelos sem tools.
  if (!arrayFinal) {
    let raw = (message?.content || '').trim();
    if (!rawPreview) rawPreview = raw.substring(0, 200);
    try {
      raw = raw.replace(/```json|```/g, '').trim();
      const startObj = raw.indexOf('{');
      const endObj = raw.lastIndexOf('}');
      const startArr = raw.indexOf('[');
      const endArr = raw.lastIndexOf(']');
      let candidate = raw;
      if (startObj !== -1 && endObj !== -1) candidate = raw.substring(startObj, endObj + 1);
      else if (startArr !== -1 && endArr !== -1) candidate = raw.substring(startArr, endArr + 1);
      const parsed = JSON.parse(candidate);
      arrayFinal = normalizeResultArray(parsed.resultados ?? parsed);
    } catch (e) { /* mantém arrayFinal null, tratado abaixo */ }
  }

  if (arrayFinal) return { array: arrayFinal, usage };

  // Nota: rawPreview mostra só os primeiros 200 caracteres para não poluir o
  // log — não significa necessariamente que a resposta real foi cortada.
  // O aviso "(resposta possivelmente CORTADA...)" só aparece quando a API
  // confirma isso via finish_reason === 'length'.
  const cortada = finishReason === 'length' ? ' (resposta possivelmente CORTADA por limite de tokens)' : '';
  return { error: `Saída não continha um array de resultados válido${cortada}.`, usage, rawPreview };
}

// ────────────────────────────────────────────────────────────────────────────
// classifyRowJev: classifica UMA observação usando o Jev (TypeSafe), via
// Decisions API do OpenRouter (POST /api/alpha/decisions) — uma API
// ESTRUTURALMENTE diferente de /chat/completions, então esta função não
// reusa classifyBatchAPI por baixo. Em vez de "conversar" com o modelo,
// fazemos UMA pergunta sim/não com probabilidade (tipo "noul" da API) POR CATEGORIA, todas
// em paralelo na mesma chamada: "esta observação envolve a categoria X?".
//
// Por quê essa abordagem (em vez de um "Choice" só): perguntar sim/não pra
// cada categoria, em vez de escolher 1 de N, é o que naturalmente nos dá
// multi-categoria de graça — cada categoria tem sua própria probabilidade
// independente. A categoria com maior probabilidade (acima do limiar) vira
// "principal"; as demais acima do limiar viram "secundárias" (até 2).
//
// IMPORTANTE: Jev só aceita 1 "state" (1 observação) por chamada — não dá
// pra agrupar várias linhas da planilha como fazemos com os modelos de chat.
// Por isso o tamanho de lote fica travado em 1 quando esse provedor está
// selecionado (ver populateModelSelect). Em compensação, a saída (tokens de
// resposta) é GRATUITA nesse modelo — só se paga pela entrada.
//
// Retorna o MESMO formato de classifyBatchAPI — { array, usage } ou
// { error } ou { rateLimited, retryAfter } — para que processSubBatch possa
// chamar qualquer uma das duas funções sem precisar de lógica especial.
const JEV_PRINCIPAL_THRESHOLD = 0.5; // probabilidade mínima p/ virar "principal"
const JEV_SECONDARY_THRESHOLD = 0.5; // probabilidade mínima p/ virar "secundária"

async function classifyRowJev(apiKey, model, item, catNames, customContext) {
  const providerCfg = PROVIDERS.jev;

  // Uma pergunta (tipo "noul") independente por categoria — todas respondidas em
  // paralelo nesta única chamada (elas não "se veem" entre si).
  const questions = {};
  catNames.forEach((name, i) => {
    questions[`cat_${i + 1}`] = {
      type: 'noul',
      instructions: `A observação (ver "observacao" no estado) descreve um evento da categoria "${name}"? Considere o contexto do negócio informado em "contexto", se houver.`,
      criteria: {
        true: `A observação menciona algo claramente relacionado a: ${name}.`,
        false: 'A observação não trata disso.'
      }
    };
  });

  const body = {
    model,
    state: {
      observacao: item.obs,
      contexto: customContext || '(nenhum contexto adicional informado)'
    },
    questions
  };

  const resp = await fetch(providerCfg.baseURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...providerCfg.extraHeaders()
    },
    body: JSON.stringify(body)
  });

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '30');
    return { rateLimited: true, retryAfter };
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    return { error: err?.error?.message || `HTTP ${resp.status}` };
  }

  const data = await resp.json();
  const answers = data?.answers || {};

  // Monta a lista de { categoria, probabilidade } a partir das respostas.
  const probs = catNames.map((name, i) => ({
    id: i + 1,
    name,
    p: answers[`cat_${i + 1}`]?.noul ?? 0
  }));

  // ESCOLHA DA PRINCIPAL: usa a ORDEM DE PRIORIDADE estruturada (PRIORITY_ORDER),
  // não a maior probabilidade — Jev avalia cada categoria de forma
  // independente (não enxerga uma categoria ao julgar outra), então ele
  // sozinho não tem como aplicar a regra de negócio "Manutenção > Setup >
  // ...". Fazemos isso aqui: entre as categorias que passaram do limiar,
  // a que estiver mais acima na ordem de prioridade vira a principal — o
  // mesmo critério usado no prompt dos modelos de chat (buildPriorityRuleText).
  const idToPriorityRank = {}; // id posicional (1-based, igual ao de "probs") → posição na prioridade
  catNames.forEach((name, i) => {
    const stableId = CATEGORIES[i] ? CATEGORIES[i].id : null;
    const rank = PRIORITY_ORDER.indexOf(stableId);
    idToPriorityRank[i + 1] = rank === -1 ? 999 : rank;
  });

  const candidatos = probs
    .filter(c => c.p >= Math.min(JEV_PRINCIPAL_THRESHOLD, JEV_SECONDARY_THRESHOLD))
    .sort((a, b) => idToPriorityRank[a.id] - idToPriorityRank[b.id]); // mais prioritário primeiro

  const topCandidato = candidatos[0];
  const principal = (topCandidato && topCandidato.p >= JEV_PRINCIPAL_THRESHOLD) ? topCandidato.id : 0;
  const secundarias = candidatos
    .filter(c => c.id !== principal && c.p >= JEV_SECONDARY_THRESHOLD)
    .sort((a, b) => b.p - a.p) // secundárias ordenadas por probabilidade (não por prioridade)
    .slice(0, 2)
    .map(c => c.id);

  // Mapeia o "usage" do Jev (input_tokens/output_tokens, saída sempre
  // gratuita) para o mesmo formato prompt_tokens/completion_tokens usado
  // pelo resto do app (ver addLiveUsage).
  const usage = data?.usage
    ? { prompt_tokens: data.usage.input_tokens || 0, completion_tokens: data.usage.output_tokens || 0 }
    : null;

  return {
    array: [{ principal, secundarias }],
    usage,
    // Guardado para exibição opcional (ver buildExportData) — permite ao
    // usuário reavaliar os limiares manualmente no Excel sem rechamar a API.
    jevProbs: probs
  };
}

// ─── EXECUÇÃO MULTI-THREADED EM LOTES ─────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// Adiciona uma linha ao log detalhado de processamento (painel #processLog).
// level: 'info' | 'warn' | 'error' | 'success' | 'critical'
function logEvent(msg, level = 'info') {
  const panel = document.getElementById('processLog');
  panel.style.display = '';
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time">${time}</span><span class="log-${level}">${escHtml(msg)}</span>`;
  panel.appendChild(line);
  // Mantém o log com no máximo 300 linhas para não pesar a página em execuções longas.
  while (panel.children.length > 300) panel.removeChild(panel.firstChild);
  panel.scrollTop = panel.scrollHeight;
}

async function runQueue(provider, rows, apiKey, model, cats, customContext, onProgress) {
  const systemPrompt = buildSystemPrompt(cats, customContext);
  const catNames = cats;
  const output = new Array(rows.length).fill(null);
  // Jev usa uma API e um fluxo de chamada diferentes (ver classifyRowJev) —
  // esta flag desvia processSubBatch para esse caminho quando aplicável.
  const isJevProvider = !!(PROVIDERS[provider] && PROVIDERS[provider].isDecisionModel);

  let cursor = 0;
  let done = 0;
  let globalPause = 0;

  const WORKERS = +document.getElementById('concurrency').value;
  const BATCH_SIZE = +document.getElementById('batchSize').value;
  const MIN_INTERVAL = 300;

  // ─── DISJUNTOR DE SEGURANÇA (circuit breaker) ───────────────────────────────
  // Protege contra o cenário que você teve: falhas em cascata gerando dezenas
  // de chamadas de API por lote sem produzir resultado. Dois gatilhos:
  //
  //  a) FALHAS CONSECUTIVAS: se N lotes inteiros seguidos precisarem do
  //     fallback completo (sub-lotes + linha a linha), é sinal de problema
  //     sistêmico (prompt grande demais, modelo não respeita o formato,
  //     max_tokens insuficiente) — continuar não vai "consertar sozinho".
  //  b) TETO DE CUSTO: se o gasto real acumulado ultrapassar um múltiplo de
  //     segurança da estimativa pré-execução, paramos antes de gastar mais.
  const MAX_CONSECUTIVE_FULL_FAILURES = 2;
  let consecutiveFullBatchFailures = 0;
  const costCeiling = costSafetyCeiling || null; // definido ao clicar em "Processar" (app.js)

  function tripSafetyBreaker(reason) {
    if (stopRequested) return;
    stopRequested = true;
    logEvent(`🛑 PARADA AUTOMÁTICA DE SEGURANÇA: ${reason}`, 'critical');
    const alertBox = document.getElementById('safetyAlert');
    alertBox.textContent = `🛑 Processamento interrompido automaticamente. ${reason} Revise o log abaixo, ajuste as configurações (modelo, contexto, tamanho de lote) e rode novamente. Os resultados já obtidos foram mantidos.`;
    alertBox.classList.add('show');
  }

  function checkCostCeiling() {
    if (!costCeiling) return; // Groq (gratuito) ou estimativa indisponível
    const modelCfg = getSelectedModelConfig();
    const cost = (liveUsage.promptTokens / 1e6) * modelCfg.priceIn + (liveUsage.completionTokens / 1e6) * modelCfg.priceOut;
    if (cost > costCeiling) {
      tripSafetyBreaker(`Custo real (US$ ${cost.toFixed(4)}) ultrapassou o teto de segurança (US$ ${costCeiling.toFixed(4)}, ~5x a estimativa inicial).`);
    }
  }

  // Função auxiliar para processar um conjunto de itens (usada no lote principal e no fallback)
  // maxAttempts menor para fallbacks profundos (linha a linha) — se um único
  // item falha mesmo com max_tokens generoso, insistir raramente ajuda e só
  // multiplica o gasto.
  async function processSubBatch(items, label, maxAttempts = 3) {
    const userText = items.map((item, idx) => {
      const obsLimpa = item.obs.replace(/[\r\n\t]+/g, ' - ').replace(/"/g, "'").trim();
      return `${idx + 1}. ${obsLimpa}`;
    }).join('\n');

    // max_tokens é apenas um TETO de segurança — não é o que você paga.
    // O custo real é sempre baseado no "usage" retornado pela API (tokens
    // efetivamente gerados). Por isso é seguro dar bastante folga aqui para
    // não cortar a resposta no meio (ver comentário em classifyBatchAPI
    // sobre modelos com raciocínio interno). Cada item é um objeto
    // {"principal":N,"secundarias":[...]}, o que ocupa mais tokens de saída.
    const maxTokensEst = Math.max(500, items.length * 35 + 300);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (stopRequested) break;

      // Respeita pausas globais de Rate Limit
      while (globalPause > Date.now() && !stopRequested) {
        const remainingSec = Math.ceil((globalPause - Date.now()) / 1000);
        document.getElementById('progressText').textContent = `⏳ Sincronizando requisições com a API (${remainingSec}s)...`;
        await delay(1000);
      }
      if (stopRequested) break;

      // Jev: uma chamada por observação (items.length é sempre 1 aqui, pois
      // o tamanho de lote fica travado em 1 para este provedor). Modelos de
      // chat: chamada normal via /chat/completions, com o lote inteiro.
      const res = isJevProvider
        ? await classifyRowJev(apiKey, model, items[0], catNames, customContext)
        : await classifyBatchAPI(provider, apiKey, model, systemPrompt, userText, maxTokensEst, items.length);

      // Alimenta o painel de custo em tempo real com o consumo REAL desta
      // chamada (não afeta o fluxo de sucesso/erro abaixo).
      if (res.usage) {
        addLiveUsage(res.usage);
        checkCostCeiling();
        if (stopRequested) break;
      }

      if (res.rateLimited) {
        logEvent(`⏸ ${label}: rate limit atingido, aguardando ${res.retryAfter || 20}s...`, 'warn');
        const waitMs = ((res.retryAfter || 20) + 2) * 1000;
        globalPause = Math.max(globalPause, Date.now() + waitMs);

        let timeLeft = Math.ceil(waitMs / 1000);
        while (timeLeft > 0 && !stopRequested) {
          document.getElementById('progressText').textContent = `⏸ Rate Limit atingido. Aguardando ${timeLeft}s...`;
          await delay(1000);
          timeLeft--;
        }
        continue;
      }

      if (res.error) {
        const preview = res.rawPreview ? ` | Trecho da resposta: "${res.rawPreview}"` : '';
        logEvent(`❌ ${label}: tentativa ${attempt + 1}/${maxAttempts} falhou — ${res.error}${preview}`, 'error');
        await delay(1000);
        continue;
      }

      if (res.array) {
        if (res.array.length !== items.length) {
          logEvent(`⚠️ ${label}: desalinhamento (esperava ${items.length} resultados, recebeu ${res.array.length}).`, 'warn');
          return null;
        }
        // Retorna mapeado se deu tudo certo: cada item vira
        // { principal: '<nome da categoria>', secundarias: ['<nome>', ...] }
        // jevProbs (só presente no caminho Jev) é repassado adiante para
        // poder ser exportado, permitindo reavaliar limiares manualmente.
        return res.array.map(item => {
          const principal = (item.principal >= 1 && item.principal <= catNames.length)
            ? catNames[item.principal - 1] : 'Sem categoria';
          const secundarias = (item.secundarias || [])
            .filter(id => id >= 1 && id <= catNames.length && id !== item.principal)
            .map(id => catNames[id - 1]);
          return { principal, secundarias, jevProbs: res.jevProbs };
        });
      }
    }
    return null;
  }

  async function worker(initialDelay) {
    await delay(initialDelay);

    while (!stopRequested) {
      const currentStart = cursor;
      cursor += BATCH_SIZE;
      if (currentStart >= rows.length) break;

      const currentEnd = Math.min(currentStart + BATCH_SIZE, rows.length);
      const batchItems = rows.slice(currentStart, currentEnd);
      const batchLabel = `Lote (linhas ${currentStart + 1}-${currentEnd})`;

      // 1. Tenta o lote cheio
      document.getElementById('progressText').textContent = `🚀 Classificando ${batchItems.length} itens (linhas ${currentStart + 1}-${currentEnd})...`;
      logEvent(`🚀 ${batchLabel}: enviando ${batchItems.length} itens...`, 'info');
      let resultsMapeados = await processSubBatch(batchItems, batchLabel);
      let usedFallback = false;

      // 2. ROTINA DE SEGURANÇA: FALLBACK POR SUB-LOTES MENORES
      if (!resultsMapeados && !stopRequested) {
        usedFallback = true;
        logEvent(`🛡️ ${batchLabel}: lote principal falhou. Ativando sub-lotes de segurança...`, 'warn');
        document.getElementById('progressText').textContent = `🛡️ Desalinhamento no lote principal. Ativando Sub-Lotes de Segurança...`;
        resultsMapeados = [];

        const SUB_SIZE = Math.max(1, Math.ceil(batchItems.length / 2));

        for (let i = 0; i < batchItems.length; i += SUB_SIZE) {
          if (stopRequested) break;

          const subItems = batchItems.slice(i, i + SUB_SIZE);
          const subLabel = `${batchLabel} › sub-lote ${Math.floor(i / SUB_SIZE) + 1}`;
          document.getElementById('progressText').textContent = `🛡️ Processando sub-lote de segurança (${subItems.length} itens)...`;

          let subResults = await processSubBatch(subItems, subLabel, 2);

          if (!subResults && !stopRequested) {
            logEvent(`⚠️ ${subLabel}: também falhou. Tentando linha a linha (1 tentativa cada)...`, 'warn');
            document.getElementById('progressText').textContent = `⚠️ Sub-lote instável. Processando micro-itens linha por linha...`;
            subResults = [];
            for (const singleItem of subItems) {
              if (stopRequested) { subResults.push('Cancelado'); continue; }
              const singleRes = await processSubBatch([singleItem], `${subLabel} › item único`, 2);
              subResults.push(singleRes ? singleRes[0] : 'Sem categoria (Falha crítica)');
              await delay(250);
            }
          }

          resultsMapeados = resultsMapeados.concat(subResults || []);
        }
      }

      if (stopRequested && (!resultsMapeados || resultsMapeados.length === 0)) {
        resultsMapeados = new Array(batchItems.length).fill('Cancelado');
      }

      // resultsMapeados mistura dois formatos possíveis por item:
      // objeto { principal, secundarias } (caminho normal) ou a string
      // 'Cancelado'/'Sem categoria (Falha crítica)' (caminhos de erro). Esta
      // função extrai sempre o "principal" como string, seja qual for a forma.
      const principalOf = r => (r && typeof r === 'object') ? r.principal : r;

      // Atualiza o contador de falhas consecutivas (disjuntor de segurança).
      const falhasNoLote = (resultsMapeados || []).filter(r => {
        const p = principalOf(r);
        return !p || String(p).startsWith('Sem categoria') || p === 'Cancelado';
      }).length;
      const taxaFalha = batchItems.length ? falhasNoLote / batchItems.length : 0;
      if (usedFallback && taxaFalha > 0.3) {
        consecutiveFullBatchFailures++;
        if (consecutiveFullBatchFailures >= MAX_CONSECUTIVE_FULL_FAILURES && !stopRequested) {
          tripSafetyBreaker(`${consecutiveFullBatchFailures} lotes seguidos com alta taxa de falha (>30%) mesmo após fallback. Provável causa: modelo não está respeitando o formato JSON pedido, ou o contexto/categorias estão grandes demais para este modelo.`);
        }
      } else if (!usedFallback) {
        consecutiveFullBatchFailures = 0; // lote saudável reseta o contador
      }

      // Descarrega os resultados obtidos. "category" guarda a principal
      // (compatível com filtros/estatísticas existentes), e
      // "secondaryCategories" guarda a lista de secundárias (pode ser vazia).
      for (let b = 0; b < batchItems.length; b++) {
        const r = resultsMapeados[b];
        output[currentStart + b] = {
          ...batchItems[b],
          category: principalOf(r) || 'Sem categoria (Falha)',
          secondaryCategories: (r && typeof r === 'object' && Array.isArray(r.secundarias)) ? r.secundarias : [],
          jevProbs: (r && typeof r === 'object') ? r.jevProbs : undefined
        };
      }

      done += batchItems.length;
      if (!stopRequested) logEvent(`✅ ${batchLabel}: concluído (${falhasNoLote > 0 ? `${falhasNoLote} falha(s)` : 'sem falhas'}).`, falhasNoLote > 0 ? 'warn' : 'success');
      const amostragem = resultsMapeados ? principalOf(resultsMapeados[resultsMapeados.length - 1]) : null;
      onProgress(done, rows.length, amostragem, null);

      await delay(MIN_INTERVAL);
    }
  }

  const stagger = Math.floor(MIN_INTERVAL / WORKERS);
  const workers = Array.from({ length: WORKERS }, (_, wi) => worker(wi * stagger));
  await Promise.all(workers);

  return output;
}


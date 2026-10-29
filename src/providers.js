// ════════════════════════════════════════════════════════════════════════════
// providers.js — provedores de IA e modelos
//
// Endpoint, formato de chave, cabeçalhos extras e lista de modelos (com preço
// por milhão de tokens) de cada provedor suportado: Groq, OpenRouter e Jev.
// Para adicionar um modelo ou provedor, edite apenas este arquivo.
// ════════════════════════════════════════════════════════════════════════════

// ─── CONFIGURAÇÃO DE PROVEDORES E MODELOS DE IA ───────────────────────────────
// Este objeto centraliza tudo que é específico de cada provedor: endpoint da
// API, dica de formato da chave, link para obter a chave, e a lista de
// modelos disponíveis (com preço por milhão de tokens em USD).
//
// Os preços abaixo são valores de REFERÊNCIA e mudam com frequência: confira
// nas páginas oficiais de cada modelo antes de usar. O botão "Testar chave de
// API" valida só a conectividade, não o preço.
//
// priceIn / priceOut = US$ por 1.000.000 de tokens (entrada / saída).
// Modelos Groq são gratuitos no plano free, por isso priceIn/priceOut = 0.
const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1/chat/completions',
    keyPlaceholder: 'Cole sua chave gsk_...',
    keyHintHtml: 'Obtenha sua chave gratuitamente em <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a>',
    // Groq usa cabeçalho de autenticação padrão Bearer, sem headers extras.
    extraHeaders: () => ({}),
    models: [
      { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant ✅ (Rápido e gratuito)', priceIn: 0, priceOut: 0 },
      { id: 'llama3-8b-8192', label: 'llama3-8b-8192 (Alternativo rápido)', priceIn: 0, priceOut: 0 },
      { id: 'mixtral-8x7b-32768', label: 'mixtral-8x7b-32768 (Maior contexto)', priceIn: 0, priceOut: 0 },
      { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile (Mais preciso, consome mais cota)', priceIn: 0, priceOut: 0 },
    ]
  },
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1/chat/completions',
    keyPlaceholder: 'Cole sua chave sk-or-v1-...',
    keyHintHtml: 'Crie sua chave (defina o limite de gasto mensal, ex. US$5) em <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>',
    // OpenRouter recomenda (não obrigatório) enviar HTTP-Referer/X-Title para
    // identificar o app nos rankings deles. Não afeta custo nem funcionamento.
    extraHeaders: () => ({
      'HTTP-Referer': (typeof window !== 'undefined' ? window.location.href : 'https://local-app'),
      'X-Title': 'Classificador de Observações (Lotes)'
    }),
    // Modelos "flash" baratos, adequados para uma tarefa simples de
    // classificação de texto. Versões maiores ou mais novas custam mais e
    // trazem capacidades (multimodal, raciocínio pesado) desnecessárias aqui.
    // Para testar outro modelo, basta acrescentar uma entrada nesta lista.
    models: [
      { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash ✅ (equilíbrio custo/qualidade)', priceIn: 0.03, priceOut: 0.10 },
      { id: 'qwen/qwen3.7-flash', label: 'Qwen3.7 Flash', priceIn: 0.03, priceOut: 0.13 },
    ]
  },
  jev: {
    label: 'Jev (TypeSafe)',
    baseURL: 'https://openrouter.ai/api/alpha/decisions',
    keyPlaceholder: 'Cole sua chave sk-or-v1-... (mesma chave do OpenRouter)',
    keyHintHtml: 'Jev é servido pelo OpenRouter — use a mesma chave de <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>. Billing e limite de gasto são os mesmos da sua conta OpenRouter.',
    extraHeaders: () => ({}),
    // Flag usada em vários pontos do código para desviar para o fluxo de
    // chamada específico do Jev (Decisions API), que é estruturalmente
    // diferente de /chat/completions — ver classifyRowJev().
    isDecisionModel: true,
    // Jev não tem variantes de modelo como os LLMs de chat — só a versão
    // pinada e o alias "latest". Preço: cobra só tokens de ENTRADA; a saída é
    // gratuita (conforme a documentação do modelo na época do desenvolvimento).
    models: [
      { id: 'typesafe/jev-1.13', label: 'Jev 1.13 ✅ (versão fixa — recomendado p/ estabilidade)', priceIn: 0.042, priceOut: 0 },
      { id: '~typesafe/jev-latest', label: 'Jev Latest (sempre a versão mais nova — pode mudar sem aviso)', priceIn: 0.042, priceOut: 0 },
    ]
  }
};

// Provedor/modelo atualmente selecionados na interface.
// Padrão: OpenRouter com DeepSeek V4 Flash (bom equilíbrio custo/qualidade
// para classificação simples de texto).
let currentProvider = 'openrouter';

// Acumuladores de uso REAL de tokens durante o processamento (preenchidos a
// partir do campo "usage" retornado pela própria API a cada requisição).
let liveUsage = { promptTokens: 0, completionTokens: 0 };


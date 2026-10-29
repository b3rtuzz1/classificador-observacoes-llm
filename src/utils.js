// ════════════════════════════════════════════════════════════════════════════
// utils.js — funções utilitárias
//
// Correção de texto com acentos corrompidos (mojibake) e escape de HTML.
// Funções puras, sem dependência da interface.
// ════════════════════════════════════════════════════════════════════════════

// ─── CORREÇÃO AUTOMÁTICA DE MOJIBAKE (caracteres especiais mal formatados) ────
// Algumas planilhas exportadas de outros sistemas guardam texto UTF-8 que, em
// algum passo intermediário, foi DECODIFICADO como Latin-1/Windows-1252 e
// regravado — o resultado clássico é "ação" virar "aÃ§Ã£o". Isso não é um
// erro de leitura desta ferramenta: o problema já está gravado nos bytes do
// arquivo. A correção consiste em reinterpretar esses caracteres: tratá-los
// como se fossem bytes Latin-1 e decodificá-los de novo como UTF-8.
//
// Tabela de correspondência CP1252 → ponto de código Unicode, só para a faixa
// 0x80-0x9F (é exatamente aí que o Windows-1252 diverge do Latin-1 puro: aspas
// curvas, travessão, €, ‰ etc.). Ela é necessária porque, por exemplo, o byte
// 0x89 vira "‰" em CP1252 (em Latin-1 puro viraria um caractere de controle
// invisível), e esse é justamente o caso de textos como "Ã‰" (= "É").
const CP1252_REVERSE = {
  0x20AC:0x80, 0x201A:0x82, 0x0192:0x83, 0x201E:0x84, 0x2026:0x85, 0x2020:0x86,
  0x2021:0x87, 0x02C6:0x88, 0x2030:0x89, 0x0160:0x8A, 0x2039:0x8B, 0x0152:0x8C,
  0x017D:0x8E, 0x2018:0x91, 0x2019:0x92, 0x201C:0x93, 0x201D:0x94, 0x2022:0x95,
  0x2013:0x96, 0x2014:0x97, 0x02DC:0x98, 0x2122:0x99, 0x0161:0x9A, 0x203A:0x9B,
  0x0153:0x9C, 0x017E:0x9E, 0x0178:0x9F
};

// Heurística de segurança: só tentamos a correção quando a string contém a
// assinatura clássica desse problema ("Ã" ou "Â", presentes em praticamente
// toda palavra acentuada corrompida). Cada caractere é then reconvertido
// para o byte original (direto se ≤0xFF, via a tabela acima se for um dos
// símbolos especiais do CP1252); se APARECER qualquer caractere fora desse
// alcance, a string não é desse padrão de corrupção — abortamos e devolvemos
// o texto original, sem risco de corromper algo que já estava certo. Se o
// decode UTF-8 final falhar (sequência de bytes inválida), também mantemos
// o original.
function fixMojibake(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  if (!/[ÃÂ]/.test(str)) return str;

  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0xFF) { bytes.push(code); continue; }
    if (CP1252_REVERSE[code] !== undefined) { bytes.push(CP1252_REVERSE[code]); continue; }
    return str; // caractere fora do padrão CP1252/Latin-1 — não mexe
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch (e) {
    return str; // sequência de bytes inválida como UTF-8 — mantém original
  }
}

// Aplica fixMojibake recursivamente a todas as células de uma matriz de
// dados (linhas × colunas), preservando valores não-string (números, datas).
function fixMojibakeGrid(grid) {
  return grid.map(row => row.map(cell => (typeof cell === 'string' ? fixMojibake(cell) : cell)));
}

// Escapa caracteres especiais antes de inserir texto de planilha no HTML.
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

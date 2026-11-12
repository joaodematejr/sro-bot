// Aviso fixo de "por que parou" no topo do painel: a ultima parada importante,
// quando foi e o que fazer. Sai das mesmas linhas do log que viram aviso do
// Telegram; fica salvo (quem abre o app de manha ve o que houve de noite) ate o
// "x" ou ate o bot ser iniciado de novo.

export type NoticeLevel = "stop" | "warn" | "info";

export interface StopNotice {
  level: NoticeLevel;
  text: string;
  hint: string;
  at: number;
}

// [nivel, regra, texto (recebe o casamento), o que fazer]
const RULES: [NoticeLevel, RegExp, (m: RegExpMatchArray) => string, string][] = [
  ["stop", /^\[treino\] concluido: (.+?)\.?$/, (m) => `Treino parou: ${m[1]}.`, "Confira o ponto e o personagem no jogo e clique em Iniciar bot."],
  ["stop", /entrou em outro aparelho/, () => "A conta entrou em outro aparelho e o bot parou, sem relogar.", "Saia do outro aparelho e clique em Iniciar bot."],
  ["stop", /^falha ao reabrir: (.+)$/, (m) => `O jogo nao reabriu: ${m[1]}.`, "Clique em Abrir jogo. Se repetir, mande o diagnostico (Ferramentas)."],
  ["warn", /^Mochila cheia/, () => "Mochila cheia: o char para na zona segura sem repor pocao.", "Venda ou guarde itens no jogo."],
  ["warn", /^EXP\/h caiu (.+?)\./, (m) => `EXP/h caiu ${m[1]}.`, "Confira no jogo se o training time (x10) acabou."],
  ["info", /conexao com o servidor caiu/, () => "A conexao com o servidor caiu e o jogo foi reaberto sozinho.", "Nada a fazer se o bot voltou a cacar."],
  ["info", /^jogo congelado/, () => "O jogo congelou e foi reaberto sozinho.", "Nada a fazer se o bot voltou a cacar."],
];

export function noticeFromLog(line: string, now: number): StopNotice | undefined {
  const text = line.replace(/^\[\d\d:\d\d:\d\d\]\s*/, "").trim();
  for (const [level, re, fmt, hint] of RULES) {
    const m = text.match(re);
    if (m) return { level, text: fmt(m), hint, at: now };
  }
  return undefined;
}

// Bot iniciado de novo: a parada anterior ja foi tratada.
export function clearsNotice(line: string): boolean {
  return /^(\[\d\d:\d\d:\d\d\]\s*)?bot iniciado/.test(line.trim());
}

// Aviso mais leve nao cobre um mais grave que ainda esta na tela.
const RANK: Record<NoticeLevel, number> = { info: 0, warn: 1, stop: 2 };

export function nextNotice(cur: StopNotice | null, add: StopNotice): StopNotice {
  return cur && RANK[add.level] < RANK[cur.level] ? cur : add;
}

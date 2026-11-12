// Avisos no celular pelo Telegram: o usuario cria um bot no @BotFather, cola o
// token no app (fica no safeStorage) e manda qualquer mensagem pro bot; o app
// acha o chat pelo getUpdates. Os avisos saem das linhas do log, as mesmas que
// ja viram evento do historico.

export type AlertGroup = "problem" | "done";

export interface TelegramAlert {
  kind: string;
  group: AlertGroup;
  text: string;
}

// Linha do log que vira aviso. "problem" = algo pede atencao; "done" = atividade
// terminou.
const ALERT_RULES: [string, AlertGroup, RegExp][] = [
  ["morte", "problem", /\bmorreu \(/],
  ["queda", "problem", /conexao com o servidor caiu|jogo congelado/],
  ["reabrir", "problem", /^falha ao reabrir/],
  ["outro aparelho", "problem", /entrou em outro aparelho/],
  ["mochila", "problem", /^Mochila cheia/],
  ["exp", "problem", /^EXP\/h caiu/],
  ["unico", "problem", /^Unico por perto/],
  ["treino", "done", /^treino concluido/],
  ["continental", "done", /\[continental\] concluido/],
];

export function alertFromLog(line: string): TelegramAlert | undefined {
  const text = line.replace(/^\[\d\d:\d\d:\d\d\]\s*/, "").trim();
  for (const [kind, group, re] of ALERT_RULES) if (re.test(text)) return { kind, group, text: text.slice(0, 300) };
  return undefined;
}

// O mesmo aviso no maximo 1 vez a cada 10 min (queda em serie, EXP oscilando).
// Morte avisa sempre.
export const ALERT_REPEAT_MS = 10 * 60 * 1000;

export function alertDue(last: Record<string, number>, kind: string, now: number): boolean {
  if (kind === "morte") return true;
  const t = last[kind];
  return t === undefined || now - t >= ALERT_REPEAT_MS;
}

export function alertMessage(a: TelegramAlert, charName?: string): string {
  const who = charName && charName !== "-" ? `${charName}: ` : "";
  return `SRO Bot | ${who}${a.text}`;
}

// Token do @BotFather: "<numero>:<35 caracteres>".
export function validToken(t: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t.trim());
}

// Chat privado mais recente que falou com o bot (resposta do getUpdates).
export function chatFromUpdates(r: unknown): { id: number; name: string } | undefined {
  const res = (r as { ok?: boolean; result?: unknown[] })?.result;
  if (!Array.isArray(res)) return undefined;
  for (let i = res.length - 1; i >= 0; i--) {
    const chat = (res[i] as { message?: { chat?: { id?: unknown; type?: unknown; first_name?: unknown; username?: unknown } } })?.message?.chat;
    if (chat && chat.type === "private" && typeof chat.id === "number")
      return { id: chat.id, name: String(chat.first_name ?? chat.username ?? "") };
  }
  return undefined;
}

// Erro sem o token (a URL da API leva o token).
export function hideToken(msg: string, token: string): string {
  return token ? msg.split(token).join("***") : msg;
}

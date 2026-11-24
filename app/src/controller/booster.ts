// Buffs de item no Treino (autorizados pelo usuario em 2026-11-07): com o char
// cacando no ponto e sem buff do grupo valendo, usa um item da mochila. Cada
// grupo tem a propria validade. Logica pura; o main acha o item, usa e guarda.
//
// Usar item por metodo (provado ao vivo 2026-11-07 12:06, 850040006 29 -> 28 e o
// EXP foi de ~4 M/h pra ~6,7 M/h):
//   callx XBagDocument UseItem 3 -- o:XBagDocument|ItemBag|Items|get_Item:<i> u:0 u:1
// (OpType 0, quantidade 1). Com 2 args (OpType 1) o servidor respondeu "Item does not exist".

export interface Booster {
  id: number;
  name: string;
  minutes: number;
}

export type BuffKey = "exp" | "dano" | "vip" | "lure";

export interface BuffGroup {
  key: BuffKey;
  label: string;
  items: Booster[]; // ordem de uso
  buffId?: number; // buff no char: com ele lido, decide pelo buff e nao pela validade guardada
}

export const LURE_BUFF_ID = 338;

// Exp Booster: 200% de 1 h, 200% de 2 h, 100% de 1 h.
export const BOOSTERS: Booster[] = [
  { id: 850040006, name: "Exp Booster (200%) 1 hour", minutes: 60 },
  { id: 850040007, name: "Exp Booster (200%) 2 hours", minutes: 120 },
  { id: 850040004, name: "Exp Booster (100%) 1 hour", minutes: 60 },
];

// Dano (matar mais rapido = mais EXP/h): o de dano e absorcao primeiro, depois o
// so de dano. O so de absorcao (850040003) fica guardado: nao acelera a caca.
// VIP: +40 STR e +40 INT por 1 h. Duracoes da descricao do item.
export const BUFF_GROUPS: BuffGroup[] = [
  { key: "exp", label: "Exp Booster", items: BOOSTERS },
  {
    key: "dano",
    label: "pergaminho de dano",
    items: [
      { id: 850040001, name: "20% damage increase/absorption scroll", minutes: 30 },
      { id: 850040002, name: "20% damage increase scroll", minutes: 30 },
    ],
  },
  { key: "vip", label: "VIP STR/INT", items: [{ id: 850040014, name: "VIP Strength and Intellect Increase Scroll", minutes: 60 }] },
  // Lure: a Demonic Domain Flower puxa monstro num raio de 40 m (buff 338 no char).
  // Medido em 2026-11-10 sem ganho de EXP nos pontos 2 e 1 (HP minimo 87%);
  // ligado a pedido do usuario em 2026-11-24. A Normal (20 min) primeiro, a
  // Legendary I (1 h) depois. Decide pelo buff no char, entao volta sozinha
  // depois de reconectar ou de o buff cair antes da hora.
  {
    key: "lure",
    label: "flor (lure)",
    buffId: LURE_BUFF_ID,
    items: [
      { id: 850040036, name: "Demonic Domain Flower - Normal", minutes: 20 },
      { id: 850040035, name: "Demonic Domain Flower - Legendary I", minutes: 60 },
    ],
  },
];

export function pickBuff(items: Booster[], stock: Record<number, number | undefined>): Booster | undefined {
  return items.find((b) => (stock[b.id] ?? 0) > 0);
}

export function pickBooster(stock: Record<number, number | undefined>): Booster | undefined {
  return pickBuff(BOOSTERS, stock);
}

export function useItemBody(index: number): string {
  return `callx XBagDocument UseItem 3 -- o:XBagDocument|ItemBag|Items|get_Item:${Math.floor(index)} u:0 u:1`;
}

// Margem no fim: usa o proximo um pouco depois de acabar, nunca por cima.
export const BOOSTER_MARGIN_MS = 30 * 1000;

export function boosterUntil(b: Booster, usedAt: number): number {
  return usedAt + b.minutes * 60 * 1000 + BOOSTER_MARGIN_MS;
}

export function boosterDue(until: number, now: number): boolean {
  return now >= until;
}

// Grupo com buff lido no char: o buff manda (ativo, nao usa; ausente, usa mesmo
// com validade guardada, ex.: depois de reconectar). Sem leitura, vale a validade.
export function buffDue(active: boolean | undefined, until: number, now: number): boolean {
  return active === undefined ? boosterDue(until, now) : !active;
}

// Validade guardada: formato novo {exp: {until}, dano: {...}} ou o antigo
// {until} (so o Exp Booster, versao 0.101.0).
export function untilOf(saved: unknown, key: BuffKey): number {
  if (!saved || typeof saved !== "object") return 0;
  const s = saved as Record<string, unknown>;
  const g = s[key];
  if (g && typeof g === "object" && typeof (g as { until?: unknown }).until === "number") return (g as { until: number }).until;
  if (key === "exp" && typeof s.until === "number") return s.until;
  return 0;
}

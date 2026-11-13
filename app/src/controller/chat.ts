// Chat do jogo no painel, so leitura: XChatDocument GetChatInfoList:<canal> e a
// lista das ultimas ~200 mensagens de cada canal (a mais nova no fim; o jogo
// tira a do inicio quando passa de 200). Cada ChatInfo tem um id crescente, o
// que deixa ler so as novas. Responder fica de fora.

import type { EngineQuery } from "./tower";

// ChatChannelType do cliente. Amigos = conversas privadas (todas).
export const CHAT_CHANNELS = [
  { id: 1, key: "mundo", label: "Mundo" },
  { id: 2, key: "guilda", label: "Guilda" },
  { id: 7, key: "party", label: "Party" },
  { id: 3, key: "privado", label: "Privado" },
] as const;

export type ChatChannelKey = (typeof CHAT_CHANNELS)[number]["key"];

export interface ChatMessage {
  id: number;
  from: string;
  to: string; // so no privado
  text: string;
  self: boolean;
  at: number; // epoch ms (0 = hora nao lida)
}

// Primeira leitura de um canal: so as ultimas, pra nao fazer 1000 GETP de uma vez.
export const CHAT_FIRST_READ = 30;
export const CHAT_KEEP = 200;

export function chatChannelId(key: string): number | undefined {
  return CHAT_CHANNELS.find((c) => c.key === key)?.id;
}

// Tira as marcas de cor e estilo do NGUI ([55A9FF], [-], [b], [/u]...) e emote
// solto; o resto do texto fica como veio.
export function cleanChatText(s: string): string {
  return s.replace(/\[(?:[0-9a-fA-F]{6}|-|\/?[bius]|\/?sub|\/?sup|\/?url(?:=[^\]]*)?)\]/g, "").trim();
}

// mTime e um System.DateTime local do aparelho (Kind nos 2 bits de cima). O GETP
// le os 32 bits de baixo (mTime) e os de cima (mTime+4). tzOffsetMin = fuso do
// aparelho em minutos (UTC+8 = 480).
export function chatTimeMs(lo: number, hi: number, tzOffsetMin: number): number {
  const ticks = (BigInt(hi & 0x3fffffff) << 32n) | BigInt(lo >>> 0);
  if (ticks === 0n) return 0;
  return Number((ticks - 621355968000000000n) / 10000n) - tzOffsetMin * 60000;
}

// "+0800" / "-0300" (date +%z) em minutos.
export function parseTzOffset(s: string): number | undefined {
  const m = /([+-])(\d{2})(\d{2})/.exec(s);
  if (!m) return undefined;
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -v : v;
}

// Le as mensagens do canal com id maior que sinceId, da mais velha pra mais
// nova. Sem sinceId (primeira leitura) le so as ultimas CHAT_FIRST_READ.
export async function readChatChannel(
  q: EngineQuery,
  channel: number,
  sinceId: number,
  tzOffsetMin: number,
  max = CHAT_FIRST_READ,
): Promise<ChatMessage[] | null> {
  const L = `XChatDocument GetChatInfoList:${channel}`;
  const nr = await q("GETP", `${L} get_Count`);
  if (nr.ok !== true) return String(nr.erro ?? "").includes("campo nulo") ? [] : null; // canal sem mensagem
  const n = typeof nr.int === "number" ? nr.int : 0;
  const num = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const str = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.str === "string" ? r.str : "";
  };
  const out: ChatMessage[] = [];
  for (let i = n - 1; i >= 0 && out.length < max; i--) {
    const base = `${L} get_Item:${i}`;
    const id = await num(`${base} id`);
    if (id === undefined) break; // lista mudou no meio: le de novo na proxima
    if (i === n - 1 && id < sinceId) sinceId = -1; // jogo reaberto: ids recomecaram
    if (id <= sinceId) break;
    const self = (await q("GETP", `${base} isSelfSender`)).bool === true;
    out.push({
      id,
      from: await str(`${base} mSenderName`),
      to: channel === 3 ? await str(`${base} mReceiverName`) : "",
      text: cleanChatText(await str(`${base} mContent`)),
      self,
      at: chatTimeMs((await num(`${base} mTime`)) ?? 0, (await num(`${base} mTime+4`)) ?? 0, tzOffsetMin),
    });
  }
  return out.reverse();
}

// Junta o que ja estava no painel com as novas (sem repetir id), ate CHAT_KEEP.
// Com o jogo reaberto os ids recomecam: fica so a leitura nova.
export function mergeChat(prev: ChatMessage[], fresh: ChatMessage[], keep = CHAT_KEEP): ChatMessage[] {
  const last = prev.length ? prev[prev.length - 1].id : -1;
  if (fresh.length && fresh[fresh.length - 1].id < last) return fresh.slice(-keep); // ids recomecaram
  const all = prev.concat(fresh.filter((m) => m.id > last));
  return all.length > keep ? all.slice(all.length - keep) : all;
}

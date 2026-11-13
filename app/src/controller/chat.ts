// Chat do jogo no painel: XChatDocument GetChatInfoList:<canal> e a
// lista das ultimas ~200 mensagens de cada canal (a mais nova no fim; o jogo
// tira a do inicio quando passa de 200). Cada ChatInfo tem um id crescente, o
// que deixa ler so as novas. Responder vai pelo comando say do engine, que chama
// o mesmo SendChatContent do botao Enviar do jogo.

import type { EngineQuery } from "./tower";

// ChatChannelType do cliente. Amigos = conversas privadas (todas). cdSec e level
// vem da ChatTable do jogo (GetRawData:<canal>, lida em 2026-11-13): o Mundo pede
// Lv.10 e 20 s entre mensagens.
export const CHAT_CHANNELS = [
  { id: 1, key: "mundo", label: "Mundo", cdSec: 20, level: 10 },
  { id: 2, key: "guilda", label: "Guilda", cdSec: 1, level: 0 },
  { id: 7, key: "party", label: "Party", cdSec: 1, level: 0 },
  { id: 3, key: "privado", label: "Privado", cdSec: 0, level: 0 },
] as const;

// Limite de texto da ChatTable (length) e o maximo que o say do engine aceita.
export const CHAT_MAX_CHARS = 200;
export const CHAT_MAX_BYTES = 1000;

export type ChatChannelKey = (typeof CHAT_CHANNELS)[number]["key"];

export interface ChatMessage {
  id: number;
  from: string;
  to: string; // so no privado
  peerId: string; // privado: roleid (64 bits) do outro lado da conversa; "" nos outros
  peer: string; // privado: nome do outro lado
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
    const from = await str(`${base} mSenderName`);
    const to = channel === 3 ? await str(`${base} mReceiverName`) : "";
    // O GETP le 32 bits: o roleid vem em duas metades.
    const who = self ? "mReceiverId" : "mSenderId";
    const peerId = channel === 3 ? roleId((await num(`${base} ${who}`)) ?? 0, (await num(`${base} ${who}+4`)) ?? 0) : "";
    out.push({
      id,
      from,
      to,
      peerId,
      peer: channel === 3 ? (self ? to : from) : "",
      text: cleanChatText(await str(`${base} mContent`)),
      self,
      at: chatTimeMs((await num(`${base} mTime`)) ?? 0, (await num(`${base} mTime+4`)) ?? 0, tzOffsetMin),
    });
  }
  return out.reverse();
}

// roleid de 64 bits a partir das metades do GETP, em texto (passa do Number).
export function roleId(lo: number, hi: number): string {
  return ((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)).toString();
}

export interface ChatSendCheck {
  ok: boolean;
  erro?: string;
  text: string;
}

// Confere antes de mandar: canal conhecido, texto de 1 a 200 caracteres (ate
// 1000 bytes), nivel e o intervalo do canal desde a ultima mensagem, e destino
// no privado. O jogo ainda passa o texto pelo filtro de palavras dele.
export function chatSendCheck(key: string, raw: string, opts: { level?: number; lastSentAt?: number; now: number; to?: string }): ChatSendCheck {
  const c = CHAT_CHANNELS.find((x) => x.key === key);
  const text = raw.replace(/\s+/g, " ").trim();
  if (!c) return { ok: false, erro: "canal desconhecido", text };
  if (!text) return { ok: false, erro: "mensagem vazia", text };
  if ([...text].length > CHAT_MAX_CHARS) return { ok: false, erro: `mensagem passa de ${CHAT_MAX_CHARS} caracteres`, text };
  if (new TextEncoder().encode(text).length > CHAT_MAX_BYTES) return { ok: false, erro: "mensagem longa demais", text };
  if (c.level && opts.level !== undefined && opts.level < c.level) return { ok: false, erro: `o ${c.label} pede Lv.${c.level}`, text };
  const wait = opts.lastSentAt ? c.cdSec * 1000 - (opts.now - opts.lastSentAt) : 0;
  if (wait > 0) return { ok: false, erro: `espere ${Math.ceil(wait / 1000)} s (o ${c.label} aceita 1 mensagem a cada ${c.cdSec} s)`, text };
  if (c.id === 3 && !/^[1-9]\d*$/.test(opts.to ?? "")) return { ok: false, erro: "escolha pra quem responder (clique numa mensagem do privado)", text };
  return { ok: true, text };
}

// Corpo do SKIL say: canal, destino e o texto UTF-8 em hex.
export function sayBody(channel: number, to: string, text: string): string {
  const hex = [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `say ${channel} ${channel === 3 ? to : "0"} ${hex}`;
}

// Junta o que ja estava no painel com as novas (sem repetir id), ate CHAT_KEEP.
// Com o jogo reaberto os ids recomecam: fica so a leitura nova.
export function mergeChat(prev: ChatMessage[], fresh: ChatMessage[], keep = CHAT_KEEP): ChatMessage[] {
  const last = prev.length ? prev[prev.length - 1].id : -1;
  if (fresh.length && fresh[fresh.length - 1].id < last) return fresh.slice(-keep); // ids recomecaram
  const all = prev.concat(fresh.filter((m) => m.id > last));
  return all.length > keep ? all.slice(all.length - keep) : all;
}

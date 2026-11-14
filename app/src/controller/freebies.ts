// Gratis do dia, lidos no XMainClient.dll descompilado e pegos ao vivo no char principal em
// 2026-11-10 (Diamond e Silk iguais antes e depois):
//
//   Event Pack -> Premium Shop > Event (PremiumShopEventPackageItem). O botao mostra
//                 "Free" e pega sem dialogo quando DiamondPrice == 0:
//                 XRechargeDocument.BuyPackageLimitedTime(id). Lista da aba:
//                 GetValidPackageLimitedTimeInfo (id, buycount); config em
//                 GetPackageLimitedTimeConfig(id) (DiamondPrice, LimitBuyCount, Type:
//                 1 fixo, 2 diario, 3 semanal, 4 mensal). O 202 (diario) foi de 0/1 a 1/1.
//   Attendance -> Welfare > sign-in do mes (XLoginRewardDocument). ReqCheckin com o
//                 dia de hoje JA marcado e o "re-sign" PAGO de dia perdido
//                 (XLoginRewardView: IsTodayChecked -> GetReplenishCost): so com
//                 IsTodayChecked falso. Acumulado de 7/14/21/28 dias:
//                 ReqCummulativeCheckin(dia), com o bit (1 << dia) livre em
//                 CumulativeRewardTime. Veio "Dumpling*5" (3 -> 4 dias).
//   Daily Pack -> Welfare > caixinha de cima (XWelfareGiftBagHandler.DailyGift1):
//                 XWelfareDocument.GetLittleGiftBag (RpcC2G_GetPayReward, sem
//                 argumento; no servidor freeDailyRewardTime), so com
//                 RewardLittleGiftBag == 0 (o padrao do jogo e 1). Veio "Gold*10000".
//                 Os pacotes da lista dessa aba sao dinheiro real (SDKRecharge): nunca.
//   Guilda     -> baus do sign-in progress (20, 40, 80, 120): XGuildSignInDocument
//                 ReqAllInfo, get_Progress, GetBoxTableData [n] process, IsBoxOpen:n,
//                 ReqFetchBox(n) (o mesmo do Guild utilities, que so roda na virada; o
//                 progresso sobe no dia com os outros membros). Em 2026-11-10 13:09 do
//                 servidor o progresso estava em 80 com os baus de 20/40/80 fechados:
//                 abertos deram 27.000 gold, 4 Dissolve Stone e 1 Pet Eggs - Precious.
//   Lucky Money-> red envelopes da guilda (XGuildSignRedPackageView, print de 2026-11-10):
//                 o lider ou vice distribui das 20:00 as 22:00 do servidor (UTC+8; 09:00
//                 as 11:00 em Brasilia), cada membro pega ate 4 por dia. Lista:
//                 XGuildRedPacketDocument ReqList, m_PacketList (uid, fetchState 0 =
//                 FS_CAN_FETCH, fetchedCount/maxCount, senderName); pegar = ReqFetch(uid)
//                 (RpcC2G_GetGuildBonusReward), gratis. O botao "Sent<N>" da tela e o
//                 pedido ao lider ja usado (segundos de espera), nao premio.
//   Support    -> Guild > Activity > Support (XGuildDonateDocument): pedidos de ajuda do
//                 Firm dos membros. SendGetDonateBaseInfo, _dailyDonateItemList (name,
//                 id, itemID, needCount, getCount, itemType 0 = item exato), limite
//                 DailyTaskDonateNum (10) contra _dailyDonatedNum. Doar =
//                 SendDonateMemberItem(id, n, null): +60 de contribuicao por item
//                 (2026-11-10, feito a mao pelo usuario). So com "Doar no Support"
//                 ligado (o usuario liberou doar o que o char tiver).
//   Correio    -> anexos (XMailDocument, lido ao vivo em 2026-11-14). ReqMailInfo pede a
//                 pagina atual (7 por pagina) e enche `mails` (MailItem: ID uint64, State
//                 0 NONE, 1 CLAIMED, 2 REWARD, Title); CtlPage(true) vai pra proxima.
//                 Pegar = ReqMailOP(MailOP.Claim 2, uid). Ha duas ReqMailOP de 2 args; a
//                 de uint64 vem antes nos metadados e e a que o engine acha pelo nome.
//                 Sem a tela do correio aberta o jogo nao mostra nada.
//   Online     -> premio por tempo online (XOnlineRewardDocument): Status por faixa (0
//                 contando, 1 liberado, 2 pego), QueryStatus atualiza; pegar =
//                 SendGetReward(faixa). Em 2026-11-14 as 4 faixas estavam pegas.
// Correio e online podem trazer Diamond ou Silk: neles o saldo pode subir, nunca cair.

import type { EngineQuery } from "./tower";

export interface FreePack {
  id: number;
  price: number; // DiamondPrice
  limit: number; // LimitBuyCount
  bought: number;
  type: number;
}

export interface GuildBoxState {
  index: number;
  need: number; // process da tabela
  open: boolean;
}

export interface RedPacket {
  uid: number;
  canFetch: boolean; // fetchState 0, com sobra (fetched < max) e remetente
}

export interface DonateAsk {
  id: number;
  name: string;
  itemId: number;
  need: number;
  got: number;
  have: number; // no inventario do char
}

export interface RewardMail {
  uid: string; // uint64 em texto
  title: string;
}

export interface FreebiesSnapshot {
  inWorld: boolean;
  me?: string;
  donateAsks: DonateAsk[]; // so os de item exato (itemType 0)
  donatedToday?: number;
  donateLimit?: number;
  firmNeeds: number[]; // itens das tarefas do Firm de hoje ainda nao entregues
  redPackets: RedPacket[];
  guildProgress: number;
  guildBoxes: GuildBoxState[]; // vazio sem guilda
  packs: FreePack[]; // os da aba Event (validos agora)
  todayChecked?: boolean; // undefined = nao lido
  dayChecked: number;
  cumulativeDays: number[];
  cumulativeTaken: number; // bits (1 << dia)
  littleGift?: number; // 0 = caixinha liberada
  mails?: RewardMail[]; // da pagina lida, so os com anexo por pegar
  online?: number[]; // Status de cada faixa do premio por tempo online
  diamond?: number;
  silk?: number;
}

// `gain`: o pedido pode trazer Diamond/Silk (correio, online); o saldo pode subir.
export type FreebieStep =
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "act"; key: string; name: string; body: string; gain?: boolean };

export const MAIL_FETCH_BODY = "calls XMailDocument ReqMailInfo 0";
export const MAIL_NEXT_PAGE_BODY = "callx XMailDocument CtlPage 1 -- b:1";
export const MAIL_PREV_PAGE_BODY = "callx XMailDocument CtlPage 1 -- b:0";
export const ONLINE_QUERY_BODY = "calls XOnlineRewardDocument QueryStatus 0";

export function mailClaimBody(uid: string): string {
  if (!/^[1-9]\d{0,19}$/.test(uid)) throw new Error(`uid de correio invalido: ${uid}`);
  return `callx XMailDocument ReqMailOP 2 -- i:2 q:${uid}`;
}

const PACK_TYPE: Record<number, string> = { 1: "fixo", 2: "diario", 3: "semanal", 4: "mensal" };

export const FREEBIES_INFO_BODY = "calls XRechargeDocument ReqPackageLimitedTimeInfos 0";
export const GUILD_SIGNIN_INFO_BODY = "calls XGuildSignInDocument ReqAllInfo 0";
export const RED_PACKET_LIST_BODY = "calls XGuildRedPacketDocument ReqList 0";
export const DONATE_INFO_BODY = "calls XGuildDonateDocument SendGetDonateBaseInfo 0";

// Janela do Lucky Money: 20:00 as 22:00 do servidor (UTC+8) = 12:00 as 14:00 UTC, com
// 15 min de folga no fim. Nela o card confere a cada 5 min.
export function luckyMoneyWindow(now: number): boolean {
  const min = (Math.floor(now / 60000) % 1440 + 1440) % 1440;
  return min >= 12 * 60 && min < 14 * 60 + 15;
}
export const DIAMOND_BODY = "XBagDocument GetVirtualItemCount:9";
export const SILK_BODY = "XBagDocument GetVirtualItemCount:7";

// Cartoes de privilegio (Premium Shop > Privilege), lidos no XMainClient.dll e ao
// vivo em 2026-11-11: XWelfareDocument _payMemberInfo (PayMemberRecord: get_id,
// get_expiretime em s, get_lastfetchdailyreward = dia do ultimo premio diario) e a
// PayMemberTable (1 Silver, 2 Golden, 3 Premium Card, 28 dias cada). O premio diario
// so sai pelo botao do bau da aba (XWelfareKingdomPrivilegeHandler.OnChestClick, que
// manda o FetchPayMemberReward com o ID do botao): o bot abre a aba e chama o
// handler pelo callxm, que acha o botao na thread principal do jogo.
export interface PayCard {
  id: number;
  expire: number; // s
  lastFetch: number; // dia (ver payCardDay)
}
export const PAY_CARD_NAMES: Record<number, string> = { 1: "Silver Card", 2: "Golden Card", 3: "Premium Card" };
export const PAY_CARDS_INFO_BODY = "calls XWelfareDocument ReqPayAllInfo 0";
// Aba Privilege do Premium Shop (XSys_Welfare_KingdomPrivilege_Court = 568).
export const PAY_SHOP_OPEN_BODY = "callsi XPremiumShopDlg ShowWorkGameSystem 1 568 0";
export const PAY_SHOP_CLOSE_BODY = "calls XPremiumShopDlg SetVisible 2 0 1";
export const PAY_CLAIM_BODY =
  'callxm XWelfareDocument _payMemberPrivilegeHandler OnChestClick 1 -- o:XWelfareDocument|_payMemberPrivilegeHandler|m_AfterBuy|Find:"Chest"|GetComponent:"XUISprite"';
// Depois do premio o jogo mostra os itens no RewardDlg.
export const REWARD_CLOSE_BODY = "calls RewardDlg SetVisible 2 0 1";

// Dia do premio diario do cartao, como o XWelfareDocument.CheckPayMemberChest: vira
// as 05:00 do servidor (o fuso vem do XServerTimeMgr, 8 no servidor do usuario).
export function payCardDay(nowMs: number, tzHours: number): number {
  return Math.floor((nowMs + (tzHours * 3600 - 18000) * 1000) / 86400000);
}

// Cartoes ativos (vencem em mais de 1 s, como o CheckMemberPrivilegeType) com o premio
// de hoje por pegar. Cartao vencido nao tem premio.
export function payCardsToClaim(cards: PayCard[], nowMs: number, tzHours: number): PayCard[] {
  const day = payCardDay(nowMs, tzHours);
  const nowS = Math.floor(nowMs / 1000);
  return cards.filter((c) => PAY_CARD_NAMES[c.id] && c.expire - nowS > 1 && c.lastFetch !== day);
}

export async function readPayCards(q: EngineQuery): Promise<{ cards: PayCard[]; tz?: number }> {
  const int = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const L = "XWelfareDocument _payMemberInfo";
  const n = (await int(`${L} get_Count`)) ?? 0;
  const cards: PayCard[] = [];
  for (let i = 0; i < Math.min(n, 10); i++) {
    const id = await int(`${L} get_Item:${i} get_id`);
    const expire = await int(`${L} get_Item:${i} get_expiretime`);
    const lastFetch = await int(`${L} get_Item:${i} get_lastfetchdailyreward`);
    if (id === undefined || expire === undefined || lastFetch === undefined) continue;
    // O GETP le 32 bits com sinal: a data em s passa de 2^31 em 2038, nao antes.
    cards.push({ id, expire: expire >>> 0, lastFetch });
  }
  return { cards, tz: await int("XServerTimeMgr get_ServerTimeZone") };
}

// Um pedido por vez; cada um so uma vez por passada (`tried`). `checkedToday`: o
// attendance ja foi pego neste dia do jogo pelo app (trava a mais contra o re-sign
// pago, mesmo se a leitura vier velha).
export function nextFreebieStep(s: FreebiesSnapshot | null, tried: Set<string>, checkedToday: boolean, donate = false): FreebieStep {
  if (!s) return { kind: "fail", reason: "engine fora" };
  if (!s.inWorld) return { kind: "fail", reason: "char fora de mundo" };
  if (s.diamond === undefined || s.silk === undefined) return { kind: "fail", reason: "Diamond/Silk nao lidos" };
  const p = s.packs.find((k) => k.price === 0 && k.limit > 0 && k.bought < k.limit && !tried.has(`pack${k.id}`));
  if (p)
    return { kind: "act", key: `pack${p.id}`, name: `pegar o pacote gratis ${p.id} (${PACK_TYPE[p.type] ?? `tipo ${p.type}`}) do Event`, body: `callsi XRechargeDocument BuyPackageLimitedTime 1 ${p.id} 0` };
  if (s.todayChecked === false && !checkedToday && !tried.has("checkin"))
    return { kind: "act", key: "checkin", name: `marcar o attendance de hoje (${s.dayChecked} dia(s) no mes)`, body: "calls XLoginRewardDocument ReqCheckin 0" };
  const d = s.cumulativeDays.find((n) => n > 0 && n < 31 && s.dayChecked >= n && (s.cumulativeTaken & (1 << n)) === 0 && !tried.has(`cum${n}`));
  if (d !== undefined)
    return { kind: "act", key: `cum${d}`, name: `pegar o premio de ${d} dias do attendance`, body: `callsi XLoginRewardDocument ReqCummulativeCheckin 1 ${d} 0` };
  const b = s.guildBoxes.find((x) => !x.open && x.need > 0 && s.guildProgress >= x.need && !tried.has(`gbox${x.index}`));
  if (b)
    return { kind: "act", key: `gbox${b.index}`, name: `abrir o bau de ${b.need} do sign-in da guilda (progresso ${s.guildProgress})`, body: `callsi XGuildSignInDocument ReqFetchBox 1 ${b.index} 0` };
  const r = s.redPackets.find((x) => x.canFetch && !tried.has(`red${x.uid}`));
  if (r)
    return { kind: "act", key: `red${r.uid}`, name: `pegar o red envelope ${r.uid} da guilda (Lucky Money)`, body: `callx XGuildRedPacketDocument ReqFetch 1 -- u:${r.uid}` };
  const left = s.donateLimit !== undefined && s.donatedToday !== undefined ? s.donateLimit - s.donatedToday : 0;
  if (donate && left > 0) {
    const a = s.donateAsks.find((x) => x.name !== s.me && x.got < x.need && x.have > 0 && x.itemId > 0
      && !s.firmNeeds.includes(x.itemId) && !tried.has(`don${x.id}`));
    if (a) {
      const n = Math.min(a.have, a.need - a.got, left);
      return { kind: "act", key: `don${a.id}`, name: `doar ${n}x item ${a.itemId} a ${a.name} no Support da guilda (${a.got}/${a.need})`, body: `callx XGuildDonateDocument SendDonateMemberItem 3 -- u:${a.id} u:${n} n:` };
    }
  }
  if (s.littleGift === 0 && !tried.has("little"))
    return { kind: "act", key: "little", name: "pegar a caixinha gratis do Daily Pack", body: "calls XWelfareDocument GetLittleGiftBag 0" };
  const o = (s.online ?? []).findIndex((st, i) => st === 1 && !tried.has(`online${i}`));
  if (o >= 0)
    return { kind: "act", key: `online${o}`, name: `pegar o premio por tempo online (faixa ${o + 1})`, body: `callsi XOnlineRewardDocument SendGetReward 1 ${o} 0`, gain: true };
  const m = (s.mails ?? []).find((x) => !tried.has(`mail${x.uid}`));
  if (m)
    return { kind: "act", key: `mail${m.uid}`, name: `pegar o anexo do correio "${m.title}"`, body: mailClaimBody(m.uid), gain: true };
  return { kind: "done", reason: freebiesSummary(s) };
}

export function freebiesSummary(s: FreebiesSnapshot): string {
  const free = s.packs.filter((k) => k.price === 0);
  const parts = [free.length ? `Event: ${free.map((k) => `${k.id} ${k.bought}/${k.limit}`).join(", ")}` : "Event: nenhum gratis na aba"];
  parts.push(s.todayChecked === undefined ? "attendance nao lido" : `attendance ${s.todayChecked ? "marcado" : "pendente"} (${s.dayChecked} dia(s))`);
  parts.push(s.littleGift === undefined ? "caixinha nao lida" : s.littleGift === 0 ? "caixinha liberada" : "caixinha pega");
  if (s.online?.length) parts.push(`online ${s.online.filter((x) => x === 2).length}/${s.online.length} faixa(s) pega(s)`);
  if (s.mails?.length) parts.push(`${s.mails.length} anexo(s) no correio`);
  if (s.redPackets.length) parts.push(`${s.redPackets.length} red envelope(s) da guilda, ${s.redPackets.filter((x) => x.canFetch).length} pra pegar`);
  if (s.guildBoxes.length) {
    const next = s.guildBoxes.find((x) => !x.open && s.guildProgress < x.need);
    parts.push(`guilda ${s.guildProgress} de progresso${next ? `, proximo bau com ${next.need}` : ", baus do sign-in abertos"}`);
  }
  return parts.join("; ");
}

// Anexos por pegar na pagina do correio que o jogo tem em memoria (State 2 = REWARD).
// O ID e uint64: le as duas metades de 32 bits.
export async function readRewardMails(q: EngineQuery): Promise<RewardMail[]> {
  const int = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const M = "XMailDocument mails";
  const n = (await int(`${M} get_Count`)) ?? 0;
  const out: RewardMail[] = [];
  for (let i = 0; i < Math.min(n, 7); i++) {
    const b = `${M} get_Item:${i}`;
    if ((await int(`${b} State`)) !== 2) continue;
    const lo = await int(`${b} ID`);
    const hi = await int(`${b} ID+4`);
    if (lo === undefined || hi === undefined) continue;
    const uid = ((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)).toString();
    if (uid === "0") continue;
    const title = (await q("GETP", `${b} Title`)).str;
    out.push({ uid, title: typeof title === "string" ? title : "?" });
  }
  return out;
}

export async function readMailPages(q: EngineQuery): Promise<{ page: number; pages: number }> {
  const page = (await q("GETP", "XMailDocument currPage")).int;
  const pages = (await q("GETP", "XMailDocument pagesCnt")).int;
  return { page: typeof page === "number" ? page : 0, pages: typeof pages === "number" ? pages : 0 };
}

// Le o estado. Os pacotes vem da lista que a aba Event mostra.
export async function readFreebiesSnapshot(q: EngineQuery): Promise<FreebiesSnapshot | null> {
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;
  const s: FreebiesSnapshot = { inWorld: player.ok === true, me: typeof player.name === "string" ? player.name : undefined, donateAsks: [], firmNeeds: [], redPackets: [], guildProgress: 0, guildBoxes: [], packs: [], dayChecked: 0, cumulativeDays: [], cumulativeTaken: 0 };
  if (!s.inWorld) return s;
  const int = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const L = "XRechargeDocument GetValidPackageLimitedTimeInfo";
  const n = (await int(`${L} get_Count`)) ?? 0;
  for (let i = 0; i < Math.min(n, 80); i++) {
    const id = await int(`${L} get_Item:${i} get_id`);
    if (!id) continue;
    const C = `XRechargeDocument GetPackageLimitedTimeConfig:${id}`;
    const price = await int(`${C} DiamondPrice`);
    const limit = await int(`${C} LimitBuyCount`);
    const type = await int(`${C} Type`);
    if (price === undefined || limit === undefined || type === undefined) continue;
    s.packs.push({ id, price, limit, type, bought: (await int(`${L} get_Item:${i} get_buycount`)) ?? limit });
  }
  const D = "XLoginRewardDocument";
  const today = await q("GETP", `${D} IsTodayChecked`);
  if (today.ok === true) s.todayChecked = today.bool === true;
  s.dayChecked = (await int(`${D} get_DayChecked`)) ?? 0;
  const nc = (await int(`${D} get_CumulativeDay get_Count`)) ?? 0;
  for (let i = 0; i < Math.min(nc, 10); i++) {
    const d = await int(`${D} get_CumulativeDay get_Item:${i}`);
    if (d) s.cumulativeDays.push(d);
  }
  s.cumulativeTaken = ((await int(`${D} get_CumulativeRewardTime`)) ?? -1) >>> 0;
  s.littleGift = await int("XWelfareDocument get_RewardLittleGiftBag");
  s.online = [];
  const O = "XOnlineRewardDocument Status";
  const no = (await int(`${O} get_Count`)) ?? 0;
  for (let i = 0; i < Math.min(no, 12); i++) s.online.push((await int(`${O} get_Item:${i}`)) ?? -1);
  s.mails = await readRewardMails(q);
  if ((await q("GETP", "XGuildDocument get_bInGuild")).bool === true) {
    const G = "XGuildSignInDocument";
    s.guildProgress = (await int(`${G} get_Progress`)) ?? 0;
    for (let i = 0; i < 8; i++) {
      const need = await int(`${G} GetBoxTableData [${i}] process`);
      if (need === undefined || need <= 0) break;
      s.guildBoxes.push({ index: i, need, open: (await q("GETP", `${G} IsBoxOpen:${i}`)).bool !== false });
    }
    const DD = "XGuildDonateDocument";
    s.donatedToday = await int(`${DD} _dailyDonatedNum`);
    s.donateLimit = await int("XGlobalConfig GetInt:\"DailyTaskDonateNum\"");
    const nd = (await int(`${DD} _dailyDonateItemList get_Count`)) ?? 0;
    for (let i = 0; i < Math.min(nd, 40); i++) {
      const b = `${DD} _dailyDonateItemList get_Item:${i}`;
      if ((await int(`${b} itemType`)) !== 0) continue;
      const id = await int(`${b} id`);
      const itemId = await int(`${b} itemID`);
      const need = await int(`${b} needCount`);
      const got = await int(`${b} getCount`);
      const name = (await q("GETP", `${b} name`)).str;
      if (id === undefined || !itemId || need === undefined || got === undefined || typeof name !== "string") continue;
      s.donateAsks.push({ id, name, itemId, need, got, have: (await int(`XBagDocument GetItemCount:${itemId},0`)) ?? 0 });
    }
    const FT = "XGuildDailyTaskDocument _curGuildDailyTaskList";
    const nt = (await int(`${FT} get_Count`)) ?? 0;
    for (let i = 0; i < Math.min(nt, 12); i++) {
      if ((await q("GETP", `${FT} get_Item:${i} isRewarded`)).bool === true) continue;
      const tid = await int(`${FT} get_Item:${i} taskID`);
      const it = tid ? await int(`XGuildDailyTaskDocument GetDailyTaskTableInfoByID:${tid} conditionId [#0]`) : undefined;
      if (it) s.firmNeeds.push(it);
    }
    const R = "XGuildRedPacketDocument m_PacketList";
    const nr = (await int(`${R} get_Count`)) ?? 0;
    for (let i = 0; i < Math.min(nr, 30); i++) {
      const b = `${R} get_Item:${i}`;
      const uid = await int(`${b} uid`);
      const state = await int(`${b} fetchState`);
      const fetched = await int(`${b} fetchedCount`);
      const max = await int(`${b} maxCount`);
      const sender = (await q("GETP", `${b} senderName`)).str;
      if (!uid || uid < 0) continue;
      s.redPackets.push({ uid, canFetch: state === 0 && max !== undefined && fetched !== undefined && fetched < max && typeof sender === "string" && sender.length > 0 });
    }
  }
  s.diamond = await int(DIAMOND_BODY);
  s.silk = await int(SILK_BODY);
  return s;
}

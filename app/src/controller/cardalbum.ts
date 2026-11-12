// Album de cards (Card Collect / Book) por metodo (mapeado ao vivo via engine):
//
//   XCardCollectDocument get_GroupMax -> 7 (grupos 1..7)
//   XCardCollectDocument get_HasCardList -> XBetterDictionary<Int32, Int32> (cardId -> qtd)
//   XCardCollectDocument get_CardsGroupInfo get_Item:<gid> (XDeck):
//     m_CurStarLevel, StarLevelMAX, ActionNum, redPoint, CardList, combDic
//   XCardCollectDocument GetCardGroup:<gid>: GroupName, OpenLevel, BreakLevel
//   XCardCollectDocument combDic m_bufferValues get_Item:<i> (XCardCombination):
//     status (CardCombinationStatus: None=0, CanActive=1, NoCanActive=2, Activated=3)
//     starPostion (List<Int32>: offsets iniciais na StarFireCondition por estrela 0..StarLevelMAX)
//     data (CardsGroup.RowData): TeamId, TeamName, StarFireCondition (SeqListRef<UInt32>)
//   StarFireCondition: cada fatia [starPostion[s] .. starPostion[s+1]) tem cabecalho
//     (numCards, 0) seguido por pares (cardId, count) em uintBuffer[#ix] e [#ix+1].
//   Inteligencia das sobras: soma o total necessario de cada card em TODOS os grupos
//     e conjuntos ainda nao ativados da estrela atual ate StarLevelMAX; so o que passar
//     disso (owned - neededTotal > 0) vira excedente seguro pra quebrar via ReqBreak.

import { seqHeader, u16Of } from "./build";

export const CARD_DOC = "XCardCollectDocument";

export const COMB_STATUS = {
  None: 0,
  CanActive: 1,
  NoCanActive: 2,
  Activated: 3,
} as const;

export type CardQuality = "normal" | "blue" | "purple" | "gold" | "red";

export const CARD_QUALITIES: readonly CardQuality[] = ["normal", "blue", "purple", "gold", "red"];

// ItemQuality (enum): C=1, B=2, A=3, S=4, L=5.
export function cardQualityFromItemQuality(raw: number | undefined): CardQuality | undefined {
  if (raw === undefined) return undefined;
  switch (raw & 0xff) {
    case 1:
      return "normal";
    case 2:
      return "blue";
    case 3:
      return "purple";
    case 4:
      return "gold";
    case 5:
      return "red";
    default:
      return undefined;
  }
}

export interface CardRequirement {
  cardId: number;
  count: number;
}

export interface CardSetRule {
  setId: number;
  groupId: number;
  status: number;
  active: boolean;
  canActive: boolean;
  starRequirements: Readonly<Record<number, readonly CardRequirement[]>>;
}

export interface CardGroupState {
  groupId: number;
  name?: string;
  currentStar: number;
  maxStar: number;
  actionNum: number;
  redPoint?: number;
  breakLevels?: readonly number[];
  sets: readonly CardSetRule[];
}

export interface CardMeta {
  cardId: number;
  groupId: number;
  quality: CardQuality;
  name?: string;
}

export interface CardAlbumConfig {
  activateSets: boolean;
  upgradeStars: boolean;
  breakDuplicates: boolean;
  allowedQualities: readonly CardQuality[];
  targetGroupId?: number;
}

export const DEFAULT_CARDALBUM_CONFIG: CardAlbumConfig = {
  activateSets: true,
  upgradeStars: true,
  breakDuplicates: false,
  allowedQualities: ["normal", "blue"],
};

export interface CardAlbumSnapshot {
  inWorld: boolean;
  inCombat?: boolean;
  tablesLoaded: boolean;
  level?: number;
  groups: readonly CardGroupState[];
  ownedCounts: ReadonlyMap<number, number>;
  cardMeta: ReadonlyMap<number, CardMeta>;
}

export interface CardSurplusItem {
  cardId: number;
  name?: string;
  groupId: number;
  quality: CardQuality;
  owned: number;
  neededTotal: number;
  surplus: number;
}

export type CardAlbumStep =
  | { kind: "act"; key: string; name: string; body: string; preBody?: string; op: "activate" | "upgrade" | "break"; cardId?: number; count?: number }
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string };

// Decodifica pares brutos (u0, u1) da StarFireCondition pelas posicoes starPostion.
// Cada fatia comeca em (numCards, 0) e segue com (cardId, count).
export function parseStarFireCondition(
  rows: readonly (readonly [number, number])[],
  starPositions: readonly number[],
  maxStar: number,
): Record<number, CardRequirement[]> {
  const out: Record<number, CardRequirement[]> = {};
  const limit = Math.min(maxStar + 1, starPositions.length);
  for (let s = 0; s < limit; s++) {
    const start = starPositions[s];
    const end = s + 1 < starPositions.length ? starPositions[s + 1] : rows.length;
    if (start < 0 || start >= rows.length) continue;
    const reqs: CardRequirement[] = [];
    for (let i = start; i < Math.min(end, rows.length); i++) {
      const [u0, u1] = rows[i];
      if (u0 > 0 && u1 > 0) reqs.push({ cardId: u0, count: u1 });
    }
    out[s] = reqs;
  }
  return out;
}

// Soma tudo que ainda falta de cada carta, em TODOS os grupos, da estrela atual
// ate StarLevelMAX. Conjuntos ja ativados na estrela atual contam so da proxima
// estrela em diante.
export function neededCardsTotal(groups: readonly CardGroupState[]): Map<number, number> {
  const needed = new Map<number, number>();
  for (const g of groups) {
    for (const set of g.sets) {
      for (let st = g.currentStar; st <= g.maxStar; st++) {
        if (st === g.currentStar && set.active) continue;
        const reqs = set.starRequirements[st];
        if (!reqs) continue;
        for (const r of reqs) {
          if (r.cardId <= 0 || r.count <= 0) continue;
          needed.set(r.cardId, (needed.get(r.cardId) ?? 0) + r.count);
        }
      }
    }
  }
  return needed;
}

// Calcula apenas as sobras realmente seguras (owned - neededTotal > 0), filtrando
// por raridade permitida e exigindo tabelas carregadas + metadados da carta.
export function computeCardSurplus(
  s: CardAlbumSnapshot,
  cfg: Pick<CardAlbumConfig, "allowedQualities" | "targetGroupId">,
): CardSurplusItem[] {
  if (!s.tablesLoaded) return [];
  const neededMap = neededCardsTotal(s.groups);
  const allowed = new Set(cfg.allowedQualities);
  const out: CardSurplusItem[] = [];
  const entries = [...s.ownedCounts.entries()].sort((a, b) => a[0] - b[0]);
  for (const [cardId, owned] of entries) {
    if (owned <= 0) continue;
    const meta = s.cardMeta.get(cardId);
    if (!meta || !allowed.has(meta.quality)) continue;
    if (cfg.targetGroupId && cfg.targetGroupId > 0 && meta.groupId !== cfg.targetGroupId) continue;
    const neededTotal = neededMap.get(cardId) ?? 0;
    const surplus = owned - neededTotal;
    if (surplus > 0) {
      out.push({
        cardId,
        name: meta.name,
        groupId: meta.groupId,
        quality: meta.quality,
        owned,
        neededTotal,
        surplus,
      });
    }
  }
  return out;
}

export function canUpgradeGroupStar(g: CardGroupState, playerLevel?: number): boolean {
  if (g.currentStar >= g.maxStar) return false;
  if (!g.sets.length) return false;
  if (g.actionNum < g.sets.length && (g.redPoint ?? 0) <= 0) return false;
  if (!g.sets.every((s) => s.active)) return false;
  if (playerLevel !== undefined && g.breakLevels && g.currentStar < g.breakLevels.length) {
    const reqLevel = g.breakLevels[g.currentStar];
    if (reqLevel > 0 && playerLevel < reqLevel) return false;
  }
  return true;
}

export function reqActiveBody(setId: number): string {
  return `callx ${CARD_DOC} ReqActive 1 -- u:${Math.floor(setId)}`;
}

export function selectGroupBody(groupId: number): string {
  return `callx ${CARD_DOC} Select 1 -- u:${Math.floor(groupId)}`;
}

export function reqUpStarBody(): string {
  return `calls ${CARD_DOC} ReqUpStar 0`;
}

export function reqBreakBody(cardId: number, count: number): string {
  return `callx ${CARD_DOC} ReqBreak 2 -- i:${Math.floor(cardId)} i:${Math.floor(count)}`;
}

function cardLabel(meta: CardMeta | undefined, cardId: number): string {
  return meta?.name ? `${meta.name} (${cardId})` : `card ${cardId}`;
}

export function nextCardAlbumStep(
  s: CardAlbumSnapshot | null,
  cfg: CardAlbumConfig,
  tried: ReadonlySet<string>,
): CardAlbumStep {
  if (!s || !s.inWorld) return { kind: "fail", reason: "char fora de mundo" };
  if (!s.tablesLoaded) return { kind: "fail", reason: "tabelas do album nao carregaram por completo" };

  const scope = cfg.targetGroupId && cfg.targetGroupId > 0
    ? s.groups.filter((g) => g.groupId === cfg.targetGroupId)
    : s.groups;

  if (cfg.activateSets) {
    for (const g of scope) {
      for (const set of g.sets) {
        if (set.active || !set.canActive) continue;
        const key = `act:${set.setId}:${g.currentStar}`;
        if (tried.has(key)) continue;
        return {
          kind: "act",
          key,
          op: "activate",
          name: `ativar combinacao ${set.setId} (${g.name ?? `grupo ${g.groupId}`}, ${g.currentStar}*)`,
          body: reqActiveBody(set.setId),
        };
      }
    }
  }

  if (cfg.upgradeStars) {
    for (const g of scope) {
      if (!canUpgradeGroupStar(g, s.level)) continue;
      const key = `up:${g.groupId}:${g.currentStar}`;
      if (tried.has(key)) continue;
      return {
        kind: "act",
        key,
        op: "upgrade",
        name: `subir estrela do grupo ${g.name ?? g.groupId} (${g.currentStar}* -> ${g.currentStar + 1}*)`,
        preBody: selectGroupBody(g.groupId),
        body: reqUpStarBody(),
      };
    }
  }

  if (cfg.breakDuplicates) {
    const surplus = computeCardSurplus(s, cfg);
    for (const item of surplus) {
      const key = `brk:${item.cardId}:${item.surplus}`;
      if (tried.has(key)) continue;
      const meta = s.cardMeta.get(item.cardId);
      return {
        kind: "act",
        key,
        op: "break",
        cardId: item.cardId,
        count: item.surplus,
        name: `quebrar ${item.surplus}x ${cardLabel(meta, item.cardId)} [${item.quality}] (possui ${item.owned}, precisa ${item.neededTotal})`,
        body: reqBreakBody(item.cardId, item.surplus),
      };
    }
  }

  return { kind: "done", reason: "sem combinacoes prontas, upgrades ou sobras pra quebrar" };
}

type Query = (tag: string, body: string) => Promise<Record<string, unknown>>;

const intOf = (r: Record<string, unknown>) => (r.ok === true && typeof r.int === "number" ? r.int : undefined);
const strOf = (r: Record<string, unknown>) => (r.ok === true && typeof r.str === "string" ? r.str : undefined);

export interface StaticSetDef {
  setId: number;
  maxStar: number;
  starRequirements: Readonly<Record<number, readonly CardRequirement[]>>;
}

export interface StaticGroupDef {
  groupId: number;
  name?: string;
  maxStar: number;
  breakLevels: readonly number[];
  sets: readonly StaticSetDef[];
}

export interface CardStaticCache {
  cardMeta: Map<number, CardMeta>;
  groups: Map<number, StaticGroupDef>;
  idxLen?: number;
  uintLen?: number;
  indexWords: Map<string, number>;
  uintPairs: Map<string, [number, number]>;
}

export function createCardStaticCache(): CardStaticCache {
  return { cardMeta: new Map(), groups: new Map(), indexWords: new Map(), uintPairs: new Map() };
}

export interface SerializedCardStaticCache {
  version: 1;
  cardMeta: CardMeta[];
  groups: StaticGroupDef[];
}

export function exportCardStaticCache(cache: CardStaticCache): SerializedCardStaticCache {
  return {
    version: 1,
    cardMeta: [...cache.cardMeta.values()],
    groups: [...cache.groups.values()],
  };
}

export function importCardStaticCache(raw: unknown): CardStaticCache {
  const cache = createCardStaticCache();
  if (!raw || typeof raw !== "object") return cache;
  const r = raw as Partial<SerializedCardStaticCache>;
  if (r.version !== 1 || !Array.isArray(r.cardMeta) || !Array.isArray(r.groups)) return cache;
  for (const m of r.cardMeta) {
    if (m && typeof m.cardId === "number" && typeof m.quality === "string") cache.cardMeta.set(m.cardId, m);
  }
  for (const g of r.groups) {
    if (g && typeof g.groupId === "number" && Array.isArray(g.sets)) cache.groups.set(g.groupId, g);
  }
  return cache;
}

async function readCardMeta(q: Query, cardId: number, groupId: number, cache: CardStaticCache): Promise<CardMeta | undefined> {
  const cached = cache.cardMeta.get(cardId);
  if (cached) {
    if (cached.groupId === 0 && groupId > 0) cached.groupId = groupId;
    return cached;
  }
  const qRaw = intOf(await q("GETP", `XBagDocument GetItemConf:${cardId} ItemQuality`));
  const quality = cardQualityFromItemQuality(qRaw);
  if (!quality) return undefined;
  const key = strOf(await q("GETP", `XBagDocument GetItemConf:${cardId} ItemName GetValue:0`));
  const loc = key ? strOf(await q("GETP", `Localization Localize:"${key}"`)) : undefined;
  const name = loc && loc !== key ? loc : undefined;
  const meta: CardMeta = { cardId, groupId, quality, name };
  cache.cardMeta.set(cardId, meta);
  return meta;
}

async function readStarFireRows(
  q: Query,
  sfPath: string,
  cache: CardStaticCache,
): Promise<{ n: number; rows: [number, number][] } | undefined> {
  const h = seqHeader(intOf(await q("GETP", `${sfPath}+8`)), intOf(await q("GETP", `${sfPath}+12`)));
  if (!h || h.n > 64) return undefined;
  const rows: [number, number][] = [];
  for (let k = 0; k < h.n; k++) {
    const j = h.off + k;
    const wordIdx = j >> 1;
    let w: number | undefined = cache.idxLen !== undefined ? cache.indexWords.get(`${cache.idxLen}:${wordIdx}`) : undefined;
    if (w === undefined) {
      const rw = await q("GETP", `${sfPath} indexBuffer [#${wordIdx}:1:0]`);
      w = intOf(rw);
      if (w === undefined) return undefined;
      if (typeof rw.len === "number") {
        cache.idxLen = rw.len;
        cache.indexWords.set(`${rw.len}:${wordIdx}`, w);
      }
    }
    const ix = u16Of(w, j);
    let pair: [number, number] | undefined = cache.uintLen !== undefined ? cache.uintPairs.get(`${cache.uintLen}:${ix}`) : undefined;
    if (!pair) {
      const r0 = await q("GETP", `${sfPath} uintBuffer [#${ix}]`);
      const r1 = await q("GETP", `${sfPath} uintBuffer [#${ix + 1}]`);
      const u0 = intOf(r0);
      const u1 = intOf(r1);
      if (u0 === undefined || u1 === undefined) return undefined;
      pair = [u0, u1];
      if (typeof r0.len === "number") {
        cache.uintLen = r0.len;
        cache.uintPairs.set(`${r0.len}:${ix}`, pair);
      }
    }
    rows.push(pair);
  }
  return { n: h.n, rows };
}

export async function readCardAlbumSnapshot(
  q: Query,
  cache: CardStaticCache = createCardStaticCache(),
): Promise<CardAlbumSnapshot | null> {
  const gmax = intOf(await q("GETP", `${CARD_DOC} get_GroupMax`));
  if (gmax === undefined || gmax <= 0) return null;

  const inCombat = (await q("GETP", "XLevelStatistics get_IsInFightingState")).bool === true;
  const level = intOf(await q("GETP", "XEntityMgr GetAll get_Item:0 get_Attributes get_Level"));

  const hasSize = intOf(await q("GETP", `${CARD_DOC} get_HasCardList size`));
  if (hasSize === undefined) {
    return { inWorld: true, inCombat, tablesLoaded: false, level, groups: [], ownedCounts: new Map(), cardMeta: cache.cardMeta };
  }

  const ownedCounts = new Map<number, number>();
  for (let i = 0; i < hasSize; i++) {
    const cid = intOf(await q("GETP", `${CARD_DOC} get_HasCardList m_bufferKeys get_Item:${i}`));
    const cnt = intOf(await q("GETP", `${CARD_DOC} get_HasCardList m_bufferValues get_Item:${i}`));
    if (cid === undefined || cnt === undefined) {
      return { inWorld: true, inCombat, tablesLoaded: false, level, groups: [], ownedCounts, cardMeta: cache.cardMeta };
    }
    if (cid > 0 && cnt > 0) ownedCounts.set(cid, cnt);
  }

  const groups: CardGroupState[] = [];
  for (let gid = 1; gid <= gmax; gid++) {
    const deck = `${CARD_DOC} get_CardsGroupInfo get_Item:${gid}`;
    const curStar = intOf(await q("GETP", `${deck} m_CurStarLevel`));
    const maxStar = intOf(await q("GETP", `${deck} StarLevelMAX`));
    const actionNum = intOf(await q("GETP", `${deck} ActionNum`));
    const redPoint = intOf(await q("GETP", `${deck} redPoint`)) ?? 0;
    const combSize = intOf(await q("GETP", `${deck} combDic size`));
    if (curStar === undefined || maxStar === undefined || actionNum === undefined || combSize === undefined) {
      return { inWorld: true, inCombat, tablesLoaded: false, level, groups, ownedCounts, cardMeta: cache.cardMeta };
    }

    let gDef = cache.groups.get(gid);
    if (!gDef) {
      const gKey = strOf(await q("GETP", `${CARD_DOC} GetCardGroup:${gid} GroupName`));
      const gLoc = gKey ? strOf(await q("GETP", `Localization Localize:"${gKey}"`)) : undefined;
      const groupName = gLoc && gLoc !== gKey ? gLoc : undefined;
      const bLen = intOf(await q("GETP", `${CARD_DOC} GetCardGroup:${gid} BreakLevel get_Length`)) ?? 0;
      const breakLevels: number[] = [];
      for (let bi = 0; bi < bLen; bi++) {
        const bv = intOf(await q("GETP", `${CARD_DOC} GetCardGroup:${gid} BreakLevel [#${bi}]`));
        if (bv !== undefined) breakLevels.push(bv);
      }

      const cardListLen = intOf(await q("GETP", `${deck} CardList get_Count`)) ?? 0;
      for (let ci = 0; ci < cardListLen; ci++) {
        const cid = intOf(await q("GETP", `${deck} CardList get_Item:${ci} CardId`));
        if (cid !== undefined && cid > 0) await readCardMeta(q, cid, gid, cache);
      }

      const staticSets: StaticSetDef[] = [];
      for (let si = 0; si < combSize; si++) {
        const pref = `${deck} combDic m_bufferValues get_Item:${si}`;
        const setId = intOf(await q("GETP", `${pref} data TeamId`));
        const spCount = intOf(await q("GETP", `${pref} starPostion get_Count`));
        if (setId === undefined || spCount === undefined) {
          return { inWorld: true, inCombat, tablesLoaded: false, level, groups, ownedCounts, cardMeta: cache.cardMeta };
        }
        const sp: number[] = [];
        for (let k = 0; k < spCount; k++) {
          const v = intOf(await q("GETP", `${pref} starPostion get_Item:${k}`));
          if (v === undefined) {
            return { inWorld: true, inCombat, tablesLoaded: false, level, groups, ownedCounts, cardMeta: cache.cardMeta };
          }
          sp.push(v);
        }
        const sf = await readStarFireRows(q, `${pref} data StarFireCondition`, cache);
        if (!sf) {
          return { inWorld: true, inCombat, tablesLoaded: false, level, groups, ownedCounts, cardMeta: cache.cardMeta };
        }
        staticSets.push({
          setId,
          maxStar,
          starRequirements: parseStarFireCondition(sf.rows, sp, maxStar),
        });
      }
      gDef = { groupId: gid, name: groupName, maxStar, breakLevels, sets: staticSets };
      cache.groups.set(gid, gDef);
    }

    if (gDef.sets.length !== combSize) {
      cache.groups.delete(gid);
      return { inWorld: true, inCombat, tablesLoaded: false, level, groups, ownedCounts, cardMeta: cache.cardMeta };
    }

    const sets: CardSetRule[] = [];
    for (let si = 0; si < combSize; si++) {
      const pref = `${deck} combDic m_bufferValues get_Item:${si}`;
      const status = intOf(await q("GETP", `${pref} status`));
      if (status === undefined) {
        return { inWorld: true, inCombat, tablesLoaded: false, level, groups, ownedCounts, cardMeta: cache.cardMeta };
      }
      const sd = gDef.sets[si];
      sets.push({
        setId: sd.setId,
        groupId: gid,
        status,
        active: status === COMB_STATUS.Activated,
        canActive: status === COMB_STATUS.CanActive,
        starRequirements: sd.starRequirements,
      });
    }

    groups.push({
      groupId: gid,
      name: gDef.name,
      currentStar: curStar,
      maxStar,
      actionNum,
      redPoint,
      breakLevels: gDef.breakLevels,
      sets,
    });
  }

  for (const cardId of ownedCounts.keys()) {
    if (!cache.cardMeta.has(cardId)) await readCardMeta(q, cardId, 0, cache);
  }

  return { inWorld: true, inCombat, tablesLoaded: true, level, groups, ownedCounts, cardMeta: cache.cardMeta };
}


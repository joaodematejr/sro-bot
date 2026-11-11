// Guild utilities por metodo (mapeado ao vivo no char principal em 2026-11-07):
//
//   Na guilda   -> XGuildDocument get_bInGuild
//   Sign-in     -> XGuildSignInDocument ReqAllInfo (pede o estado); get_SignInSelection
//                  (0 = ainda nao assinou hoje, senao o tipo usado); ReqSignIn(tipo).
//                  Tabela GetSignInTableData [n]: tipo 1 custa 25.000 gold, tipo 2
//                  50.000 gold (o "Luxury"), tipo 3 custa 20 Silk (item 7): NUNCA.
//   Baus        -> GetBoxTableData [n] process (20, 40, 80, 120) contra get_Progress;
//                  IsBoxOpen:n; ReqFetchBox(n). De graca.
//   Salario     -> XGuildSalaryDocument SendAskGuildWageInfo; get_RewardState
//                  (WageRewardState: cannot 1, rewarded 2, notreward 3 = pode pegar);
//                  SendGuildWageReward. Deu +161.500 gold e +2.500 de contribuicao.
//   Red packet  -> XGuildRedPacketDocument ReqList; get_bHasAvailableRedPacket. Pegar
//                  ainda nao foi visto ao vivo (nenhum disponivel): so avisa.

export type SignInMode = "off" | "normal" | "luxury";

// Tipo do ReqSignIn e o custo em gold. O tipo 3 (Silk) fica de fora de proposito.
export const SIGNIN_TYPES: Record<Exclude<SignInMode, "off">, { type: number; gold: number }> = {
  normal: { type: 1, gold: 25000 },
  luxury: { type: 2, gold: 50000 },
};

export interface GuildConfig {
  signIn: SignInMode;
  chests: boolean; // baus de progresso do sign-in
  salary: boolean;
  redPacket: boolean;
  storeWeekly?: boolean; // compra o limite semanal dos itens de GUILD_STORE_WEEKLY (gasta contribuicao)
}

export const DEFAULT_GUILD_CONFIG: GuildConfig = { signIn: "normal", chests: true, salary: true, redPacket: true };

// Loja da guilda (Guild Store) por metodo, lida no XMainClient.dll e ao vivo em
// 2026-11-11: e a loja generica (XNormalShopDocument) no sistema XSys_Mall_Guild
// (324). ReqGoodsList(324) enche o m_goodsList (XNormalShopGoods: item itemID,
// priceType = moeda, priceValue = preco em float, weeklyBuyCount); o limite
// semanal vem da ShopTable (GetDataById:<uid> WeekCountCondition). Comprar:
// ReqBuy(indice), 1 unidade por pedido (a outra entrada, DoBuyItem, tem duas
// versoes com 2 args). Provado: 1 Pet Eggs - Precious por 500 de contribuicao.
// A contagem da semana zera no domingo; a loja diz o que ainda da pra comprar.
export const GUILD_STORE_SYS = 324;
export const GUILD_CONTRIBUTION = 22; // XBagDocument GetVirtualItemCount:22
export const GUILD_STORE_LIST_BODY = `callsi XNormalShopDocument ReqGoodsList 1 ${GUILD_STORE_SYS} 0`;
export const GUILD_STORE_WEEKLY: { itemId: number; name: string }[] = [
  { itemId: 605, name: "Pet Eggs - Precious" }, // 500, 8 por semana
  { itemId: 606, name: "Pet Eggs - Rare" }, // 1000, 3 por semana
  { itemId: 85, name: "Dimension Hole - Forgotten World" }, // 400, 2 por semana (o de moeda 89 fica de fora)
];
export const guildStoreBuyBody = (index: number) => `callsi XNormalShopDocument ReqBuy 1 ${Math.floor(index)} 0`;

export interface StoreGoods {
  index: number;
  itemId: number;
  priceType: number;
  price: number;
  week: number; // comprado nesta semana
  weekLimit: number; // 0 = sem limite semanal (nao entra)
}

// Proximo item a comprar: so os da lista, so pagos com contribuicao, so com limite
// semanal e ainda abaixo dele, e com saldo pra pagar. undefined = nada a comprar.
export function nextStoreBuy(goods: StoreGoods[], contribution: number): StoreGoods | undefined {
  for (const want of GUILD_STORE_WEEKLY) {
    const g = goods.find((x) => x.itemId === want.itemId && x.priceType === GUILD_CONTRIBUTION && x.weekLimit > 0);
    if (g && g.week < g.weekLimit && g.price > 0 && contribution >= g.price) return g;
  }
  return undefined;
}

export function storeWeeklyText(goods: StoreGoods[]): string {
  return GUILD_STORE_WEEKLY.map((w) => {
    const g = goods.find((x) => x.itemId === w.itemId && x.priceType === GUILD_CONTRIBUTION && x.weekLimit > 0);
    return g ? `${w.name} ${g.week}/${g.weekLimit}` : `${w.name} fora da loja`;
  }).join(", ");
}

// Float guardado como bits no int do GETP.
function bitsToFloat(i: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setInt32(0, i, true);
  return b.getFloat32(0, true);
}

// Le os itens da loja que interessam (pedir a lista antes com GUILD_STORE_LIST_BODY).
export async function readStoreGoods(q: EngineQuery): Promise<StoreGoods[]> {
  const int = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  if ((await int("XNormalShopDocument m_curSysType")) !== GUILD_STORE_SYS) return [];
  const L = "XNormalShopDocument m_goodsList";
  const n = (await int(`${L} get_Count`)) ?? 0;
  const out: StoreGoods[] = [];
  for (let i = 0; i < Math.min(n, 80); i++) {
    const b = `${L} get_Item:${i}`;
    const itemId = await int(`${b} item itemID`);
    if (!GUILD_STORE_WEEKLY.some((w) => w.itemId === itemId)) continue;
    const uid = await int(`${b} item uid`);
    const priceType = await int(`${b} priceType`);
    const bits = await int(`${b} priceValue`);
    const week = await int(`${b} weeklyBuyCount`);
    const weekLimit = uid !== undefined ? await int(`XNormalShopDocument GetDataById:${uid} WeekCountCondition`) : undefined;
    if (itemId === undefined || priceType === undefined || bits === undefined || week === undefined || weekLimit === undefined) continue;
    out.push({ index: i, itemId, priceType, price: Math.round(bitsToFloat(bits)), week, weekLimit });
  }
  return out;
}

export interface GuildBox {
  index: number;
  process: number;
  open: boolean;
}

export interface GuildSnapshot {
  inWorld: boolean;
  inGuild: boolean;
  signInSelection: number; // 0 = nao assinou hoje
  progress: number;
  boxes: GuildBox[];
  salaryState: number; // WageRewardState
  redAvailable: boolean;
  gold: number;
}

export const WAGE_NOT_REWARDED = 3;

export type GuildAction = "signin" | "box" | "salary";

export type GuildStep =
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "act"; id: GuildAction; key: string; name: string; body: string };

// Uma acao por vez; cada uma so uma vez por passada (`tried`), pra nao repetir
// se o servidor recusar.
export function nextGuildStep(s: GuildSnapshot | null, cfg: GuildConfig, tried: Set<string>): GuildStep {
  if (!s) return { kind: "fail", reason: "engine fora" };
  if (!s.inWorld) return { kind: "fail", reason: "char fora de mundo" };
  if (!s.inGuild) return { kind: "done", reason: "char sem guilda" };
  if (cfg.signIn !== "off" && s.signInSelection === 0 && !tried.has("signin")) {
    const t = SIGNIN_TYPES[cfg.signIn];
    if (s.gold >= t.gold)
      return {
        kind: "act", id: "signin", key: "signin",
        name: `sign-in ${cfg.signIn === "luxury" ? "Luxury" : "Normal"} (${t.gold} gold)`,
        body: `callsi XGuildSignInDocument ReqSignIn 1 ${t.type} 0`,
      };
  }
  if (cfg.chests) {
    const box = s.boxes.find((b) => !b.open && b.process > 0 && s.progress >= b.process && !tried.has(`box${b.index}`));
    if (box)
      return {
        kind: "act", id: "box", key: `box${box.index}`, name: `abrir o bau de ${box.process} do sign-in`,
        body: `callsi XGuildSignInDocument ReqFetchBox 1 ${box.index} 0`,
      };
  }
  if (cfg.salary && s.salaryState === WAGE_NOT_REWARDED && !tried.has("salary"))
    return { kind: "act", id: "salary", key: "salary", name: "receber o salario", body: "callsn XGuildSalaryDocument SendGuildWageReward" };
  return { kind: "done", reason: summary(s, cfg) };
}

function summary(s: GuildSnapshot, cfg: GuildConfig): string {
  const parts: string[] = [];
  if (cfg.signIn !== "off")
    parts.push(s.signInSelection ? "sign-in feito" : `sem gold pro sign-in (${s.gold})`);
  if (cfg.salary) parts.push(s.salaryState === 2 ? "salario recebido" : s.salaryState === 1 ? "sem salario hoje" : `salario estado ${s.salaryState}`);
  if (cfg.redPacket && s.redAvailable) parts.push("red packet disponivel (pegar ainda nao automatizado)");
  return parts.join(", ") || "nada a fazer";
}

type EngineQuery = (tag: string, body: string) => Promise<Record<string, unknown>>;

// Pede o estado ao servidor (sign-in, salario, red packet). Ler depois de ~2 s.
export async function requestGuildInfo(q: EngineQuery): Promise<void> {
  await q("SKIL", "callsn XGuildSignInDocument ReqAllInfo");
  await q("SKIL", "callsn XGuildSalaryDocument SendAskGuildWageInfo");
  await q("SKIL", "callsn XGuildRedPacketDocument ReqList");
}

export async function readGuildSnapshot(q: EngineQuery): Promise<GuildSnapshot | null> {
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;
  const num = async (body: string, dflt = -1) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : dflt;
  };
  const s: GuildSnapshot = {
    inWorld: player.ok === true, inGuild: false, signInSelection: -1, progress: 0, boxes: [],
    salaryState: -1, redAvailable: false, gold: 0,
  };
  if (!s.inWorld) return s;
  s.inGuild = (await q("GETP", "XGuildDocument get_bInGuild")).bool === true;
  if (!s.inGuild) return s;
  const SIGN = "XGuildSignInDocument";
  s.signInSelection = await num(`${SIGN} get_SignInSelection`);
  s.progress = await num(`${SIGN} get_Progress`, 0);
  for (let i = 0; i < 8; i++) {
    const process = await num(`${SIGN} GetBoxTableData [${i}] process`);
    if (process < 0) break;
    s.boxes.push({ index: i, process, open: (await q("GETP", `${SIGN} IsBoxOpen:${i}`)).bool === true });
  }
  s.salaryState = await num("XGuildSalaryDocument get_RewardState");
  s.redAvailable = (await q("GETP", "XGuildRedPacketDocument get_bHasAvailableRedPacket")).bool === true;
  s.gold = await num("XBagDocument GetItemCount:1,0", 0);
  return s;
}

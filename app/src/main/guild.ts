// Guild utilities por metodo: pede o estado ao servidor, decide UMA acao com o
// nextGuildStep e manda, ate concluir (cada acao uma vez por passada).

import {
  GUILD_CONTRIBUTION, GUILD_STORE_LIST_BODY, GUILD_STORE_WEEKLY, type GuildConfig, guildStoreBuyBody, nextGuildStep, nextStoreBuy,
  readGuildSnapshot, readStoreGoods, requestGuildInfo, storeWeeklyText,
} from "../controller/guild";
import { queryPlayer, sendCommand } from "./engine";

type Query = (tag: string, body: string) => Promise<Record<string, unknown>>;

// Compras por passada (8 + 3 + 2 = 13 na semana; folga pra uma recusa).
const STORE_MAX_BUYS = 16;

// Limite semanal da Guild Store (ovos Precious e Rare, Dimension Hole). Uma unidade
// por pedido; depois de cada uma pede a lista de novo e confere: a contagem da semana
// subiu 1, a contribuicao caiu o preco e Silk/Diamond nao mudaram. Qualquer coisa
// diferente para. Devolve o resumo pro log.
async function buyGuildStoreWeekly(q: Query, log: Log): Promise<string> {
  const int = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const balances = async () => ({
    contrib: await int(`XBagDocument GetVirtualItemCount:${GUILD_CONTRIBUTION}`),
    silk: await int("XBagDocument GetVirtualItemCount:7"),
    diamond: await int("XBagDocument GetVirtualItemCount:9"),
  });
  let bought = 0;
  for (let i = 0; i < STORE_MAX_BUYS; i++) {
    await q("SKIL", GUILD_STORE_LIST_BODY);
    await sleep(SERVER_WAIT_MS);
    const goods = await readStoreGoods(q);
    const b0 = await balances();
    if (b0.contrib === undefined || b0.silk === undefined || b0.diamond === undefined) return "Guild Store: saldos nao lidos";
    const g = nextStoreBuy(goods, b0.contrib);
    if (!g) return `Guild Store: ${bought ? `${bought} comprado(s); ` : ""}${goods.length ? storeWeeklyText(goods) : "lista nao veio"}`;
    const name = GUILD_STORE_WEEKLY.find((w) => w.itemId === g.itemId)?.name ?? `item ${g.itemId}`;
    log(`comprar 1 ${name} na Guild Store por ${g.price} de contribuicao (${g.week + 1}/${g.weekLimit} na semana)`);
    await q("SKIL", guildStoreBuyBody(g.index));
    await sleep(SERVER_WAIT_MS);
    if ((await q("GETP", "RewardDlg IsVisible")).bool === true) await q("SKIL", "calls RewardDlg SetVisible 2 0 1");
    await q("SKIL", GUILD_STORE_LIST_BODY);
    await sleep(SERVER_WAIT_MS);
    const after = (await readStoreGoods(q)).find((x) => x.itemId === g.itemId && x.priceType === g.priceType);
    const b1 = await balances();
    if (b1.silk !== b0.silk || b1.diamond !== b0.diamond)
      return `Guild Store parada: Silk/Diamond mudaram (${b0.silk}/${b0.diamond} -> ${b1.silk}/${b1.diamond})`;
    if (!after || after.week !== g.week + 1 || b1.contrib !== b0.contrib - g.price)
      return `Guild Store parada: a compra de ${name} nao confirmou (semana ${g.week} -> ${after?.week ?? "?"}, contribuicao ${b0.contrib} -> ${b1.contrib})`;
    bought++;
  }
  return `Guild Store: ${bought} comprado(s); limite de compras por passada`;
}

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// O estado so atualiza com a resposta do servidor.
const SERVER_WAIT_MS = 2500;
const MAX_STEPS = 12;
const GUILD_INFO_WAIT_MS = 20000;

let stopRequested = false;

export function stopGuild(): void {
  stopRequested = true;
}

export async function runGuild(
  host: string,
  port: number,
  cfg: GuildConfig,
  log: Log = () => {},
): Promise<{ ok: boolean; erro?: string; done?: number }> {
  stopRequested = false;
  const p0 = await queryPlayer(host, port);
  if (!p0.ok) {
    log("char nao esta em mundo; nao iniciado.");
    return { ok: false, erro: "char nao esta em mundo" };
  }
  const q = (tag: string, body: string) => sendCommand(host, port, tag, body);
  const tried = new Set<string>();
  const t0 = Date.now();
  for (let i = 0; i < MAX_STEPS; i++) {
    if (stopRequested) {
      log("parado.");
      return { ok: false, erro: "parado", done: tried.size };
    }
    await requestGuildInfo(q);
    await sleep(SERVER_WAIT_MS);
    const s = await readGuildSnapshot(q);
    // A guilda chega alguns segundos depois de entrar em mundo (visto ao vivo:
    // logo apos o login o get_bInGuild ainda era false).
    if (s?.inWorld && !s.inGuild && Date.now() - t0 < GUILD_INFO_WAIT_MS) {
      i--;
      continue;
    }
    const step = nextGuildStep(s, cfg, tried);
    if (step.kind === "done") {
      // Guild Store depois do resto (a contribuicao do salario ja entrou).
      const store = cfg.storeWeekly && s?.inGuild ? await buyGuildStoreWeekly(q, log) : "";
      log(`concluido: ${[step.reason, store].filter(Boolean).join("; ")}.`);
      return { ok: true, done: tried.size };
    }
    if (step.kind === "fail") {
      log(`falhou: ${step.reason}.`);
      return { ok: false, erro: step.reason, done: tried.size };
    }
    log(step.name);
    await q("SKIL", step.body);
    tried.add(step.key);
    await sleep(SERVER_WAIT_MS);
  }
  log("muitas acoes numa passada; parando por seguranca.");
  return { ok: false, erro: "limite de acoes", done: tried.size };
}

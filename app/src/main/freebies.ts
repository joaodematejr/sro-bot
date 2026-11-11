// Gratis do dia por metodo (Event Pack, attendance, caixinha do Daily Pack, baus do
// sign-in e red envelopes da guilda): pede a lista da aba Event, o estado do sign-in
// e a lista de envelopes, pega um por vez com o nextFreebieStep e confere Diamond e
// Silk depois de cada pedido. Saldo mudou: para e nao pede mais nada ate reabrir o app.
// So chamadas de metodo: roda com o Treino cacando, sem pausar.

import { gameDay } from "../controller/daily";
import {
  DIAMOND_BODY, DONATE_INFO_BODY, FREEBIES_INFO_BODY, GUILD_SIGNIN_INFO_BODY, nextFreebieStep, readFreebiesSnapshot, RED_PACKET_LIST_BODY, SILK_BODY,
  PAY_CARD_NAMES, PAY_CARDS_INFO_BODY, PAY_CLAIM_BODY, PAY_SHOP_CLOSE_BODY, PAY_SHOP_OPEN_BODY, payCardDay, payCardsToClaim, readPayCards, REWARD_CLOSE_BODY,
} from "../controller/freebies";
import { queryPlayer, sendCommand } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SERVER_WAIT_MS = 2500;
const MAX_STEPS = 10;

// Dia do jogo em que o app ja marcou o attendance (trava contra o re-sign pago).
let checkinDay = -1;
// Saldo mudou depois de um pedido: nada mais ate reabrir o app.
let halted = "";

type Query = (tag: string, body: string) => Promise<Record<string, unknown>>;

// Premio diario do cartao de privilegio (Premium Shop > Privilege). So com a loja
// fechada: aberta pode ser o usuario usando (em 2026-11-11 15:24 ela ja estava
// aberta quando o bot mexeu). Abre a aba, confere que ela mostra o cartao certo,
// chama o botao do bau, confirma pelo servidor e fecha o que abriu. Devolve o texto
// pro resumo ("" sem cartao ativo).
async function claimPayCards(q: Query, int: (body: string) => Promise<number | undefined>, log: Log): Promise<string> {
  await q("SKIL", PAY_CARDS_INFO_BODY);
  await sleep(SERVER_WAIT_MS);
  const { cards, tz } = await readPayCards(q);
  const nowS = Math.floor(Date.now() / 1000);
  const active = cards.filter((c) => PAY_CARD_NAMES[c.id] && c.expire - nowS > 1);
  if (!active.length) return "";
  if (tz === undefined) return "cartao: fuso do servidor nao lido";
  const due = payCardsToClaim(cards, Date.now(), tz);
  if (!due.length) return `${PAY_CARD_NAMES[active[0].id]}: premio de hoje ja pego`;
  const c = due[0];
  const name = PAY_CARD_NAMES[c.id];
  if ((await q("GETP", "XPremiumShopDlg IsVisible")).bool === true)
    return `${name}: premio de hoje por pegar, mas o Premium Shop esta aberto (fica pra proxima passada)`;
  const diamond0 = await int(DIAMOND_BODY);
  const silk0 = await int(SILK_BODY);
  if (diamond0 === undefined || silk0 === undefined) return `${name}: Diamond/Silk nao lidos, premio fica pra depois`;
  log(`pegar o premio diario do ${name}`);
  let note = "";
  await q("SKIL", PAY_SHOP_OPEN_BODY);
  try {
    await sleep(3000);
    const tab = await int("XWelfareDocument _payMemberPrivilegeHandler _curTableIdx");
    if (tab !== c.id) {
      note = `${name}: a aba abriu no cartao ${tab ?? "?"}, nao no ${c.id}; nao pegou`;
    } else {
      await q("SKIL", PAY_CLAIM_BODY);
      await sleep(SERVER_WAIT_MS);
      await q("SKIL", PAY_CARDS_INFO_BODY);
      await sleep(SERVER_WAIT_MS);
    }
  } finally {
    if ((await q("GETP", "RewardDlg IsVisible")).bool === true) await q("SKIL", REWARD_CLOSE_BODY);
    await q("SKIL", PAY_SHOP_CLOSE_BODY);
  }
  const diamond = await int(DIAMOND_BODY);
  const silk = await int(SILK_BODY);
  // O premio pode trazer Silk; gastar (Silk menor) ou mexer no Diamond nunca.
  if (diamond !== diamond0 || silk === undefined || silk < silk0) {
    halted = `Diamond/Silk mudaram no premio do ${name} (${diamond0}/${silk0} -> ${diamond}/${silk}); gratis do dia parado ate reabrir o app`;
    log(halted);
    return note;
  }
  if (note) return note;
  const after = (await readPayCards(q)).cards.find((x) => x.id === c.id);
  if (after && after.lastFetch === payCardDay(Date.now(), tz))
    return `${name}: premio diario pego${silk > silk0 ? ` (+${silk - silk0} Silk)` : ""}`;
  return `${name}: pedi o premio, mas o servidor nao confirmou (dia ${after?.lastFetch ?? "?"})`;
}

export async function runFreebies(
  host: string,
  port: number,
  log: Log = () => {},
  donate = false,
): Promise<{ ok: boolean; erro?: string; done?: number; reason?: string }> {
  if (halted) return { ok: false, erro: halted };
  const p0 = await queryPlayer(host, port);
  if (!p0.ok) return { ok: false, erro: "char nao esta em mundo" };
  const q = (tag: string, body: string) => sendCommand(host, port, tag, body);
  const int = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const tried = new Set<string>();
  let done = 0;
  await q("SKIL", FREEBIES_INFO_BODY);
  await q("SKIL", GUILD_SIGNIN_INFO_BODY);
  await q("SKIL", RED_PACKET_LIST_BODY);
  if (donate) {
    await q("SKIL", DONATE_INFO_BODY);
    await q("SKIL", "calls XGuildDailyTaskDocument SendGetDailyTaskInfo 0");
  }
  await sleep(SERVER_WAIT_MS);
  for (let i = 0; i < MAX_STEPS; i++) {
    const s = await readFreebiesSnapshot(q);
    const step = nextFreebieStep(s, tried, checkinDay === gameDay(), donate);
    if (step.kind === "done") {
      const card = await claimPayCards(q, int, log);
      if (halted) return { ok: false, erro: halted, done };
      return { ok: true, done, reason: [step.reason, card].filter(Boolean).join("; ") };
    }
    if (step.kind === "fail") return { ok: false, erro: step.reason, done };
    log(step.name);
    tried.add(step.key);
    if (step.key === "checkin") checkinDay = gameDay();
    await q("SKIL", step.body);
    await sleep(SERVER_WAIT_MS);
    // Uma leitura falha nao e saldo mudado: tenta de novo antes de parar.
    const reread = async (body: string) => (await int(body)) ?? (await sleep(1000), await int(body));
    const diamond = await reread(DIAMOND_BODY);
    const silk = await reread(SILK_BODY);
    if (diamond !== s?.diamond || silk !== s?.silk) {
      halted = `Diamond/Silk mudaram depois de "${step.name}" (${s?.diamond}/${s?.silk} -> ${diamond}/${silk}); gratis do dia parado ate reabrir o app`;
      log(halted);
      return { ok: false, erro: halted, done };
    }
    done++;
  }
  return { ok: false, erro: "limite de acoes", done };
}

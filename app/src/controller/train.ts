// Treino (auto-hunt) completo, 100% por metodo: prepara as opcoes do auto-play
// do proprio jogo, liga a caca e vigia. Logica pura; quem chama faz as leituras
// com as funcoes read* e manda os comandos devolvidos.
//
// Mapeado ao vivo (2026-11-06, engine GETP/ENUM; ver DISCOVERY.md):
//   Opcoes   -> XOptionsDocument GetValue:<XOptionsDefine> / SetValue(opcao, valor, 1).
//               O documento nao tem singleton; o engine acha em XDocuments.
//   Auto-play do jogo (XAutoPlayDocument) ja faz: curar com pocao (AutoHeal +
//               HpHealItem/MpHealItem), comprar pocao (AutoBuy), pegar item
//               (AutoPickUp), reviver (AutoRevive + RevivePlace) e voltar a cacar
//               no ponto depois de reviver (ReturnFarming).
//   Pocoes   -> com o XAutoPlaySettingDlg aberto e SetMedicinePanelVisible(1), a
//               lista m_XItemListUpdate traz os remedios do inventario (itemID,
//               itemCount, itemConf ItemDescription "restore 820 HP ...").
//   Ponto    -> XScene get_SceneID (100001 = Jangan) + CONN corrected [x, altura, z].
//               Ir ate o ponto = MOVE x y z (Navigate na thread principal; so
//               dentro da mesma cena).
//   Area     -> XEntityMgr GetAll (List<XEntity> por perto): _eEntity_Type e
//               get_Attributes get_Level. Visto no Grassland de Jangan: Mangyang
//               nivel 1 pro char 60, EXP 0 em 4 min de caca.
//   Morte    -> CONN dead; reserva: ReviveDlg.OnBtnBackCityClicked (gratis).
//               Reviver no local custa item (900) e o "especial" custa 3 do item 7:
//               o bot so revive na cidade.

import type { EngineQuery } from "./tower";

export const OPT = {
  AutoHeal: 4001,
  AutoBuy: 4002,
  AutoPickUp: 4003,
  AutoRevive: 4004,
  AutoDemonizate: 4006,
  RevivePlace: 4022,
  HpHealItem1: 4034,
  HpHealItem2: 4035,
  MpHealItem1: 4036,
  MpHealItem2: 4037,
  ReturnFarming: 4039,
} as const;

// RevivePlace guarda o KKSG.ReviveType: 1 OnTheSpot (custa item), 2 BackCity.
export const REVIVE_BACK_CITY = 2;

// Opcoes que o treino liga. RevivePlace na cidade: reviver no local custa item.
export const TRAIN_OPTIONS: { id: number; name: string; value: number }[] = [
  { id: OPT.AutoHeal, name: "curar com pocao", value: 1 },
  { id: OPT.AutoBuy, name: "comprar pocao", value: 1 },
  { id: OPT.AutoPickUp, name: "pegar itens", value: 1 },
  { id: OPT.AutoRevive, name: "reviver sozinho", value: 1 },
  { id: OPT.RevivePlace, name: "reviver na cidade", value: REVIVE_BACK_CITY },
  { id: OPT.ReturnFarming, name: "voltar ao ponto depois de reviver", value: 1 },
  // Modo Berserk (Demon): o auto-play ativa sozinho quando a barra enche
  // (XAutoPlayDocument UpdateAutoDemonizate). Nao gasta item; buff do jogo: +100%
  // de dano fisico e magico e +100% de velocidade (XBerserkDocument BerserkBuffDesc).
  { id: OPT.AutoDemonizate, name: "modo Berserk automatico", value: 1 },
];

export interface TrainSpot {
  scene: number;
  x: number;
  y: number; // altura
  z: number;
  channel?: number; // canal do mapa (1..4); sem canal fica no que estiver
  range?: number; // raio do ponto em metros (padrao SPOT_LEAVE_M)
}

import type { TeamConfig } from "./team";

export interface TrainConfig {
  deathLimit: number; // para depois de N mortes (0 = nunca)
  setupPotions: boolean; // escolhe a pocao do inventario se o espaco estiver vazio
  restoreOptions?: boolean; // ao parar, devolve as opcoes que o treino mudou (padrao: sim)
  spot?: TrainSpot; // ponto unico (config antiga); a lista `spots` tem prioridade
  spots?: TrainSpot[]; // pontos em ordem; troca pro proximo pelas regras abaixo
  switchFewMonsters?: { radius: number; min: number }; // menos de `min` monstros no raio
  switchDeaths?: number; // N mortes no mesmo ponto (0 = desligado)
  switchLowHp?: number; // HP abaixo de N% no ponto: vai pro proximo (0 = desligado)
  stopLevel?: { level: number; expPct: number }; // nivel >= level e EXP% >= expPct
  stopMinGold?: number; // gold abaixo disso para (0 = desligado)
  home?: TrainSpot; // ao parar, vai pra este ponto (cidade)
  team?: TeamConfig; // sem time, entra num time aberto (bonus de EXP)
  booster?: boolean; // cacando no ponto, usa Exp Booster da mochila (um por vez)
  buffDamage?: boolean; // idem com o pergaminho de dano (30 min)
  buffVip?: boolean; // idem com o VIP Scroll de STR/INT (1 h)
  berserk?: boolean; // ativa o modo Berserk quando o botao aparece (ligado se ausente)
  devil?: boolean; // clica no devil uma vez por minuto em combate (ligado se ausente)
  trainingTime?: boolean; // abre o training time x10 guardado, 30 min por vez, cacando no ponto (ligado se ausente)
  reserveWithoutX10?: boolean; // sem x10 (aberto ou guardado) caca no ponto 2; volta pro 1 quando o x10 voltar (ligado se ausente)
  autoSkills?: boolean; // no level-up, sobe as maestrias usadas e as skills liberadas
  sellJunk?: boolean; // mochila com menos de 15 livres: vende a lista fixa de lixo
  avoidPlayers?: boolean; // outro jogador cacando perto por 2 min: troca de canal ou de ponto (ligado se ausente)
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = { deathLimit: 0, setupPotions: true };

// Lista efetiva de pontos (a config antiga so tinha `spot`).
export function trainSpots(cfg: TrainConfig): TrainSpot[] {
  if (cfg.spots && cfg.spots.length) return cfg.spots;
  return cfg.spot ? [cfg.spot] : [];
}

// Longe do ponto alem disso (no plano x/z) volta pra ele; perto disso chegou.
// O auto-hunt do jogo persegue monstro ate o RangeFind (200 m): com 60 m o char
// ia e voltava a cada 20 s sem cacar (visto ao vivo no Grassland).
export const SPOT_LEAVE_M = 150;
export const SPOT_ARRIVE_M = 25;
const MOVE_COOLDOWN_MS = 20000;
// Viagem pra outro mapa (o jogo teleporta e anda): reenvia so depois disso.
const TRAVEL_COOLDOWN_MS = 45000;
// Tantas viagens sem chegar: o ponto e inalcancavel (pula pro proximo).
const TRAVEL_MAX_TRIES = 8;
// Canal: o jogo ignora o pedido em combate; tenta poucas vezes por ponto.
const CHANNEL_COOLDOWN_MS = 10000;
const CHANNEL_MAX_TRIES = 3;
// Outro jogador (fora do time) cacando perto mata os mesmos monstros: o EXP e o
// SP do char caem. Com ele a menos de PLAYER_NEAR_M por PLAYER_NEAR_MS seguidos,
// troca pro canal mais vazio do mesmo ponto; sem canal livre, vai pro proximo
// ponto. Depois de trocar espera DODGE_COOLDOWN_MS antes de trocar de novo, e os
// canais de onde fugiu ficam de fora por DODGE_FORGET_MS. O raio e o que o char principal
// viu no Niya Hunter em 2026-11-11 12:46: dois jogadores Lv.75-76 cacando o mesmo
// bando o tempo todo a 55-86 m (a menos de 40 m so uma vez em 5 min).
export const PLAYER_NEAR_M = 80;
export const PLAYER_NEAR_MS = 2 * 60 * 1000;
export const DODGE_COOLDOWN_MS = 5 * 60 * 1000;
export const DODGE_FORGET_MS = 30 * 60 * 1000;
// Poucos monstros por tanto tempo seguido: troca de ponto.
export const FEW_MONSTERS_MS = 60000;
// Indo pra cidade ao parar: desiste depois disso.
const HOME_MAX_MS = 5 * 60 * 1000;
// Fora do raio por tanto tempo seguido antes de parar a caca pra voltar.
export const LEAVE_AFTER_MS = 20000;

// Sem EXP subindo por isso (vivo): a caca parou, religa.
export const IDLE_MS = 180000;
// Preso no ponto (visto 2026-11-07 06:13 no char principal: parado no lugar, apanhando, o
// religar nao adiantou; o reinicio do jogo deixou o char sozinho e ele morreu):
// sem EXP de verdade por STUCK_RESET_MS desliga e religa a caca (o auto-play escolhe
// outro alvo); por STUCK_LEAVE_MS, fora de combate, vai pro ponto de reserva.
export const STUCK_RESET_MS = 6 * 60 * 1000;
export const STUCK_LEAVE_MS = 10 * 60 * 1000;
// Ponto de reserva rende menos (Niya Hunter 76: ~15,5 M/h contra 23-26 M/h no
// Niya Shaman 78, medido em 2026-11-08; o char ficou 5 h la depois de uma troca
// por HP baixo). Volta pro ponto 1 depois desse tempo; se sair dele de novo em
// menos disso, a proxima espera dobra (ate o teto).
export const PRIMARY_RETURN_MS = 30 * 60 * 1000;
export const PRIMARY_RETURN_MAX_MS = 4 * 60 * 60 * 1000;
// Sem o training time x10 o ponto 1 nao compensa: na noite de 2026-11-08 o char principal
// fez ~2,4 M/h la e morreu as 05:10 (HP 86% -> 17% -> morto em ~1 min), perdendo
// 59,7 M (~25 h de caca). O ponto 2 sem o x10 rende ainda menos: 0,45 M/h
// (2026-11-09 22:08 a 11-10 06:31, Lv.87), uns 2 M/h a menos que o ponto 1. A
// troca so perde se o ponto 1 matar o char menos de 1 vez a cada ~30 h.
// Entre desligar e religar a caca no "reset".
export const RESET_GAP_MS = 1500;
// Morto alem disso: o AutoRevive nao agiu, revive na cidade pelo botao.
export const DEAD_FALLBACK_MS = 45000;
// Parar a caca pra ir pra cidade (pausa do Continental, meta, limite) so com o
// char inteiro e sem monstro colado. Em 2026-11-08 09:49 a pausa do Continental
// desligou a caca logo depois de um combate, com HP em 48% no meio do Niya
// Shaman (78): o char principal morreu 22 s depois, viajando, e perdeu 59,7 M de EXP.
// A caca segue ligada enquanto espera (o Continental desiste em 15 min). O raio
// e curto de proposito: medido no ponto (2026-11-08 10:33, 24 leituras em 2 min)
// sempre havia 1 a 9 monstros a menos de 25 m; fora de combate, com HP cheio e
// nada a menos de 10 m aconteceu a cada ~40 s.
export const LEAVE_MIN_HP_PCT = 90;
export const LEAVE_SAFE_RADIUS_M = 10;
// Indo pra cidade com a caca desligada, em combate e com HP abaixo disso: religa
// a caca pra se defender e volta a esperar a hora segura de sair.
export const LEAVE_DEFEND_HP_PCT = 60;
// Parado sem alvo: o auto-play so procura em volta do `_born_pos` (20 m) e, com
// tudo morto ali, fica parado esperando renascer (2026-11-08: 2 a 3 min por vez
// no Niya Shaman, ate o "religar a caca" dos 3 min). Sem EXP por SEEK_IDLE_MS,
// fora de combate, com HP cheio e nenhum inimigo a menos de SEEK_CLEAR_M, o bot
// anda ate o inimigo vivo mais perto dentro do ponto. Andar (TeleportNavigate)
// DESLIGA o auto-play (visto ao vivo 11:34: 26 m em 3 s, auto desligado e o
// combate comecou com ele parado), entao o main religa a caca ao chegar, ao
// entrar em combate ou em SEEK_WALK_MAX_MS, o que vier primeiro.
export const SEEK_IDLE_MS = 45000;
export const SEEK_COOLDOWN_MS = 30000;
export const SEEK_CLEAR_M = 25;
export const SEEK_MAX_M = 70;
export const SEEK_ARRIVE_M = 5;
export const SEEK_WALK_MAX_MS = 6000;
// Fim do treino com o char morto no caminho da cidade (quem pausou nao deve
// seguir como se ele estivesse la).
export const DIED_BEFORE_HOME = "morreu antes de chegar na cidade";
// Fim do motivo quando a parada chegou na cidade (o Continental so roda assim).
export const AT_HOME = "; na cidade";
const HUNT_COOLDOWN_MS = 60000;
const REVIVE_COOLDOWN_MS = 15000;

export function setOptionBody(id: number, value: number): string {
  return `callsi XOptionsDocument SetValue 3 ${id} ${value} 1`;
}

// Comandos pra deixar as opcoes do treino ligadas (so as que estao diferentes).
export function optionFixes(
  current: Record<number, number | undefined>,
): { id: number; name: string; body: string; original: number }[] {
  return TRAIN_OPTIONS.filter((o) => current[o.id] !== undefined && current[o.id] !== o.value).map((o) => ({
    id: o.id,
    name: o.name,
    body: setOptionBody(o.id, o.value),
    original: current[o.id] as number,
  }));
}

// Comandos pra devolver o que o treino mudou (outras ferramentas usam as mesmas
// opcoes: no char principal eram RevivePlace 0 e ReturnFarming 0).
export function optionRestores(fixes: { id: number; original: number }[]): string[] {
  return fixes.map((f) => setOptionBody(f.id, f.original));
}

export interface MedicineItem {
  id: number;
  count: number;
  desc: string;
}

// Pocao pra um tipo pela descricao ("restore 820 HP"), a de mais restauracao;
// empate fica com a de mais unidades.
// A descricao as vezes vem como a chave da traducao ("ItemList_ItemDescription_N",
// visto no char principal em 2026-11-07) e a StringTable nao responde de fora: sem texto,
// o bot nao sabe qual pocao e de HP ou de MP.
export function potionsUntranslated(items: MedicineItem[]): boolean {
  return items.length > 0 && items.every((it) => /^ItemList_/.test(it.desc));
}

export function pickPotion(items: MedicineItem[], kind: "HP" | "MP"): number | undefined {
  const re = new RegExp(`restore\\s+([\\d,.]+)\\s*${kind}\\b`, "i");
  let best: { id: number; amount: number; count: number } | undefined;
  for (const it of items) {
    if (it.count <= 0) continue;
    const m = re.exec(it.desc);
    if (!m) continue;
    const amount = Number(m[1].replace(/[,.]/g, ""));
    if (!best || amount > best.amount || (amount === best.amount && it.count > best.count))
      best = { id: it.id, amount, count: it.count };
  }
  return best?.id;
}

// O engine manda o EXP do nivel como int32; no Lv.87 o maximo (2,26 G) passa
// de 2^31 e chegava negativo. Le de volta como sem sinal.
export function unsignedExp(n: number): number {
  return n < 0 ? n + 2 ** 32 : n;
}

// Exp e MaxExp sao UInt64 no jogo e o CONN do engine le so os 4 bytes de baixo:
// o maximo do Lv.87 e 6,55 G (0x1_86A2_DD09), nao os 2,26 G que sobravam (em
// 2026-11-08 o app mostrava 32,5% com o jogo em 11,3%). Os 4 de cima vem pelo
// GETP no campo +4.
const ATTR_PATH = "XEntityMgr get_Player get_Attributes";
export const EXP_HI_BODY = `${ATTR_PATH} _003CExp_003Ek__BackingField+4`;
export const MAXEXP_HI_BODY = `${ATTR_PATH} _003CMaxExp_003Ek__BackingField+4`;

export function fullExp(lo: number, hi: unknown): number {
  const low = unsignedExp(lo);
  if (low >= 2 ** 32) return low; // engine ja mandou os 64 bits
  return typeof hi === "number" && hi > 0 ? hi * 2 ** 32 + low : low;
}

export async function readExpHigh(q: EngineQuery): Promise<{ exp?: number; max?: number }> {
  const e = await q("GETP", EXP_HI_BODY);
  const m = await q("GETP", MAXEXP_HI_BODY);
  return {
    exp: e.ok === true && typeof e.int === "number" ? e.int : undefined,
    max: m.ok === true && typeof m.int === "number" ? m.int : undefined,
  };
}

export interface TrainSnapshot {
  inWorld: boolean;
  dead: boolean;
  exp: number;
  maxExp?: number;
  level: number;
  scene?: number;
  pos?: [number, number, number]; // x, altura, z
  inCombat?: boolean;
  hp?: number;
  maxHp?: number;
  gold?: number; // lido so com stopMinGold ligado
  channel?: number; // canal atual (lido so com ponto que pede canal)
  channelLines?: Record<number, number>; // canal -> id da linha neste mapa
  channelInfo?: Record<number, LineInfo>; // canal -> lotacao e se e o Activity Channel
  playersNear?: number; // jogadores fora do time a PLAYER_NEAR_M do char (lido de tempos em tempos)
  enemiesNear?: number; // monstros no raio da regra de troca (lido de tempos em tempos)
  enemiesClose?: number; // monstros a LEAVE_SAFE_RADIUS_M do char (lido so antes de ir pra cidade)
}

// O que impede desligar a caca pra ir pra cidade agora (null = pode). Texto sem
// numero que muda a cada leitura, pra nao repetir a linha no log.
export function leaveBlock(s: TrainSnapshot): string | null {
  if (s.inCombat) return "sair do combate";
  if (s.hp !== undefined && s.maxHp && (100 * s.hp) / s.maxHp < LEAVE_MIN_HP_PCT) return `o HP passar de ${LEAVE_MIN_HP_PCT}%`;
  if (s.enemiesClose !== undefined && s.enemiesClose > 0) return `nao ter monstro a menos de ${LEAVE_SAFE_RADIUS_M} m`;
  return null;
}

export function spotDistance(s: TrainSnapshot, spot: TrainSpot): number | undefined {
  if (!s.pos || s.scene !== spot.scene) return undefined;
  return Math.hypot(s.pos[0] - spot.x, s.pos[2] - spot.z);
}

// Dentro do raio do ponto (sem ponto salvo, qualquer lugar vale). Buff e x10 so
// aqui: em 2026-11-09 08:31 o Exp Booster foi usado na cidade, antes de sair.
export function atSpot(s: TrainSnapshot, spot: TrainSpot | undefined): boolean {
  if (!spot) return true;
  const d = spotDistance(s, spot);
  return d !== undefined && d <= (spot.range && spot.range > 0 ? spot.range : SPOT_LEAVE_M);
}

// No mapa da cidade salva (fora de qualquer ponto) monstro perto nao bloqueia a
// saida: em 2026-11-09 08:30 um "Brownie" Lv.1 e um "Elite Penguin" Lv.90 fixos no
// revive de Jangan (100001), a 4 m do char, prenderam o Treino 3 min na cidade.
// HP e combate continuam valendo.
export function inSafeTown(s: TrainSnapshot, cfg: TrainConfig): boolean {
  return !!cfg.home && s.scene === cfg.home.scene && !trainSpots(cfg).some((sp) => sp.scene === s.scene);
}

// Ponto de partida do Treino: o mais perto do char no mesmo mapa (0 se nenhum).
// Reabrir o app no meio da caca voltava sempre pro ponto 1, mesmo com o char ja
// no ponto 2 (2026-11-08 16:39, 719 m de viagem).
export function nearestSpotIdx(s: TrainSnapshot | null, spots: TrainSpot[]): number {
  let best = 0;
  let bestD = Infinity;
  spots.forEach((spot, i) => {
    const d = s ? spotDistance(s, spot) : undefined;
    if (d !== undefined && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export interface TrainProgress {
  deaths: number;
  deadSince: number | null;
  wasDead: boolean;
  lastExp: number;
  lastLevel: number;
  lastGainAt: number; // ultima vez que o EXP (ou nivel) subiu
  expAt: number; // ultima subida real de EXP (as acoes nao mexem; chegar no ponto e reviver zeram)
  resetAt: number; // ultimo "desliga e religa" da caca
  huntSentAt: number;
  reviveSentAt: number;
  goingToSpot: boolean; // caca parada, andando ate o ponto
  moveSentAt: number;
  spotIdx: number; // ponto atual na lista
  deathsAtSpot: number;
  fewSince: number | null; // desde quando ha poucos monstros no raio
  travelSentAt: number;
  travelTries: number;
  channelSentAt: number;
  channelTries: number;
  stopReason: string | null; // parando: indo pra cidade antes de concluir
  pauseReason: string | null; // pausa pedida de fora (ex.: Continental): vai pra cidade e conclui
  lowHpAtSpot: number | null; // menor HP% visto abaixo do limite neste ponto
  homeSince: number;
  farSince: number | null; // desde quando esta fora do raio do ponto
  reserveSince: number | null; // desde quando esta num ponto de reserva (nao o 1)
  primaryWaitMs: number; // quanto espera na reserva antes de voltar pro ponto 1
  primaryBackAt: number; // ultima volta pro ponto 1
  x10: boolean | null; // training time x10 aberto ou guardado (null = nao lido)
  x10Reserve: boolean; // no ponto de reserva por falta de x10 (volta quando ele voltar)
  playersSince: number | null; // desde quando ha jogador de fora do time perto
  dodgeAt: number; // ultima troca de canal por jogador perto
  dodgeFrom: Record<number, number>; // canal -> quando fugiu dele (neste ponto)
  channelOverride: number | null; // canal escolhido pela fuga (vale no lugar do canal do ponto)
}

export function newTrainProgress(now: number): TrainProgress {
  return {
    deaths: 0, deadSince: null, wasDead: false, lastExp: -1, lastLevel: -1, lastGainAt: now, expAt: now, resetAt: 0,
    huntSentAt: 0, reviveSentAt: 0, goingToSpot: false, moveSentAt: 0,
    spotIdx: 0, deathsAtSpot: 0, fewSince: null, travelSentAt: 0, travelTries: 0, channelSentAt: 0, channelTries: 0,
    stopReason: null, pauseReason: null, lowHpAtSpot: null, homeSince: 0, farSince: null,
    reserveSince: null, primaryWaitMs: PRIMARY_RETURN_MS, primaryBackAt: 0, x10: null, x10Reserve: false,
    playersSince: null, dodgeAt: 0, dodgeFrom: {}, channelOverride: null,
  };
}

export type TrainStep =
  | { kind: "wait"; reason: string }
  | { kind: "done"; reason: string }
  | { kind: "act"; id: TrainAction; name: string; tag: string; body: string };

export type TrainAction = "hunt" | "reset" | "revive" | "leave" | "move" | "arrive" | "travel" | "channel" | "next" | "home" | "defend" | "primary" | "safe" | "dodge";

export const HUNT_ON = JSON.stringify({ on: 1 });
// Sem alvo, o auto-play volta a vagar em volta do `_born_pos` da IA (raio de 20 m),
// que fica onde o char apareceu ao logar ou reviver. Em 2026-11-07 era o pilar de
// reviver do oasis do North Taklamakan (zona Peace, sem monstro): de qualquer
// ponto do mapa o char andava pra la e parava. ResetBornPosition() fixa no lugar
// atual; o Treino chama no ponto, antes de ligar a caca.
export const RESET_BORN_BODY = "callp XEntityMgr get_Player _ai ResetBornPosition 0";
export const HUNT_OFF = JSON.stringify({ on: 0 });

export function travelBody(spot: TrainSpot): string {
  return `callv3 TeleportDocument TeleportNavigate 3 ${spot.x} ${spot.y} ${spot.z} ${spot.scene} 0`;
}

export function trackTrain(p: TrainProgress, s: TrainSnapshot, now: number, cfg?: TrainConfig): TrainProgress {
  const out = { ...p };
  if (s.dead) {
    if (!out.wasDead) {
      out.deaths++;
      out.deathsAtSpot++;
    }
    if (out.deadSince === null) out.deadSince = now;
  } else {
    out.deadSince = null;
    // Revivido: a caca recomeca agora, sem contar o tempo morto como parado.
    if (out.wasDead) out.lastGainAt = out.expAt = now;
  }
  out.wasDead = s.dead;
  if (s.inWorld && !s.dead) {
    const gained = s.level > out.lastLevel || (s.level === out.lastLevel && s.exp > out.lastExp);
    if (out.lastExp >= 0 && gained) out.lastGainAt = out.expAt = now;
    out.lastExp = s.exp;
    out.lastLevel = s.level;
  }
  // Fora do raio do ponto: so conta com o char em mundo, vivo e no mapa do ponto.
  const spots = cfg ? trainSpots(cfg) : [];
  const spot = spots.length ? spots[out.spotIdx % spots.length] : undefined;
  if (spot && s.inWorld && !s.dead && !out.goingToSpot) {
    const d = spotDistance(s, spot);
    const range = spot.range && spot.range > 0 ? spot.range : SPOT_LEAVE_M;
    if (d !== undefined && d > range) {
      if (out.farSince === null) out.farSince = now;
    } else {
      out.farSince = null;
    }
  } else {
    out.farSince = null;
  }
  // HP abaixo do limite no ponto (nao a caminho): o ponto e forte demais.
  const lowHp = cfg?.switchLowHp;
  if (lowHp && lowHp > 0 && s.inWorld && !s.dead && !out.goingToSpot && s.hp !== undefined && s.maxHp) {
    const pct = (100 * s.hp) / s.maxHp;
    if (pct < lowHp) out.lowHpAtSpot = Math.min(out.lowHpAtSpot ?? 100, Math.round(pct));
  }
  const few = cfg?.switchFewMonsters;
  if (few && s.enemiesNear !== undefined) {
    if (s.enemiesNear < few.min) {
      if (out.fewSince === null) out.fewSince = now;
    } else {
      out.fewSince = null;
    }
  }
  if (out.goingToSpot || !s.inWorld || s.dead) out.playersSince = null;
  else if (s.playersNear !== undefined) out.playersSince = s.playersNear > 0 ? out.playersSince ?? now : null;
  return out;
}

// Motivo pra parar o treino (null = segue).
export function stopReason(s: TrainSnapshot, cfg: TrainConfig, p: TrainProgress): string | null {
  if (cfg.deathLimit > 0 && p.deaths >= cfg.deathLimit) return `morreu ${p.deaths} vez(es) (limite ${cfg.deathLimit})`;
  if (!s.inWorld || s.dead) return null;
  const lv = cfg.stopLevel;
  if (lv && lv.level > 0 && s.level >= lv.level) {
    const pct = s.maxExp && s.maxExp > 0 ? (100 * s.exp) / s.maxExp : 0;
    if (s.level > lv.level || pct >= lv.expPct)
      return `chegou no nivel ${s.level} (${pct.toFixed(1)}% de EXP; meta ${lv.level} com ${lv.expPct}%)`;
  }
  if (cfg.stopMinGold && cfg.stopMinGold > 0 && s.gold !== undefined && s.gold >= 0 && s.gold < cfg.stopMinGold)
    return `gold abaixo de ${cfg.stopMinGold} (${s.gold}), sem dinheiro pra pocao`;
  return null;
}

// Ir ate o ponto (ou a cidade) pela navegacao do proprio jogo
// (TeleportDocument.TeleportNavigate): acha o caminho, desvia de obstaculo e
// troca de mapa. O MOVE (Navigate direto) empacou a 433 m de um ponto em Roc
// Mountain; o TeleportNavigate chegou. Undefined = ja esta perto.
function goTo(s: TrainSnapshot, spot: TrainSpot, p: TrainProgress, now: number, what: string): TrainStep | undefined {
  const d = spotDistance(s, spot);
  if (d !== undefined && d <= SPOT_ARRIVE_M) return undefined;
  if (p.travelTries >= TRAVEL_MAX_TRIES) return { kind: "wait", reason: `${STUCK_PREFIX} ${what}` };
  const cooldown = d === undefined ? TRAVEL_COOLDOWN_MS : MOVE_COOLDOWN_MS;
  if (p.travelSentAt === 0 || now - p.travelSentAt >= cooldown)
    return {
      kind: "act", id: "travel",
      name: d === undefined ? `viajando ate ${what} (mapa ${spot.scene})` : `andando ate ${what} (${Math.round(d)} m)`,
      tag: "SKIL", body: travelBody(spot),
    };
  return { kind: "wait", reason: d === undefined ? `viajando ate ${what}` : `andando ate ${what}` };
}

export const STUCK_PREFIX = "nao conseguiu chegar em";

function noX10(cfg: TrainConfig, p: TrainProgress): boolean {
  return cfg.reserveWithoutX10 !== false && p.x10 === false;
}

// Troca de ponto pendente por causa do x10 ou da volta pro ponto 1. O main usa
// pra ler os monstros em volta antes (o leaveBlock so os ve se forem lidos).
export function x10LeaveDue(cfg: TrainConfig, p: TrainProgress): boolean {
  const n = trainSpots(cfg).length;
  return n > 1 && p.spotIdx % n === 0 && noX10(cfg, p);
}

export function primaryBackDue(cfg: TrainConfig, p: TrainProgress, now: number): boolean {
  const n = trainSpots(cfg).length;
  if (n < 2 || p.goingToSpot || p.spotIdx % n === 0 || noX10(cfg, p)) return false;
  return p.x10Reserve ? p.x10 === true : p.reserveSince !== null && now - p.reserveSince >= p.primaryWaitMs;
}

// Lotacao de um canal (KKSG.SceneLineState: 1 Full, 2 Crowded, 3 Good) e se e o
// Activity Channel (o jogo avisa "the amount of monster is 50% decreased").
export interface LineInfo {
  state?: number;
  activity: boolean;
}
const LINE_FULL = 1;

export const channelBody = (line: number) => `callsi ChannelDocument ReqChangeLine 1 ${line} 0`;

// Canal pra fugir de jogador perto: nunca o atual, o Activity Channel, um cheio
// nem um de onde fugiu ha menos de DODGE_FORGET_MS. Prefere o mais vazio e, no
// empate, o de numero menor. Canal sem leitura de lotacao fica de fora.
export function pickDodgeChannel(s: Pick<TrainSnapshot, "channel" | "channelLines" | "channelInfo">, p: Pick<TrainProgress, "dodgeFrom">, now: number): number | undefined {
  if (s.channel === undefined || !s.channelLines) return undefined;
  const fled = (c: number) => p.dodgeFrom[c] !== undefined && now - p.dodgeFrom[c] < DODGE_FORGET_MS;
  const state = (c: number) => s.channelInfo?.[c]?.state ?? 0;
  return Object.keys(s.channelLines).map(Number)
    .filter((c) => c !== s.channel && !!s.channelInfo?.[c] && !s.channelInfo[c].activity && state(c) > LINE_FULL && !fled(c))
    .sort((a, b) => state(b) - state(a) || a - b)[0];
}

export function dodgeDue(cfg: TrainConfig, p: TrainProgress, now: number): boolean {
  return cfg.avoidPlayers !== false && !p.goingToSpot && p.playersSince !== null && now - p.playersSince >= PLAYER_NEAR_MS
    && (p.dodgeAt === 0 || now - p.dodgeAt >= DODGE_COOLDOWN_MS);
}

// Fuga de jogador perto: o canal pra onde ir, "next" (sem canal livre, vai pro
// proximo ponto) ou null (nao e hora, fora do ponto, canais ainda nao lidos ou
// sem pra onde ir). O main usa pra ler os monstros em volta antes (leaveBlock).
export function dodgePlan(s: TrainSnapshot, cfg: TrainConfig, p: TrainProgress, now: number): { channel: number; line: number } | "next" | null {
  if (!dodgeDue(cfg, p, now) || !s.inWorld || s.dead || !s.channelLines) return null;
  const spots = trainSpots(cfg);
  const spot = spots.length ? spots[p.spotIdx % spots.length] : undefined;
  if (!spot || !atSpot(s, spot)) return null;
  const ch = pickDodgeChannel(s, p, now);
  const line = ch !== undefined ? s.channelLines[ch] : undefined;
  if (ch !== undefined && line) return { channel: ch, line };
  return spots.length > 1 ? "next" : null;
}

export function nextTrainStep(s: TrainSnapshot | null, cfg: TrainConfig, p: TrainProgress, now: number): TrainStep {
  if (!s) return { kind: "wait", reason: "engine fora" };
  if (s.dead) {
    if (p.deadSince !== null && now - p.deadSince >= DEAD_FALLBACK_MS && now - p.reviveSentAt >= REVIVE_COOLDOWN_MS)
      return { kind: "act", id: "revive", name: "reviver na cidade", tag: "SKIL", body: "callsn ReviveDlg OnBtnBackCityClicked 1" };
    if (p.stopReason) return { kind: "done", reason: p.pauseReason ? `${p.stopReason} (${DIED_BEFORE_HOME})` : p.stopReason };
    const r = p.pauseReason ?? stopReason(s, cfg, p);
    if (r && !cfg.home) return { kind: "done", reason: r };
    return { kind: "wait", reason: "morto, esperando reviver" };
  }
  if (!s.inWorld) return { kind: "wait", reason: "fora de mundo" };

  // Parando: com cidade configurada vai ate la (caca desligada fora de combate).
  const reason = p.stopReason ?? p.pauseReason ?? stopReason(s, cfg, p);
  if (reason) {
    if (!cfg.home) return { kind: "done", reason };
    if (!p.stopReason) {
      const block = leaveBlock(s);
      if (block) return { kind: "wait", reason: `${reason}; esperando ${block} pra ir pra cidade` };
      return { kind: "act", id: "home", name: `${reason}: parar a caca e ir pra cidade`, tag: "SKIL", body: HUNT_OFF };
    }
    if (s.inCombat && s.hp !== undefined && s.maxHp && (100 * s.hp) / s.maxHp < LEAVE_DEFEND_HP_PCT)
      return { kind: "act", id: "defend", name: `atacado com HP abaixo de ${LEAVE_DEFEND_HP_PCT}% indo pra cidade: religar a caca e esperar`, tag: "SKIL", body: HUNT_ON };
    if (now - p.homeSince >= HOME_MAX_MS) return { kind: "done", reason: `${reason} (nao chegou na cidade a tempo)` };
    const go = goTo(s, cfg.home, p, now, "a cidade");
    if (go?.kind === "wait" && go.reason.startsWith(STUCK_PREFIX)) return { kind: "done", reason: `${reason} (${go.reason})` };
    return go ?? { kind: "done", reason: `${reason}${AT_HOME}` };
  }

  const spots = trainSpots(cfg);
  const spot = spots.length ? spots[p.spotIdx % spots.length] : undefined;
  if (spot) {
    // Troca de ponto (so com mais de um e fora de combate). Morte a caminho do
    // ponto conta pro ponto (visto ao vivo: o char de teste morreu indo pro ponto 1 e
    // voltava pra ele); poucos monstros so vale ja no ponto.
    if (spots.length > 1 && !s.inCombat) {
      const byDeaths = !!cfg.switchDeaths && cfg.switchDeaths > 0 && p.deathsAtSpot >= cfg.switchDeaths;
      const byFew = !p.goingToSpot && !!cfg.switchFewMonsters && p.fewSince !== null && now - p.fewSince >= FEW_MONSTERS_MS;
      const byLowHp = !!cfg.switchLowHp && p.lowHpAtSpot !== null;
      const byStuck = !p.goingToSpot && now - p.expAt >= STUCK_LEAVE_MS && p.resetAt > p.expAt;
      if (byDeaths || byFew || byLowHp || byStuck) {
        // Mesma regra da ida pra cidade: em 2026-11-08 02:56 a troca por HP baixo
        // saiu andando com 7% de HP e a caca desligada.
        const block = leaveBlock(s);
        if (block) return { kind: "wait", reason: `trocar de ponto; esperando ${block}` };
        const why = byDeaths ? `${p.deathsAtSpot} morte(s) no ponto`
          : byLowHp ? `HP caiu a ${p.lowHpAtSpot}% no ponto (limite ${cfg.switchLowHp}%)`
          : byStuck ? `EXP parado ha ${Math.round((now - p.expAt) / 60000)} min no ponto mesmo religando a caca`
          : `menos de ${cfg.switchFewMonsters?.min} monstro(s) no raio`;
        return { kind: "act", id: "next", name: `${why}: indo pro ponto ${((p.spotIdx + 1) % spots.length) + 1}`, tag: "SKIL", body: HUNT_OFF };
      }
      if (x10LeaveDue(cfg, p)) {
        const block = leaveBlock(s);
        if (block) return { kind: "wait", reason: `sem x10, ir pro ponto 2; esperando ${block}` };
        return { kind: "act", id: "safe", name: "sem training time x10: indo pro ponto 2 (no ponto 1 o risco de morte nao compensa)", tag: "SKIL", body: HUNT_OFF };
      }
      if (primaryBackDue(cfg, p, now)) {
        const block = leaveBlock(s);
        if (block) return { kind: "wait", reason: `voltar pro ponto 1; esperando ${block}` };
        const why = p.x10Reserve ? "training time x10 disponivel" : `${Math.round(p.primaryWaitMs / 60000)} min no ponto de reserva`;
        return { kind: "act", id: "primary", name: `${why}: voltando pro ponto 1`, tag: "SKIL", body: HUNT_OFF };
      }
    }
    // Jogador de fora do time cacando perto: troca de canal (a caca segue ligada)
    // ou, sem canal livre, vai pro proximo ponto. Mesma regra de seguranca da saida.
    const dodge = dodgePlan(s, cfg, p, now);
    if (dodge) {
      const nextSpot = ((p.spotIdx + 1) % spots.length) + 1;
      const block = leaveBlock(s);
      if (block) return { kind: "wait", reason: `jogador perto: ${dodge === "next" ? `ir pro ponto ${nextSpot}` : `trocar pro canal ${dodge.channel}`}; esperando ${block}` };
      const why = `jogador de fora do time cacando a menos de ${PLAYER_NEAR_M} m ha ${Math.round((now - (p.playersSince ?? now)) / 60000)} min`;
      if (dodge === "next") return { kind: "act", id: "next", name: `${why} e sem canal livre: indo pro ponto ${nextSpot}`, tag: "SKIL", body: HUNT_OFF };
      return { kind: "act", id: "dodge", name: `${why}: trocando do canal ${s.channel} pro ${dodge.channel}`, tag: "SKIL", body: channelBody(dodge.line) };
    }
    // Canal do ponto (ou o da fuga): troca so fora de combate (o jogo ignora em combate).
    const wantCh = p.channelOverride ?? spot.channel;
    if (wantCh && s.scene === spot.scene && s.channel !== undefined && s.channel !== wantCh
      && !s.inCombat && p.channelTries < CHANNEL_MAX_TRIES
      && (p.channelSentAt === 0 || now - p.channelSentAt >= CHANNEL_COOLDOWN_MS)) {
      const line = s.channelLines?.[wantCh];
      if (line) return { kind: "act", id: "channel", name: `trocar pro canal ${wantCh}`, tag: "SKIL", body: channelBody(line) };
    }
    if (p.goingToSpot) {
      // Mesma defesa da ida pra cidade: andando com a caca desligada e o HP caindo,
      // religa; a volta passa de novo pelo leaveBlock.
      if (s.inCombat && s.hp !== undefined && s.maxHp && (100 * s.hp) / s.maxHp < LEAVE_DEFEND_HP_PCT)
        return { kind: "act", id: "defend", name: `atacado com HP abaixo de ${LEAVE_DEFEND_HP_PCT}% indo pro ponto: religar a caca e esperar`, tag: "SKIL", body: HUNT_ON };
      const go = goTo(s, spot, p, now, `o ponto ${(p.spotIdx % spots.length) + 1}`);
      if (go?.kind === "wait" && go.reason.startsWith(STUCK_PREFIX)) {
        if (spots.length > 1)
          return { kind: "act", id: "next", name: `${go.reason}: indo pro ponto ${((p.spotIdx + 1) % spots.length) + 1}`, tag: "SKIL", body: HUNT_OFF };
        return { kind: "done", reason: `${go.reason} (confira o ponto salvo)` };
      }
      return go ?? { kind: "act", id: "arrive", name: "chegou no ponto: caca ligada", tag: "SKIL", body: HUNT_ON };
    }
    const d = spotDistance(s, spot);
    const range = spot.range && spot.range > 0 ? spot.range : SPOT_LEAVE_M;
    // Fora do ponto (outro mapa ou longe): so desliga a caca fora de combate e,
    // no mesmo mapa, depois de LEAVE_AFTER_MS seguidos fora do raio (o auto-hunt
    // persegue monstro alem do raio; em Roc Mountain isso desligava a caca a cada
    // 20 s e o char principal morreu andando de volta).
    const farLong = d !== undefined && d > range && p.farSince !== null && now - p.farSince >= LEAVE_AFTER_MS;
    // No mapa do ponto sem posicao ainda (0, 0, 0 logo depois de trocar de canal
    // ou logar): espera carregar em vez de sair viajando.
    const noPosHere = !s.pos && s.scene === spot.scene;
    if ((d === undefined || farLong) && !s.inCombat && !noPosHere) {
      // Em 2026-11-08 16:39 o app novo comecou no ponto 1 a 719 m e saiu com
      // monstro em volta (so olhava o combate): mesma regra da ida pra cidade.
      const block = leaveBlock(s);
      if (block) return { kind: "wait", reason: `voltar pro ponto; esperando ${block}` };
      return {
        kind: "act", id: "leave",
        name: d === undefined ? "fora do mapa do ponto: parar a caca e viajar" : `longe do ponto (${Math.round(d)} m): parar a caca e voltar`,
        tag: "SKIL", body: HUNT_OFF,
      };
    }
  }
  // Religar com a caca ja ligada nao muda o alvo do auto-play; desligar e religar
  // (RESET_GAP_MS sem caca) muda. Uma vez por periodo parado.
  if (now - p.expAt >= STUCK_RESET_MS && p.resetAt <= p.expAt && !p.goingToSpot)
    return { kind: "act", id: "reset", name: `EXP parado ha ${Math.round((now - p.expAt) / 60000)} min: desligar e religar a caca`, tag: "SKIL", body: HUNT_OFF };
  if (now - p.lastGainAt >= IDLE_MS && now - p.huntSentAt >= HUNT_COOLDOWN_MS)
    return { kind: "act", id: "hunt", name: "religar a caca (EXP parado)", tag: "SKIL", body: HUNT_ON };
  return { kind: "wait", reason: "cacando" };
}

export function afterTrainAction(p: TrainProgress, id: TrainAction, now: number, s?: TrainSnapshot, cfg?: TrainConfig): TrainProgress {
  if (id === "hunt") return { ...p, huntSentAt: now, lastGainAt: now };
  if (id === "reset") return { ...p, resetAt: now, huntSentAt: now, lastGainAt: now };
  if (id === "leave") return { ...p, goingToSpot: true, moveSentAt: 0, travelSentAt: 0, travelTries: 0, lastGainAt: now, farSince: null };
  if (id === "move") return { ...p, moveSentAt: now, lastGainAt: now };
  if (id === "travel") return { ...p, travelSentAt: now, travelTries: p.travelTries + 1, moveSentAt: 0, lastGainAt: now };
  if (id === "arrive") return { ...p, goingToSpot: false, huntSentAt: now, lastGainAt: now, expAt: now, fewSince: null, travelTries: 0 };
  if (id === "channel") return { ...p, channelSentAt: now, channelTries: p.channelTries + 1, lastGainAt: now };
  if (id === "dodge") {
    const plan = s && cfg ? dodgePlan(s, cfg, p, now) : null;
    return {
      ...p, dodgeAt: now, playersSince: null, channelSentAt: now, channelTries: 0, lastGainAt: now,
      dodgeFrom: s?.channel !== undefined ? { ...p.dodgeFrom, [s.channel]: now } : p.dodgeFrom,
      channelOverride: plan && plan !== "next" ? plan.channel : p.channelOverride,
    };
  }
  if (id === "next") {
    const n = cfg ? trainSpots(cfg).length : 0;
    const fromPrimary = n > 1 && p.spotIdx % n === 0;
    const toReserve = n > 1 && (p.spotIdx + 1) % n !== 0;
    // Saiu do ponto 1 pouco depois de voltar: o ponto ainda esta forte, espera mais.
    const quick = p.primaryBackAt > 0 && now - p.primaryBackAt < PRIMARY_RETURN_MS;
    const wait = fromPrimary ? (quick ? Math.min(p.primaryWaitMs * 2, PRIMARY_RETURN_MAX_MS) : PRIMARY_RETURN_MS) : p.primaryWaitMs;
    return {
      ...p, spotIdx: p.spotIdx + 1, deathsAtSpot: 0, fewSince: null, lowHpAtSpot: null, goingToSpot: true,
      moveSentAt: 0, travelSentAt: 0, travelTries: 0, channelTries: 0, lastGainAt: now, playersSince: null, dodgeFrom: {}, channelOverride: null,
      reserveSince: toReserve ? (fromPrimary ? now : p.reserveSince ?? now) : null, primaryWaitMs: wait, x10Reserve: false,
    };
  }
  if (id === "safe")
    return {
      ...p, spotIdx: p.spotIdx + 1, deathsAtSpot: 0, fewSince: null, lowHpAtSpot: null, goingToSpot: true,
      moveSentAt: 0, travelSentAt: 0, travelTries: 0, channelTries: 0, lastGainAt: now, playersSince: null, dodgeFrom: {}, channelOverride: null,
      reserveSince: now, x10Reserve: true,
    };
  if (id === "primary")
    return {
      ...p, spotIdx: 0, deathsAtSpot: 0, fewSince: null, lowHpAtSpot: null, goingToSpot: true,
      moveSentAt: 0, travelSentAt: 0, travelTries: 0, channelTries: 0, lastGainAt: now, playersSince: null, dodgeFrom: {}, channelOverride: null,
      reserveSince: null, primaryBackAt: now, x10Reserve: false,
    };
  if (id === "defend") return { ...p, stopReason: null, goingToSpot: false, homeSince: 0, huntSentAt: now, lastGainAt: now, moveSentAt: 0, travelSentAt: 0, travelTries: 0 };
  if (id === "home")
    return {
      ...p, stopReason: p.pauseReason ?? (s && cfg ? stopReason(s, cfg, p) : null) ?? "parando", homeSince: now,
      moveSentAt: 0, travelSentAt: 0, travelTries: 0, goingToSpot: false,
    };
  return { ...p, reviveSentAt: now };
}

// EXP parado e nenhum inimigo por perto: o ponto provavelmente esta numa cidade
// (visto ao vivo em Roc Mountain: so NPC em volta, o auto-play nao sai do lugar).
export const NO_MONSTER_HINT =
  "EXP parado e nenhum monstro por perto: o ponto pode estar numa cidade. Leve o char ate uma area de caca e salve o ponto la.";

// Monstro mais de tanto abaixo do char nao da EXP (Mangyang nv 1 pro nv 60 deu 0).
export const WEAK_AREA_GAP = 15;

// Nivel tipico dos inimigos por perto (mediana) e se a area e fraca pro char.
export function areaVerdict(levels: number[], playerLevel: number): { median: number; weak: boolean } | undefined {
  const xs = levels.filter((l) => l > 0).sort((a, b) => a - b);
  if (!xs.length) return undefined;
  const median = xs[Math.floor(xs.length / 2)];
  return { median, weak: playerLevel - median > WEAK_AREA_GAP };
}

// Niveis dos inimigos por perto (ate `max` entidades olhadas).
// Desligar a caca ao parar o bot so e seguro fora de combate e sem monstro por
// perto. Em 2026-11-07 12:40 o "Parar bot" desligou a caca do char principal em combate
// (o app mandava autoFight(false) sempre); com monstro forte isso mata.
// hpPct (opcional): com HP abaixo de LEAVE_MIN_HP_PCT tambem nao e seguro (a
// morte de 2026-11-08 09:49 foi fora de combate, com HP 48%).
export function safeToStopHunt(inCombat: boolean | undefined, enemiesNear: number, hpPct?: number): boolean {
  if (hpPct !== undefined && hpPct < LEAVE_MIN_HP_PCT) return false;
  return !inCombat && enemiesNear === 0;
}

// Monstros vivos a menos de LEAVE_SAFE_RADIUS_M do char: a mesma conta do Treino
// pra parar a caca. Contar todos os carregados (sem distancia nem corpo) deixou a
// caca ligada na cidade em 2026-11-09 05:13 ("7 monstros por perto"). Sem
// posicao, conta todos (lado seguro).
export async function readEnemiesAround(q: EngineQuery, pos: unknown): Promise<number> {
  if (!Array.isArray(pos) || typeof pos[0] !== "number" || typeof pos[2] !== "number") return (await readNearbyEnemyLevels(q)).length;
  return readEnemiesNear(q, pos[0], pos[2], LEAVE_SAFE_RADIUS_M);
}

export function hpPercent(hp: unknown, maxHp: unknown): number | undefined {
  return typeof hp === "number" && typeof maxHp === "number" && maxHp > 0 ? (100 * hp) / maxHp : undefined;
}

export async function readNearbyEnemyLevels(q: EngineQuery, max = 30): Promise<number[]> {
  const n = await q("GETP", "XEntityMgr GetAll get_Count");
  const count = typeof n.int === "number" ? Math.min(n.int, max) : 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!isMonsterType((await q("GETP", `XEntityMgr GetAll get_Item:${i} ${ENTITY_TYPE}`)).int)) continue;
    const l = await q("GETP", `XEntityMgr GetAll get_Item:${i} get_Attributes get_Level`);
    if (typeof l.int === "number") out.push(l.int);
  }
  return out;
}

// Le as opcoes do auto-play. undefined = nao leu (engine fora ou sem documento).
export async function readOptions(q: EngineQuery, ids: number[]): Promise<Record<number, number | undefined>> {
  const out: Record<number, number | undefined> = {};
  for (const id of ids) {
    const r = await q("GETP", `XOptionsDocument GetValue:${id}`);
    out[id] = r.ok === true && typeof r.int === "number" ? r.int : undefined;
  }
  return out;
}

// Remedios do inventario pela lista do seletor (precisa do dialogo aberto e do
// SetMedicinePanelVisible(1) antes).
export async function readMedicines(q: EngineQuery): Promise<MedicineItem[]> {
  const LIST = "XAutoPlaySettingDlg m_XItemListUpdate";
  const n = await q("GETP", `${LIST} get_Count`);
  const count = typeof n.int === "number" ? Math.min(n.int, 64) : 0;
  const out: MedicineItem[] = [];
  for (let i = 0; i < count; i++) {
    const id = await q("GETP", `${LIST} get_Item:${i} itemID`);
    const c = await q("GETP", `${LIST} get_Item:${i} itemCount`);
    const d = await q("GETP", `${LIST} get_Item:${i} itemConf ItemDescription`);
    if (typeof id.int !== "number") continue;
    out.push({ id: id.int, count: typeof c.int === "number" ? c.int : 0, desc: typeof d.str === "string" ? d.str : "" });
  }
  return out;
}

export async function readTrainSnapshot(q: EngineQuery): Promise<TrainSnapshot | null> {
  const conn = await q("CONN", "");
  const p = conn.player as Record<string, unknown> | undefined;
  if (!p) return null;
  const s: TrainSnapshot = {
    inWorld: p.ok === true,
    dead: p.dead === true,
    exp: typeof p.exp === "number" ? unsignedExp(p.exp) : 0,
    level: typeof p.level === "number" ? p.level : 0,
    inCombat: p.inCombat === true,
  };
  if (typeof p.maxExp === "number") s.maxExp = unsignedExp(p.maxExp);
  if (s.inWorld && typeof p.exp === "number") {
    const hi = await readExpHigh(q);
    s.exp = fullExp(s.exp, hi.exp);
    if (s.maxExp !== undefined) s.maxExp = fullExp(s.maxExp, hi.max);
  }
  if (typeof p.hp === "number") s.hp = p.hp;
  if (typeof p.maxHp === "number") s.maxHp = p.maxHp;
  const c = p.corrected;
  // (0, 0, 0) logo depois do login: a posicao ainda nao carregou.
  if (Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === "number") && !(c[0] === 0 && c[2] === 0))
    s.pos = c as [number, number, number];
  if (s.inWorld) {
    const sc = await q("GETP", "XScene get_SceneID");
    if (sc.ok === true && typeof sc.int === "number") s.scene = sc.int;
  }
  return s;
}

// Gold (item virtual 1).
export async function readGold(q: EngineQuery): Promise<number | undefined> {
  const r = await q("GETP", "XBagDocument GetItemCount:1,0");
  return r.ok === true && typeof r.int === "number" ? r.int : undefined;
}

// Suprimentos do auto-play (visto 2026-11-07 08:25 no char principal): com a pocao dos
// dois espacos de MP zerada e a mochila com 1 espaco livre, o AutoBuy nao repoe e
// o jogo leva o char pra zona segura do mapa (oasis do North Taklamakan) e para.
// Liberar a mochila resolveu: o AutoBuy repos tudo sozinho.
export const BAG_LOW_SLOTS = 3;
export const SUPPLY_SLOTS = { hp: [OPT.HpHealItem1, OPT.HpHealItem2], mp: [OPT.MpHealItem1, OPT.MpHealItem2] };

export interface SupplyState {
  emptySlots?: number; // espacos livres na mochila
  slots: Record<number, number | undefined>; // espaco de pocao -> itemID (0 = vazio)
  stock: Record<number, number | undefined>; // itemID -> unidades
}

// Tipo sem pocao: nenhum espaco do tipo com item que ainda tem unidade.
function outOf(s: SupplyState, ids: number[]): boolean {
  const items = ids.map((id) => s.slots[id]).filter((it): it is number => !!it);
  if (!items.length || items.some((it) => s.stock[it] === undefined)) return false; // nao deu pra ler
  return items.every((it) => (s.stock[it] ?? 0) <= 0);
}

export function supplyWarning(s: SupplyState): string | undefined {
  const out = [outOf(s, SUPPLY_SLOTS.hp) && "HP", outOf(s, SUPPLY_SLOTS.mp) && "MP"].filter(Boolean);
  const full = s.emptySlots !== undefined && s.emptySlots < BAG_LOW_SLOTS;
  if (!out.length && !full) return undefined;
  const parts: string[] = [];
  if (out.length) parts.push(`sem pocao de ${out.join(" e ")} nos espacos do auto-play`);
  if (full) parts.push(`mochila com ${s.emptySlots} espaco(s) livre(s)`);
  return `${parts.join("; ")}: o AutoBuy ${full ? "nao consegue repor" : "precisa repor"}${out.length ? " e o jogo leva o char pra zona segura" : ""}. Libere a mochila.`;
}

export async function readSupply(q: EngineQuery): Promise<SupplyState> {
  const e = await q("GETP", "XBagDocument GetEmptySlotCount");
  const slots = await readOptions(q, [...SUPPLY_SLOTS.hp, ...SUPPLY_SLOTS.mp]);
  const stock: Record<number, number | undefined> = {};
  for (const it of new Set(Object.values(slots).filter((v): v is number => !!v))) {
    const r = await q("GETP", `XBagDocument GetItemCount:${it},0`);
    stock[it] = r.ok === true && typeof r.int === "number" ? r.int : undefined;
  }
  // Ja veio -97 logo depois de reconectar (as outras leituras deram 39): negativo e "nao leu".
  const empty = e.ok === true && typeof e.int === "number" && e.int >= 0 ? e.int : undefined;
  return { emptySlots: empty, slots, stock };
}

// Canal atual e o id da linha de cada canal neste mapa (os ids mudam por mapa:
// Jangan 101..104, Roc Mountain 501..504, North Taklamakan 301..304, com o 301 de
// Activity Channel em 2026-11-11). Pede a lista antes de ler.
export async function readChannel(q: EngineQuery): Promise<{ channel?: number; lines: Record<number, number>; info: Record<number, LineInfo> }> {
  await q("SKIL", "callsn ChannelDocument RequestSceneLineInfo");
  const num = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const cur = await num("ChannelDocument get_CurrentLineID");
  const channel = cur !== undefined ? await num(`ChannelDocument LineIDToLine:${cur}`) : undefined;
  const lines: Record<number, number> = {};
  const info: Record<number, LineInfo> = {};
  const n = Math.min((await num("ChannelDocument _listLine get_Count")) ?? 0, 12);
  for (let i = 0; i < n; i++) {
    const b = `ChannelDocument _listLine get_Item:${i}`;
    const id = await num(`${b} _line+4`);
    if (!id) continue;
    const ch = await num(`ChannelDocument LineIDToLine:${id}`);
    if (!ch) continue;
    lines[ch] = id;
    info[ch] = { state: await num(`${b} _state+4`), activity: (await q("GETP", `${b} get_is_activity_line`)).bool === true };
  }
  return { channel, lines, info };
}

// Jogadores de fora do time, vivos, a ate `radius` m de (x, z); tambem o mais
// perto (pro log). _eEntity_Type: 2 = Role (qualquer jogador), 4 = o proprio
// char, 8 = inimigo. O time vai por entityID (o GETP le os 32 bits de baixo dele
// e do get_ID da entidade; conferido em 2026-11-11). O nome nao serve: nome com
// letra fora do ASCII volta com "?".
export async function readPlayersNear(q: EngineQuery, x: number, z: number, radius: number, max = 80): Promise<{ count: number; nearestM?: number; nearestLevel?: number }> {
  const num = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const team = new Set<number>();
  const tn = Math.min((await num("XTeamDocument get_MyTeam members get_Count")) ?? 0, 10);
  for (let i = 0; i < tn; i++) {
    const id = await num(`XTeamDocument get_MyTeam members get_Item:${i} entityID`);
    if (id !== undefined) team.add(id);
  }
  const n = Math.min((await num("XEntityMgr GetAll get_Count")) ?? 0, max);
  let count = 0;
  let nearestM: number | undefined;
  let nearestLevel: number | undefined;
  for (let i = 0; i < n; i++) {
    const base = `XEntityMgr GetAll get_Item:${i}`;
    const type = (await num(`${base} _eEntity_Type`)) ?? 0;
    if (!(type & 2) || type & 4) continue;
    const id = await num(`${base} get_ID`);
    if (id !== undefined && team.has(id)) continue;
    if ((await q("GETP", `${base} get_IsDead`)).bool === true) continue;
    const ex = await num(`${base} _correctedPosition`);
    const ez = await num(`${base} _correctedPosition+8`);
    if (ex === undefined || ez === undefined) continue;
    const d = Math.hypot(bitsToFloat(ex) - x, bitsToFloat(ez) - z);
    if (d > radius) continue;
    count++;
    if (nearestM === undefined || d < nearestM) {
      nearestM = Math.round(d);
      nearestLevel = await num(`${base} get_Attributes get_Level`);
    }
  }
  return { count, nearestM, nearestLevel };
}

// Hora de procurar monstro? (so o que nao precisa ler as entidades)
export function shouldSeek(s: TrainSnapshot | null, p: TrainProgress, now: number, lastSeekAt: number): boolean {
  if (!s || !s.inWorld || s.dead || s.inCombat || !s.pos || s.scene === undefined) return false;
  if (p.goingToSpot || p.stopReason || p.pauseReason) return false;
  if (s.hp !== undefined && s.maxHp && (100 * s.hp) / s.maxHp < LEAVE_MIN_HP_PCT) return false;
  return now - p.expAt >= SEEK_IDLE_MS && now - lastSeekAt >= SEEK_COOLDOWN_MS;
}

// Inimigo vivo mais perto pra ir buscar: null com inimigo ja perto (o auto-play
// cuida e desligar a caca ali e risco) ou sem nenhum ate SEEK_MAX_M dentro do ponto.
export function pickSeekTarget(pos: [number, number, number], enemies: [number, number, number][], spot?: TrainSpot): [number, number, number] | null {
  const dist = (e: [number, number, number]) => Math.hypot(e[0] - pos[0], e[2] - pos[2]);
  if (enemies.some((e) => dist(e) < SEEK_CLEAR_M)) return null;
  const range = spot ? (spot.range && spot.range > 0 ? spot.range : SPOT_LEAVE_M) : Infinity;
  const ok = enemies
    .filter((e) => dist(e) <= SEEK_MAX_M && (!spot || Math.hypot(e[0] - spot.x, e[2] - spot.z) <= range))
    .sort((a, b) => dist(a) - dist(b));
  return ok[0] ?? null;
}

export function seekBody(t: [number, number, number], scene: number): string {
  return `callv3 TeleportDocument TeleportNavigate 3 ${t[0]} ${t[1]} ${t[2]} ${scene} 0`;
}

// XEntity._eEntity_Type: o IsEnemy do jogo e so o bit Enemy (0x8), e pet tambem tem
// esse bit. Lido ao vivo em Jangan, 2026-11-11: pet de combate = 0x10019 (Spirit),
// pet de coleta = 0x20019 (Scavenger). Puppet, Affiliate e Mount tambem nao sao monstro.
const ENTITY_ENEMY = 0x8;
const PET_TYPE_BITS = 0x40 | 0x2000 | 0x4000 | 0x10000 | 0x20000;
const ENTITY_TYPE = "_eEntity_Type";

export function isMonsterType(type: unknown): boolean {
  return typeof type === "number" && (type & ENTITY_ENEMY) !== 0 && (type & PET_TYPE_BITS) === 0;
}

// Posicao (x, altura, z) dos inimigos carregados.
export async function readEnemyPositions(q: EngineQuery, max = 40): Promise<[number, number, number][]> {
  const n = await q("GETP", "XEntityMgr GetAll get_Count");
  const count = typeof n.int === "number" ? Math.min(n.int, max) : 0;
  const out: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const base = `XEntityMgr GetAll get_Item:${i}`;
    if (!isMonsterType((await q("GETP", `${base} ${ENTITY_TYPE}`)).int)) continue;
    // Corpo de monstro (fica uns segundos no chao): nao ataca nem e alvo. Visto
    // ao vivo em 2026-11-08 17:03 (37 corpos em 90 s no Niya Shaman).
    if ((await q("GETP", `${base} get_IsDead`)).bool === true) continue;
    const c: number[] = [];
    for (const off of ["", "+4", "+8"]) {
      const r = await q("GETP", `${base} _correctedPosition${off}`);
      if (typeof r.int === "number") c.push(bitsToFloat(r.int));
    }
    if (c.length === 3) out.push([c[0], c[1], c[2]]);
  }
  return out;
}

// Float guardado como bits no int do GETP.
function bitsToFloat(i: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setInt32(0, i, true);
  return b.getFloat32(0, true);
}

// Inimigos a ate `radius` m de (x, z): posicao em XEntity._correctedPosition
// (x nos bits do float; z em +8).
export async function readEnemiesNear(q: EngineQuery, x: number, z: number, radius: number, max = 40): Promise<number> {
  const n = await q("GETP", "XEntityMgr GetAll get_Count");
  const count = typeof n.int === "number" ? Math.min(n.int, max) : 0;
  let near = 0;
  for (let i = 0; i < count; i++) {
    const base = `XEntityMgr GetAll get_Item:${i}`;
    if (!isMonsterType((await q("GETP", `${base} ${ENTITY_TYPE}`)).int)) continue;
    // Corpo de monstro (fica uns segundos no chao): nao ataca nem e alvo. Visto
    // ao vivo em 2026-11-08 17:03 (37 corpos em 90 s no Niya Shaman).
    if ((await q("GETP", `${base} get_IsDead`)).bool === true) continue;
    const ex = await q("GETP", `${base} _correctedPosition`);
    const ez = await q("GETP", `${base} _correctedPosition+8`);
    if (typeof ex.int !== "number" || typeof ez.int !== "number") continue;
    if (Math.hypot(bitsToFloat(ex.int) - x, bitsToFloat(ez.int) - z) <= radius) near++;
  }
  return near;
}

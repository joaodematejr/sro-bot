// Treino completo por metodo: prepara o auto-play do jogo (opcoes e pocoes),
// liga a caca e vigia ate parar (botao) ou bater o limite de mortes.

import {
  afterTrainAction,
  HUNT_ON,
  RESET_BORN_BODY,
  newTrainProgress,
  nextTrainStep,
  OPT,
  optionFixes,
  optionRestores,
  areaVerdict,
  NO_MONSTER_HINT,
  pickPotion,
  potionsUntranslated,
  readChannel,
  readEnemiesNear,
  readGold,
  readPlayersNear,
  channelBody,
  HUNT_OFF,
  LEAVE_MIN_HP_PCT,
  PLAYER_NEAR_M,
  PLAYER_NEAR_MS,
  dodgePlan,
  LEAVE_SAFE_RADIUS_M,
  pickSeekTarget,
  readEnemyPositions,
  SEEK_ARRIVE_M,
  SEEK_WALK_MAX_MS,
  seekBody,
  shouldSeek,
  stopReason,
  readNearbyEnemyLevels,
  readMedicines,
  readOptions,
  readSupply,
  readTrainSnapshot,
  RESET_GAP_MS,
  setOptionBody,
  SPOT_LEAVE_M,
  spotDistance,
  AT_HOME,
  nearestSpotIdx,
  primaryBackDue,
  atSpot,
  inSafeTown,
  x10LeaveDue,
  supplyWarning,
  TRAIN_OPTIONS,
  trainSpots,
  type TrainConfig,
  type TrainSnapshot,
  trackTrain,
} from "../controller/train";
import {
  joinTeamBody,
  rankTeams,
  readInTeam,
  readTeamList,
  LEAVE_TEAM_BODY,
  TEAM_REFUSED_MS,
  TEAM_TRIES,
  shouldLeaveTeam,
  TEAM_LIST_BODY,
  type TeamConfig,
  teamBonusPct,
} from "../controller/team";
import {
  afterPartyStep,
  CLOSE_TEAM_VIEW_BODY,
  CREATE_TEAM_BODY,
  findInviteCandidates,
  FOLLOW_LOST_WAIT_MS,
  FOLLOW_TOGGLE_BODY,
  followLost,
  inviteBody,
  newPartyMemory,
  nextPartyStep,
  partyStepText,
  partyWanted,
  type PartyStep,
  readParty,
  ACCEPT_INVITE_BODY,
  ACCEPT_REQUESTS_BODY,
  AUTO_JOIN_TOGGLE_BODY,
  FETCH_REQUESTS_BODY,
} from "../controller/party";
import { maybeUseBuffs } from "./booster";
import { BERSERK_CLICK, BERSERK_EVERY_MS, BERSERK_VISIBLE, DEVIL_CLICK, DEVIL_EVERY_MS, shouldBerserk } from "../controller/berserk";
import { LEVELING_OPEN_BODY, levelingPhase, levelingText, readLeveling, shouldOpenLeveling } from "../controller/leveling";
import { levelUpSkills } from "./skills";
import { sellJunk } from "./sell";
import { shouldSell } from "../controller/sell";
import { queryPlayer, sendCommand } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000;
// Checagem do nivel da area: logo depois de ligar a caca e de tempos em tempos.
const AREA_FIRST_MS = 10000;
const AREA_EVERY_MS = 10 * 60 * 1000;
// Leituras extras, so quando a config pede.
const GOLD_EVERY_MS = 30000;
const CHANNEL_EVERY_MS = 15000;
const FEW_EVERY_MS = 20000;
// Jogador de fora do time perto: le no ponto a cada 20 s; o aviso no log no
// maximo a cada 2 min (perto do limite dos 40 m ele entra e sai).
const PLAYERS_EVERY_MS = 20000;
const PLAYERS_LOG_MS = 2 * 60 * 1000;
// Troca de canal: o jogo recarrega o mapa no canal novo; espera ate isso.
const LINE_CHANGE_MAX_MS = 30000;
// Caca desligada pra trocar de canal: espera o "combat mode" acabar ate isso.
const FIGHT_CLEAR_MAX_MS = 12000;
// Time: confere a cada 5 min (lista e entrada custam ~1 min de leituras).
const TEAM_EVERY_MS = 5 * 60 * 1000;
const TEAM_FIRST_MS = 30000;
// Buffs de item (Exp Booster, dano, VIP): confere a cada 1 min, so cacando no ponto.
const BOOSTER_EVERY_MS = 60 * 1000;
const LEVELING_EVERY_MS = 30 * 1000;
// Suprimentos (mochila e pocao dos espacos do auto-play): so le e avisa.
const SUPPLY_EVERY_MS = 5 * 60 * 1000;
const SUPPLY_FIRST_MS = 20000;

let stopRequested = false;
let pauseRequested: string | null = null;

export function stopTrain(): void {
  stopRequested = true;
}

// Pausa segura: o treino sai do combate, leva o char pra cidade salva e conclui
// (pra trocar de char sem deixar o principal no meio dos monstros). null cancela
// enquanto ele ainda nao saiu pra cidade.
export function pauseTrain(reason: string | null): void {
  pauseRequested = reason;
}

type Query = (tag: string, body: string) => Promise<Record<string, unknown>>;

// Troca de canal no ponto. O servidor recusa com o char em "combat mode"
// (ERR_ROLE_IN_COMBAT_STATUS): ate LeaveCombatTime (5 s) + 1 s depois do ultimo
// golpe, dano ou skill (XLevelStatistics.IsInFightingState). Com a caca ligada
// isso quase nunca acontece (em 2026-11-11 13:19, uma folga de ~1 s em 60 s), e
// as 4 trocas das 13:09 foram recusadas. Entao desliga a caca (quem chama ja
// passou pelo leaveBlock: HP alto, fora de combate, nada a 10 m), espera o combate
// acabar e troca. Atacado ou com o HP caindo na espera: religa a caca e desiste.
// A caca sempre volta no fim. Devolve se o char chegou na linha nova.
async function changeLineAtSpot(q: Query, line: number, log: Log): Promise<boolean> {
  await q("SKIL", HUNT_OFF);
  let ok = false;
  try {
    const t0 = Date.now();
    let clear = false;
    while (Date.now() - t0 < FIGHT_CLEAR_MAX_MS) {
      await sleep(500);
      const p = (await q("CONN", "")).player as { inCombat?: boolean; dead?: boolean; hp?: number; maxHp?: number } | undefined;
      const hp = p && typeof p.hp === "number" && p.maxHp ? (100 * p.hp) / p.maxHp : 100;
      if (!p || p.dead || p.inCombat || hp < LEAVE_MIN_HP_PCT) {
        log("atacado esperando o combate acabar pra trocar de canal: caca religada.");
        return false;
      }
      if ((await q("GETP", "XLevelStatistics get_IsInFightingState")).bool === false) {
        clear = true;
        break;
      }
    }
    if (!clear) {
      log(`o jogo seguiu em modo de combate por ${FIGHT_CLEAR_MAX_MS / 1000} s: troca de canal fica pra depois.`);
      return false;
    }
    await q("SKIL", channelBody(line));
    ok = await waitLineChange(q, line);
    return ok;
  } finally {
    await q("SKIL", RESET_BORN_BODY);
    await q("SKIL", HUNT_ON);
  }
}

// Espera o char aparecer em mundo na linha nova, com a posicao ja carregada (true),
// ou o prazo acabar. Logo depois da recarga a posicao vem (0, 0, 0): em 2026-11-11
// 13:21 o Treino leu isso como "fora do mapa do ponto", desligou a caca e andou
// 142 m ate o ponto.
async function waitLineChange(q: Query, line: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < LINE_CHANGE_MAX_MS) {
    await sleep(1000);
    if ((await q("GETP", "ChannelDocument get_CurrentLineID")).int !== line) continue;
    const p = (await q("CONN", "")).player as { ok?: boolean; corrected?: number[] } | undefined;
    const c = p?.corrected;
    if (p?.ok === true && Array.isArray(c) && !(c[0] === 0 && c[2] === 0)) return true;
  }
  return false;
}

// Espaco de pocao vazio: abre o dialogo do auto-play, le os remedios do
// inventario, escolhe pela descricao e fecha. Sem pocao: so avisa (o AutoBuy
// compra quando der).
async function setupPotions(q: Query, current: Record<number, number | undefined>, log: Log): Promise<void> {
  const need = [
    { id: OPT.HpHealItem1, kind: "HP" as const },
    { id: OPT.MpHealItem1, kind: "MP" as const },
  ].filter((s) => current[s.id] === 0);
  if (!need.length) return;
  await q("SKIL", "calls XAutoPlaySettingDlg SetVisible 2 1 1");
  await sleep(3000);
  await q("SKIL", "calls XAutoPlaySettingDlg SetMedicinePanelVisible 1 1");
  await sleep(2000);
  const items = await readMedicines(q);
  const untranslated = potionsUntranslated(items);
  for (const s of need) {
    const id = untranslated ? undefined : pickPotion(items, s.kind);
    if (id === undefined) {
      log(untranslated
        ? `o espaco de pocao de ${s.kind} esta vazio e o jogo nao traduziu as descricoes; escolha a pocao de ${s.kind} no Recover do auto-play do jogo.`
        : `sem pocao de ${s.kind} no inventario; o espaco fica vazio.`);
      continue;
    }
    await q("SKIL", setOptionBody(s.id, id));
    log(`pocao de ${s.kind}: item ${id}.`);
  }
  await q("SKIL", "calls XAutoPlaySettingDlg SetMedicinePanelVisible 1 0");
  await q("SKIL", "calls XAutoPlaySettingDlg SetVisible 2 0 1");
}

// Sem time: pede a lista, escolhe um time aberto e entra. Com time: so avisa
// quando o numero de membros muda.
let lastMembers = -1;

const refusedTeams = new Map<number, number>(); // teamID -> ate quando fica de fora

async function ensureTeam(q: Query, level: number, cfg: TeamConfig, log: Log): Promise<void> {
  const st = await readInTeam(q);
  if (st.inTeam && shouldLeaveTeam(st.members, cfg)) {
    log("sozinho no time (bonus 0%): saindo pra entrar num time com gente.");
    await q("SKIL", LEAVE_TEAM_BODY);
    await sleep(3000);
    lastMembers = -1;
    return;
  }
  if (st.inTeam) {
    if (st.members !== undefined && st.members !== lastMembers)
      log(`no time: ${st.members} membro(s), bonus de ${teamBonusPct(st.members)}% de EXP e SP.`);
    lastMembers = st.members ?? lastMembers;
    return;
  }
  lastMembers = -1;
  await q("SKIL", TEAM_LIST_BODY);
  await sleep(3000);
  const teams = await readTeamList(q);
  const ln = await q("GETP", "ChannelDocument get_CurrentLineID");
  const now = Date.now();
  for (const [id, until] of refusedTeams) if (until <= now) refusedTeams.delete(id);
  const ranked = rankTeams(teams, level, typeof ln.int === "number" ? ln.int : undefined, cfg, new Set(refusedTeams.keys()));
  if (!ranked.length) {
    log(`nenhum time aberto pra entrar agora (${teams.length} com vaga e entrada automatica${refusedTeams.size ? `, ${refusedTeams.size} recusaram ha pouco` : ""}).`);
    return;
  }
  for (const t of ranked.slice(0, TEAM_TRIES)) {
    log(`entrando no time ${t.teamID} (${t.cur}/${t.total}, canal ${t.line}); o bonus vira ${teamBonusPct(t.cur + 1)}%.`);
    await q("SKIL", joinTeamBody(t.teamID));
    await sleep(4000);
    const after = await readInTeam(q);
    if (after.inTeam) {
      log(`entrou no time: ${after.members ?? "?"} membro(s).`);
      lastMembers = after.members ?? -1;
      return;
    }
    refusedTeams.set(t.teamID, Date.now() + TEAM_REFUSED_MS);
    log(`o time ${t.teamID} nao aceitou; fica de fora por ${TEAM_REFUSED_MS / 60000} min.`);
  }
  log("nao entrou em nenhum time agora; tento de novo depois.");
}

// Um passo de party (controller/party.ts). Criar abre a janela do time no jogo:
// fecha de novo se ela estava fechada antes.
async function runPartyStep(q: Query, step: PartyStep, log: Log): Promise<void> {
  const text = partyStepText(step);
  if (text) log(text + ".");
  switch (step.kind) {
    case "accept":
      await q("SKIL", ACCEPT_INVITE_BODY);
      await sleep(3000);
      log((await q("GETP", "XTeamDocument get_bInTeam")).bool === true ? "entrou no time do convite." : "o convite nao deu certo (expirou ou o time encheu).");
      return;
    case "create": {
      const open = (await q("GETP", "XTeamView IsVisible")).bool === true;
      await q("SKIL", CREATE_TEAM_BODY);
      await sleep(2500);
      if (!open && (await q("GETP", "XTeamView IsVisible")).bool === true) await q("SKIL", CLOSE_TEAM_VIEW_BODY);
      log((await q("GETP", "XTeamDocument get_bIsLeader")).bool === true ? "time criado: lider." : "o jogo nao criou o time agora; tento de novo em 1 min.");
      return;
    }
    case "autoJoin":
      await q("SKIL", AUTO_JOIN_TOGGLE_BODY);
      return;
    case "fetch":
      await q("SKIL", FETCH_REQUESTS_BODY);
      return;
    case "acceptRequests":
      await q("SKIL", ACCEPT_REQUESTS_BODY);
      return;
    case "invite": {
      const found = await findInviteCandidates(q, step.names, sleep);
      for (const c of found) await q("SKIL", inviteBody(c.roleId));
      const miss = step.names.filter((n) => !found.some((c) => c.name.toLowerCase() === n.trim().toLowerCase()));
      if (found.length) log(`convite de time mandado pra ${found.map((c) => c.name).join(", ")}.`);
      else log(`ninguem da lista de convite esta livre agora (${miss.join(", ")}); tento de novo em 3 min.`);
      return;
    }
    case "follow":
      await q("SKIL", FOLLOW_TOGGLE_BODY);
      await sleep(2000);
      return;
  }
}

export async function runTrain(
  host: string,
  port: number,
  cfg: TrainConfig,
  log: Log = () => {},
): Promise<{ ok: boolean; erro?: string; deaths?: number; reason?: string }> {
  stopRequested = false;
  pauseRequested = null;
  const p0 = await queryPlayer(host, port);
  if (!p0.ok) {
    log("char nao esta em mundo; nao iniciado.");
    return { ok: false, erro: "char nao esta em mundo" };
  }
  const q: Query = (tag, body) => sendCommand(host, port, tag, body);

  const ids = [...TRAIN_OPTIONS.map((o) => o.id), OPT.HpHealItem1, OPT.MpHealItem1];
  const opts = await readOptions(q, ids);
  if (opts[OPT.AutoHeal] === undefined) log("opcoes do auto-play nao responderam; treinando com o que o jogo tem.");
  const fixes = optionFixes(opts);
  for (const f of fixes) {
    await q("SKIL", f.body);
    log(`ligado: ${f.name}.`);
  }
  // Pocao posta em espaco vazio fica: nao atrapalha quem usar o jogo depois.
  const restore = async () => {
    if (cfg.restoreOptions === false || !fixes.length) return;
    for (const b of optionRestores(fixes)) await q("SKIL", b);
    log(`opcoes do auto-play devolvidas (${fixes.map((f) => f.name).join(", ")}).`);
  };
  if (cfg.setupPotions) await setupPotions(q, opts, log);

  let prog = newTrainProgress(Date.now());
  // Com ponto salvo e o char fora dele: vai primeiro, liga a caca ao chegar.
  const spots = trainSpots(cfg);
  const s0 = await readTrainSnapshot(q);
  prog.spotIdx = nearestSpotIdx(s0, spots);
  // Comecou num ponto de reserva: conta o tempo pra voltar pro ponto 1.
  if (prog.spotIdx !== 0) prog.reserveSince = Date.now();
  const spot0 = spots.length ? spots[prog.spotIdx] : undefined;
  const d0 = s0 && spot0 ? spotDistance(s0, spot0) : undefined;
  if (spot0 && (d0 === undefined || d0 > (spot0.range || SPOT_LEAVE_M))) {
    // Nao marca goingToSpot direto: o passo "leave" do loop so desliga a caca e
    // viaja com o char seguro. Antes a viagem saia na hora e, em 2026-11-07 13:59,
    // o char principal ficou ~30 s em combate com a caca desligada no Roc Mountain. A caca
    // fica ligada enquanto espera.
    await q("SKIL", RESET_BORN_BODY);
    await q("SKIL", HUNT_ON);
    log(`indo pro ponto ${prog.spotIdx + 1} (${d0 === undefined ? `mapa ${spot0.scene}` : `${Math.round(d0)} m`}); sai com o char seguro (caca ligada ate la).`);
  } else {
    await q("SKIL", RESET_BORN_BODY);
    await q("SKIL", HUNT_ON);
    log("caca ligada.");
  }
  let nextGold = 0;
  let nextChannel = 0;
  let nextFew = 0;
  let nextTeam = Date.now() + TEAM_FIRST_MS;
  let nextPlayers = 0;
  let playersLogAt = 0;
  let extra: {
    gold?: number; channel?: number; channelLines?: Record<number, number>; channelInfo?: TrainSnapshot["channelInfo"];
    playersNear?: number; enemiesNear?: number; enemiesClose?: number;
  } = {};
  let nextAreaCheck = Date.now() + AREA_FIRST_MS;
  let lastVerdict = "";
  let lastDeaths = 0;
  let lastWait = "";
  let noMonsterHinted = false;
  let nextSupply = Date.now() + SUPPLY_FIRST_MS;
  let nextBooster = Date.now() + SUPPLY_FIRST_MS;
  let nextBerserk = 0;
  let nextDevil = 0;
  let nextLeveling = 0;
  let levelingOpenAt = 0;
  let lastLevelingPhase = "";
  let lastSeekAt = 0;
  // Skills e maestrias: confere na partida e a cada nivel novo (so faz algo se o
  // nivel do char passou das maestrias usadas).
  let skillsCheckedLevel = -1;
  let lastSupply = "";
  let pendingSupply = "";
  // Party: criar/manter o time, aceitar convite e seguir o lider.
  const partyCfg = partyWanted(cfg.team) ? cfg.team : undefined;
  let partyMem = newPartyMemory();
  let wasFollowing = false;
  // Pausa (outra atividade vai rodar) seguindo o lider: para de seguir e deixa a
  // caca ligada aqui, como no Treino sem time. O Follow levaria o char embora.
  const releaseFollow = async () => {
    if (!wasFollowing || pauseRequested === null) return;
    await q("SKIL", FOLLOW_TOGGLE_BODY);
    await sleep(1500);
    await q("SKIL", RESET_BORN_BODY);
    await q("SKIL", HUNT_ON);
    wasFollowing = false;
    log("pausa: parou de seguir o lider; caca ligada aqui.");
  };
  while (!stopRequested) {
    const now = Date.now();
    const s = await readTrainSnapshot(q);
    const party = partyCfg && s?.inWorld && !s.dead ? await readParty(q, partyCfg).catch(() => undefined) : undefined;
    if (party && s) {
      const followingNow = !!partyCfg?.follow && party.inTeam && !party.leader && party.following === true;
      s.following = followingNow;
      // O jogo parou de seguir (ou o char saiu do time seguindo): o StopFollow
      // desliga a IA. Religa a caca na hora; pede de novo depois.
      if (followLost(wasFollowing, followingNow)) {
        partyMem = { ...partyMem, followLostAt: now };
        await q("SKIL", RESET_BORN_BODY);
        await q("SKIL", HUNT_ON);
        log(`parou de seguir o lider: caca religada aqui${party.inTeam ? `; peco de novo em ${FOLLOW_LOST_WAIT_MS / 60000} min` : ""}.`);
      }
      if (followingNow && !wasFollowing) {
        log("seguindo o lider: o ponto salvo fica de lado enquanto isso.");
        prog = { ...prog, goingToSpot: false, farSince: null };
      }
      wasFollowing = followingNow;
      if (!prog.stopReason && pauseRequested === null) {
        const ps = nextPartyStep(party, partyCfg!, partyMem, now);
        if (ps.kind !== "none") {
          partyMem = afterPartyStep(partyMem, ps, now);
          await runPartyStep(q, ps, log).catch((e) => log("time: falhou (" + String(e).slice(0, 100) + ")."));
        }
      }
    }
    const spot = spots.length && !s?.following ? spots[prog.spotIdx % spots.length] : undefined;
    if (s?.inWorld && !s.dead) {
      if (cfg.stopMinGold && now >= nextGold) {
        nextGold = now + GOLD_EVERY_MS;
        extra.gold = await readGold(q);
      }
      // Jogador de fora do time perto (so no ponto, cacando).
      if (cfg.avoidPlayers !== false && spot && !prog.goingToSpot && s.pos && atSpot(s, spot) && now >= nextPlayers) {
        nextPlayers = now + PLAYERS_EVERY_MS;
        const pl = await readPlayersNear(q, s.pos[0], s.pos[2], PLAYER_NEAR_M);
        const was = (extra.playersNear ?? 0) > 0;
        if (pl.count > 0 !== was && now - playersLogAt >= PLAYERS_LOG_MS) {
          playersLogAt = now;
          log(pl.count > 0
            ? `jogador de fora do time a ${pl.nearestM} m (Lv.${pl.nearestLevel ?? "?"})${pl.count > 1 ? ` e mais ${pl.count - 1}` : ""}; se ficar ${PLAYER_NEAR_MS / 60000} min, troca de canal.`
            : "nenhum jogador de fora do time perto agora.");
        }
        extra.playersNear = pl.count;
      } else if (prog.goingToSpot) {
        extra.playersNear = undefined;
      }
      // Canais: o ponto pede um, a fuga escolheu um ou ha jogador perto (a fuga
      // precisa da lotacao de cada canal).
      const wantLines = !!spot?.channel || prog.channelOverride !== null || (extra.playersNear ?? 0) > 0;
      if (wantLines && spot && s.scene === spot.scene && !s.inCombat && now >= nextChannel) {
        nextChannel = now + CHANNEL_EVERY_MS;
        const c = await readChannel(q);
        extra = { ...extra, channel: c.channel, channelLines: c.lines, channelInfo: c.info };
      }
      const few = cfg.switchFewMonsters;
      if (few && spot && !prog.goingToSpot && s.scene === spot.scene && now >= nextFew) {
        nextFew = now + FEW_EVERY_MS;
        extra.enemiesNear = await readEnemiesNear(q, spot.x, spot.z, few.radius);
      } else if (prog.goingToSpot) {
        extra.enemiesNear = undefined;
      }
      // Indo parar pra ir pra cidade ou voltar pro ponto: conta os monstros em
      // volta do char antes de desligar a caca (leaveBlock).
      const sd = spot ? spotDistance(s, spot) : undefined;
      const far = !!spot && !prog.goingToSpot && (sd === undefined || sd > (spot.range || SPOT_LEAVE_M));
      const leaving = (!prog.stopReason && (pauseRequested !== null || stopReason(s, cfg, prog) !== null)) || prog.lowHpAtSpot !== null || far
        || x10LeaveDue(cfg, prog) || primaryBackDue(cfg, prog, now) || dodgePlan({ ...s, ...extra }, cfg, prog, now) !== null;
      extra.enemiesClose = leaving && !s.inCombat && s.pos && !inSafeTown(s, cfg) ? await readEnemiesNear(q, s.pos[0], s.pos[2], LEAVE_SAFE_RADIUS_M) : undefined;
    }
    if (cfg.team?.join && !cfg.team.lead && s?.inWorld && !s.dead && now >= nextTeam) {
      nextTeam = now + TEAM_EVERY_MS;
      await ensureTeam(q, s.level, cfg.team, log);
    }
    if (s?.inWorld && !s.dead && now >= nextSupply) {
      nextSupply = now + SUPPLY_EVERY_MS;
      // Aviso so quando duas checagens seguidas concordam (uma leitura ruim nao avisa).
      let sup = await readSupply(q);
      if (cfg.sellJunk && shouldSell(sup.emptySlots) && (await sellJunk(q, log).catch(() => 0)) > 0) sup = await readSupply(q);
      const read = supplyWarning(sup) ?? "";
      const w = read === pendingSupply ? read : lastSupply;
      pendingSupply = read;
      if (w && w !== lastSupply) log(w);
      else if (!w && lastSupply) log("suprimentos ok: pocao nos espacos e mochila com espaco.");
      lastSupply = w;
    }
    if (cfg.autoSkills && s?.inWorld && !s.dead && s.level > skillsCheckedLevel) {
      skillsCheckedLevel = s.level;
      await levelUpSkills(q, s.level, log).catch((e) => log("skills: falhou (" + String(e).slice(0, 100) + ")."));
    }
    // Buffs so cacando no ponto (nao viajando, nao parando, vivo e em mundo).
    if ((cfg.booster || cfg.buffDamage || cfg.buffVip) && s?.inWorld && !s.dead && !prog.goingToSpot && !prog.stopReason && !prog.pauseReason
      && atSpot(s, spot) && now >= nextBooster) {
      nextBooster = now + BOOSTER_EVERY_MS;
      await maybeUseBuffs(q, { exp: cfg.booster, dano: cfg.buffDamage, vip: cfg.buffVip }, log).catch(() => undefined);
    }
    // Berserk: o botao so aparece com a barra cheia; usa so em combate no ponto.
    if (cfg.berserk !== false && now >= nextBerserk && shouldBerserk(s, prog.goingToSpot)) {
      nextBerserk = now + BERSERK_EVERY_MS;
      if ((await q("GETP", BERSERK_VISIBLE)).bool === true) {
        await q("SKIL", BERSERK_CLICK);
        log("modo Berserk ativado (barra cheia).");
      }
    }
    // Training time x10: abre o guardado 30 min por vez, so cacando no ponto, e
    // avisa quando fecha ou acaba.
    if (cfg.trainingTime !== false && s?.inWorld && !s.dead && now >= nextLeveling) {
      nextLeveling = now + LEVELING_EVERY_MS;
      let l = await readLeveling(q, now);
      const hunting = !prog.goingToSpot && !prog.stopReason && !prog.pauseReason && atSpot(s, spot);
      if (l && shouldOpenLeveling(l, hunting, levelingOpenAt, now)) {
        levelingOpenAt = now;
        await q("SKIL", LEVELING_OPEN_BODY);
        await sleep(1500);
        const after = await readLeveling(q, Date.now());
        log(after && after.openLeftS > l.openLeftS ? `training time x10 aberto por mais ${Math.round((after.openLeftS - l.openLeftS) / 60)} min (${levelingText(after)}).`
          : `pedi pra abrir o training time, mas nao abriu (${l ? levelingText(l) : "sem leitura"}).`);
        l = after ?? l;
      }
      if (l) prog = { ...prog, x10: l.openLeftS > 0 || l.accumMin > 0 };
      if (l && levelingPhase(l) !== lastLevelingPhase) {
        const ph = levelingPhase(l);
        log(ph === "empty" ? `${levelingText(l)}: sem x10 ate o jogo devolver tempo (4 h por dia, ate 20 h).` : `${levelingText(l)}.`);
        lastLevelingPhase = ph;
      }
    }
    // Devil: sem leitura da recarga; clicar em recarga nao faz nada.
    if (cfg.devil !== false && now >= nextDevil && shouldBerserk(s, prog.goingToSpot)) {
      nextDevil = now + DEVIL_EVERY_MS;
      await q("SKIL", DEVIL_CLICK);
    }
    if (s) Object.assign(s, extra);
    if (s) prog = trackTrain(prog, s, now, cfg);
    if (!prog.stopReason && prog.pauseReason !== pauseRequested) prog = { ...prog, pauseReason: pauseRequested };
    // A area so vale no ponto: viajando, ela lia os monstros da cidade de saida.
    if (s?.inWorld && !s.dead && !prog.goingToSpot && now >= nextAreaCheck) {
      nextAreaCheck = now + AREA_EVERY_MS;
      const v = areaVerdict(await readNearbyEnemyLevels(q), s.level);
      const text = !v ? "nenhum inimigo por perto"
        : v.weak ? `area fraca: inimigos nivel ~${v.median} pro char ${s.level}, quase sem EXP; salve um ponto com monstro do seu nivel`
        : `inimigos por perto nivel ~${v.median}`;
      if (text !== lastVerdict) log(text);
      lastVerdict = text;
    }
    if (prog.deaths > lastDeaths) {
      lastDeaths = prog.deaths;
      log(`morreu (${prog.deaths}${cfg.deathLimit > 0 ? `/${cfg.deathLimit}` : ""}).`);
    }
    // Parado sem alvo: anda ate o monstro mais perto e religa a caca (andar
    // desliga o auto-play; a caca volta sempre, mesmo se algo falhar).
    if (pauseRequested === null && shouldSeek(s, prog, now, lastSeekAt) && s?.pos && s.scene !== undefined) {
      lastSeekAt = now;
      const t = pickSeekTarget(s.pos, await readEnemyPositions(q), spot);
      if (t) {
        log(`parado sem monstro por perto: indo ate o mais perto (${Math.round(Math.hypot(t[0] - s.pos[0], t[2] - s.pos[2]))} m)`);
        try {
          await q("SKIL", seekBody(t, s.scene));
          const t0 = Date.now();
          while (Date.now() - t0 < SEEK_WALK_MAX_MS) {
            await sleep(500);
            const p = (await q("CONN", "")).player as { corrected?: number[]; inCombat?: boolean; dead?: boolean } | undefined;
            const c = p?.corrected;
            if (!p || p.inCombat || p.dead || (c && Math.hypot(c[0] - t[0], c[2] - t[2]) <= SEEK_ARRIVE_M)) break;
          }
        } finally {
          await q("SKIL", RESET_BORN_BODY);
          await q("SKIL", HUNT_ON);
        }
        prog = { ...prog, lastGainAt: Date.now() };
        await sleep(POLL_MS);
        continue;
      }
    }
    const step = nextTrainStep(s, cfg, prog, now);
    if (step.kind === "done") {
      // Parou no caminho da cidade (prazo ou caminho travado): sem isso o char
      // ficaria no mundo com a caca desligada. Religa pra ele se defender.
      if (prog.stopReason && !step.reason.endsWith(AT_HOME) && s?.inWorld && !s.dead) {
        await q("SKIL", RESET_BORN_BODY);
        await q("SKIL", HUNT_ON);
        log("caca religada: parou antes de chegar na cidade.");
      }
      log(`concluido: ${step.reason}.`);
      await releaseFollow();
      await restore();
      return { ok: true, deaths: prog.deaths, reason: step.reason };
    }
    if (step.kind === "act") {
      log(step.name);
      // Indo pra cidade seguindo o lider: para de seguir antes (o leaveBlock do
      // passo "home" ja conferiu combate, HP e monstro perto).
      if (step.id === "home" && wasFollowing) {
        await q("SKIL", FOLLOW_TOGGLE_BODY);
        await sleep(1500);
        wasFollowing = false;
      }
      // Chegou no ponto: a IA passa a vagar em volta daqui (e nao do lugar onde
      // o char nasceu/reviveu).
      // Defesa no caminho: andar desliga a IA; o nascimento passa pro lugar atual
      // pra ela lutar aqui e nao voltar andando pro ponto antigo.
      if (step.id === "arrive" || step.id === "defend") await q("SKIL", RESET_BORN_BODY);
      // Troca de canal no ponto (fuga de jogador ou a volta pro canal escolhido):
      // pelo changeLineAtSpot, que espera o "combat mode" acabar e sempre religa a
      // caca (o mapa recarrega no canal novo). Fora do ponto (na cidade) segue o
      // pedido direto, como antes.
      const dodge = step.id === "dodge" && s ? dodgePlan(s, cfg, prog, now) : null;
      const wantCh = prog.channelOverride ?? spot?.channel;
      const target = dodge && dodge !== "next" ? dodge
        : step.id === "channel" && s && spot && atSpot(s, spot) && wantCh && s.channelLines?.[wantCh] ? { channel: wantCh, line: s.channelLines[wantCh] } : null;
      if (target) {
        const ok = await changeLineAtSpot(q, target.line, log);
        log(ok ? `no canal ${target.channel}: caca religada.` : "nao trocou de canal agora; caca religada, tento de novo depois.");
        extra.playersNear = undefined;
        nextPlayers = Date.now() + PLAYERS_EVERY_MS;
      } else {
        await q(step.tag, step.body);
      }
      if (step.id === "reset") {
        await sleep(RESET_GAP_MS);
        // So fixa o nascimento dentro do raio do ponto (preso no oasis, fixaria la).
        const d = s && spot ? spotDistance(s, spot) : undefined;
        if (!spot || (d !== undefined && d <= (spot.range || SPOT_LEAVE_M))) await q("SKIL", RESET_BORN_BODY);
        await q("SKIL", HUNT_ON);
      }
      prog = afterTrainAction(prog, step.id, now, s ?? undefined, cfg);
      if (step.id === "channel" || step.id === "dodge" || step.id === "next" || step.id === "primary" || step.id === "safe") nextChannel = 0;
      if (step.id === "next" || step.id === "primary" || step.id === "safe") extra.enemiesNear = undefined;
      // EXP parado: confere se ha monstro por perto (a checagem da area e a cada
      // 10 min e pode ter pegado um monstro de passagem).
      if (step.id === "hunt" && !noMonsterHinted && !(await readNearbyEnemyLevels(q)).length) {
        log(NO_MONSTER_HINT);
        noMonsterHinted = true;
      }
    } else if (step.reason !== lastWait) {
      lastWait = step.reason;
      if (step.reason !== "cacando") log(step.reason);
    }
    await sleep(POLL_MS);
  }
  // Parado no meio de uma viagem (ponto ou cidade) a caca esta desligada: religa
  // antes de sair (a pausa das diarias na virada do dia para o loop assim).
  if (prog.goingToSpot || prog.stopReason) {
    const sEnd = await readTrainSnapshot(q);
    if (sEnd?.inWorld && !sEnd.dead) {
      await q("SKIL", RESET_BORN_BODY);
      await q("SKIL", HUNT_ON);
      log("caca religada: parado no meio da viagem.");
    }
  }
  await releaseFollow();
  log("parado.");
  await restore();
  return { ok: false, erro: "parado", deaths: prog.deaths };
}

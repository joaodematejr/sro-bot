import assert from "node:assert";
import { test } from "node:test";

import {
  DEAD_FALLBACK_MS,
  DEFAULT_TRAIN_CONFIG,
  DIED_BEFORE_HOME,
  AT_HOME,
  hpPercent,
  nearestSpotIdx,
  safeToStopHunt,
  leaveBlock,
  pickSeekTarget,
  SEEK_IDLE_MS,
  seekBody,
  shouldSeek,
  afterTrainAction,
  areaVerdict,
  HUNT_OFF,
  HUNT_ON,
  IDLE_MS,
  newTrainProgress,
  nextTrainStep,
  OPT,
  optionFixes,
  optionRestores,
  pickPotion,
  RESET_BORN_BODY,
  REVIVE_BACK_CITY,
  SPOT_ARRIVE_M,
  LEAVE_AFTER_MS,
  STUCK_LEAVE_MS,
  STUCK_RESET_MS,
  supplyWarning,
  trackTrain,
  type TrainSnapshot,
  unsignedExp,
  potionsUntranslated,
  PLAYER_NEAR_MS,
  DODGE_COOLDOWN_MS,
  pickDodgeChannel,
} from "../train";

const alive = (exp: number, level = 60): TrainSnapshot => ({ inWorld: true, dead: false, exp, level });
const dead = (exp: number): TrainSnapshot => ({ inWorld: true, dead: true, exp, level: 60 });

test("opcoes: so manda o que esta diferente; reviver sempre na cidade", () => {
  // Valores lidos ao vivo no Alt4 antes do treino.
  const cur = { [OPT.AutoHeal]: 1, [OPT.AutoBuy]: 1, [OPT.AutoPickUp]: 1, [OPT.AutoRevive]: 0,
    [OPT.RevivePlace]: 1, [OPT.ReturnFarming]: 0 };
  const fixes = optionFixes(cur);
  assert.deepEqual(fixes.map((f) => f.body), [
    "callsi XOptionsDocument SetValue 3 4004 1 1",
    `callsi XOptionsDocument SetValue 3 4022 ${REVIVE_BACK_CITY} 1`,
    "callsi XOptionsDocument SetValue 3 4039 1 1",
  ]);
  // Nao lido (engine fora) nao vira comando.
  assert.deepEqual(optionFixes({}), []);
});

test("pocao: escolhe pela descricao e pela restauracao, ignora o que nao tem", () => {
  const items = [
    { id: 351002105, count: 100, desc: "Use to restore 820 HP every half second. Last for 3 seconds." },
    { id: 351002110, count: 100, desc: "Use to restore 820 MP every half second. Last for 3 seconds." },
    { id: 351002205, count: 100, desc: "Reduce duration of abnormal statuses." },
    { id: 351002001, count: 50, desc: "Use to restore 120 HP every half second." },
    { id: 351002999, count: 0, desc: "Use to restore 2000 HP every half second." },
  ];
  assert.equal(pickPotion(items, "HP"), 351002105);
  assert.equal(pickPotion(items, "MP"), 351002110);
  assert.equal(pickPotion([items[2]], "HP"), undefined);
});

test("vigia: EXP parado religa a caca; EXP subindo nao", () => {
  let p = newTrainProgress(0);
  p = trackTrain(p, alive(100), 0);
  p = trackTrain(p, alive(150), 60000);
  assert.equal(nextTrainStep(alive(150), DEFAULT_TRAIN_CONFIG, p, 60000).kind, "wait");
  const late = 60000 + IDLE_MS;
  p = trackTrain(p, alive(150), late);
  const st = nextTrainStep(alive(150), DEFAULT_TRAIN_CONFIG, p, late);
  assert.equal(st.kind === "act" && st.body, HUNT_ON);
  // Subiu de nivel com o EXP zerado: conta como ganho.
  let q = trackTrain(newTrainProgress(0), alive(900, 60), 0);
  q = trackTrain(q, alive(5, 61), IDLE_MS);
  assert.equal(nextTrainStep(alive(5, 61), DEFAULT_TRAIN_CONFIG, q, IDLE_MS).kind, "wait");
});

test("vigia: morte conta uma vez, revive na cidade se o jogo nao reviver, para no limite", () => {
  let p = newTrainProgress(0);
  p = trackTrain(p, alive(100), 0);
  p = trackTrain(p, dead(100), 1000);
  p = trackTrain(p, dead(100), 2000);
  assert.equal(p.deaths, 1);
  assert.equal(nextTrainStep(dead(100), DEFAULT_TRAIN_CONFIG, p, 2000).kind, "wait");
  const st = nextTrainStep(dead(100), DEFAULT_TRAIN_CONFIG, p, 1000 + DEAD_FALLBACK_MS);
  assert.equal(st.kind === "act" && st.body, "callsn ReviveDlg OnBtnBackCityClicked 1");
  p = trackTrain(p, alive(100), 60000);
  p = trackTrain(p, dead(100), 70000);
  assert.equal(p.deaths, 2);
  assert.equal(nextTrainStep(dead(100), { ...DEFAULT_TRAIN_CONFIG, deathLimit: 2 }, p, 70000).kind, "done");
  // Revivido: o tempo morto nao conta como caca parada.
  const r = trackTrain(p, alive(100), 70000 + IDLE_MS);
  assert.equal(nextTrainStep(alive(100), DEFAULT_TRAIN_CONFIG, r, 70000 + IDLE_MS).kind, "wait");
});

test("ponto: longe para a caca, anda, chega e religa; outra cena nao anda", () => {
  const spot = { scene: 100001, x: 2601, y: 73, z: 1781 };
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spot };
  const at = (x: number, z: number, scene = 100001): TrainSnapshot => ({ ...alive(100), scene, pos: [x, 73, z] });
  let p = trackTrain(newTrainProgress(0), at(2601, 1781), 0);
  assert.equal(nextTrainStep(at(2601, 1781), cfg, p, 0).kind, "wait");
  // Perseguindo monstro a 100 m: ainda dentro do raio, nao volta.
  assert.equal(nextTrainStep(at(2701, 1781), cfg, p, 500).kind, "wait");
  // Fora do raio: so volta depois de 20 s seguidos (o auto-hunt persegue alem).
  p = trackTrain(p, at(2801, 1781), 1000, cfg);
  assert.equal(nextTrainStep(at(2801, 1781), cfg, p, 1000).kind, "wait");
  const leave = nextTrainStep(at(2801, 1781), cfg, p, 1000 + LEAVE_AFTER_MS);
  assert.equal(leave.kind === "act" && leave.body, HUNT_OFF);
  p = afterTrainAction(p, "leave", 1000);
  // Anda pela navegacao do jogo (o MOVE empacou num ponto de Roc Mountain).
  const move = nextTrainStep(at(2801, 1781), cfg, p, 2000);
  assert.equal(move.kind === "act" && move.body, "callv3 TeleportDocument TeleportNavigate 3 2601 73 1781 100001 0");
  p = afterTrainAction(p, "travel", 2000);
  assert.equal(nextTrainStep(at(2650, 1781), cfg, p, 5000).kind, "wait"); // andando, sem repetir
  const arrive = nextTrainStep(at(2601 + SPOT_ARRIVE_M - 1, 1781), cfg, p, 9000);
  assert.equal(arrive.kind === "act" && arrive.body, HUNT_ON);
  // Revivido em outra cena: o MOVE nao troca de mapa; para a caca e viaja pelo
  // TeleportNavigate do jogo.
  const other = nextTrainStep(at(100, 100, 100002), cfg, newTrainProgress(0), 0);
  assert.equal(other.kind === "act" && other.id, "leave");
  const going = afterTrainAction(newTrainProgress(0), "leave", 0);
  const travel = nextTrainStep(at(100, 100, 100002), cfg, going, 1000);
  assert.equal(travel.kind === "act" && travel.body, "callv3 TeleportDocument TeleportNavigate 3 2601 73 1781 100001 0");
});

const inMap = (x: number, z: number, extra: Partial<TrainSnapshot> = {}): TrainSnapshot =>
  ({ ...alive(100), scene: 100005, pos: [x, 365, z], ...extra });
const A = { scene: 100005, x: 1325, y: 365, z: 620, channel: 2, range: 100 };
const B = { scene: 100005, x: 650, y: 365, z: 795 };

test("seguranca: em combate nunca desliga a caca pra sair do ponto (o Heroi morreu assim)", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A] };
  const p = trackTrain(newTrainProgress(0), inMap(1600, 620), 0, cfg);
  const later = LEAVE_AFTER_MS;
  assert.equal(nextTrainStep(inMap(1600, 620, { inCombat: true }), cfg, p, later).kind, "wait");
  const leave = nextTrainStep(inMap(1600, 620), cfg, p, later);
  assert.equal(leave.kind === "act" && leave.body, HUNT_OFF);
  // O raio do ponto vale (100 m aqui, nao os 150 padrao).
  const p2 = trackTrain(newTrainProgress(0), inMap(1440, 620), 0, cfg);
  assert.equal(nextTrainStep(inMap(1440, 620), cfg, p2, later).kind, "act");
  // Saiu do raio por pouco tempo (perseguindo monstro): nao para a caca.
  assert.equal(nextTrainStep(inMap(1600, 620), cfg, p, later - 1).kind, "wait");
  // Voltou pra dentro do raio: zera a contagem.
  assert.equal(trackTrain(p, inMap(1325, 620), 5000, cfg).farSince, null);
});

test("canal: troca pelo id da linha do mapa, so fora de combate e no maximo 3 vezes", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A] };
  const lines = { 1: 501, 2: 502, 3: 503, 4: 504 };
  let p = newTrainProgress(0);
  const s = inMap(1325, 620, { channel: 1, channelLines: lines });
  const ch = nextTrainStep(s, cfg, p, 0);
  assert.equal(ch.kind === "act" && ch.body, "callsi ChannelDocument ReqChangeLine 1 502 0");
  assert.notEqual(nextTrainStep({ ...s, inCombat: true }, cfg, p, 0).kind === "act" && "channel", "channel");
  for (let i = 0; i < 3; i++) p = afterTrainAction(p, "channel", i * 20000);
  assert.notEqual(nextTrainStep(s, cfg, p, 100000).kind === "act" && (nextTrainStep(s, cfg, p, 100000) as { id: string }).id, "channel");
  // Ja no canal certo: nao troca.
  assert.equal(nextTrainStep(inMap(1325, 620, { channel: 2, channelLines: lines }), cfg, newTrainProgress(0), 0).kind, "wait");
});

test("troca de ponto: por mortes no ponto ou poucos monstros por 1 min, so com 2+ pontos", () => {
  const few = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B], switchFewMonsters: { radius: 100, min: 2 } };
  const s = inMap(1325, 620, { channel: 2, enemiesNear: 1 });
  let p = trackTrain(newTrainProgress(0), s, 0, few);
  assert.equal(nextTrainStep(s, few, p, 30000).kind, "wait"); // ainda nao deu 1 min
  p = trackTrain(p, s, 61000, few);
  const next = nextTrainStep(s, few, p, 61000);
  assert.equal(next.kind === "act" && next.id, "next");
  p = afterTrainAction(p, "next", 61000);
  const go = nextTrainStep(inMap(1325, 620), few, p, 62000);
  assert.equal(go.kind === "act" && go.body, "callv3 TeleportDocument TeleportNavigate 3 650 365 795 100005 0"); // anda pro ponto 2
  // Monstros voltaram: zera a contagem.
  let q = trackTrain(newTrainProgress(0), s, 0, few);
  q = trackTrain(q, { ...s, enemiesNear: 5 }, 30000, few);
  assert.equal(q.fewSince, null);
  // Mortes.
  const byDeaths = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B], switchDeaths: 2 };
  let d = newTrainProgress(0);
  for (const t of [1, 2]) {
    d = trackTrain(d, { ...inMap(1325, 620), dead: true }, t * 1000, byDeaths);
    d = trackTrain(d, inMap(1325, 620, { channel: 2 }), t * 1000 + 500, byDeaths);
  }
  const nd = nextTrainStep(inMap(1325, 620, { channel: 2 }), byDeaths, d, 5000);
  assert.equal(nd.kind === "act" && nd.id, "next");
  // Morte a caminho do ponto tambem conta (o Alt1 morreu indo pro ponto 1).
  let w = afterTrainAction(newTrainProgress(0), "leave", 0);
  w = trackTrain(w, { ...inMap(1100, 620), dead: true }, 1000, byDeaths);
  w = trackTrain(w, inMap(1055, 627), 2000, byDeaths);
  w = trackTrain(w, { ...inMap(1100, 620), dead: true }, 3000, byDeaths);
  w = trackTrain(w, inMap(1055, 627), 4000, byDeaths);
  const nw = nextTrainStep(inMap(1055, 627), byDeaths, w, 5000);
  assert.equal(nw.kind === "act" && nw.id, "next");
  // Um ponto so: nunca troca.
  assert.notEqual((nextTrainStep(s, { ...few, spots: [A] }, p, 200000) as { id?: string }).id, "next");
});

test("parar: nivel com EXP%, gold baixo; com cidade salva vai pra la antes de concluir", () => {
  const home = { scene: 100005, x: 1055, y: 398, z: 627 };
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A], stopLevel: { level: 61, expPct: 50 }, stopMinGold: 100000 };
  const p = newTrainProgress(0);
  assert.equal(nextTrainStep(inMap(1325, 620, { level: 61, exp: 10, maxExp: 100, channel: 2 }), cfg, p, 0).kind, "wait");
  assert.equal(nextTrainStep(inMap(1325, 620, { level: 61, exp: 60, maxExp: 100 }), cfg, p, 0).kind, "done");
  assert.equal(nextTrainStep(inMap(1325, 620, { level: 62, exp: 0, maxExp: 100 }), cfg, p, 0).kind, "done");
  assert.equal(nextTrainStep(inMap(1325, 620, { gold: 5000 }), cfg, p, 0).kind, "done");
  // Com cidade: para a caca (fora de combate), anda e so conclui ao chegar.
  const withHome = { ...cfg, home };
  const low = inMap(1325, 620, { gold: 5000 });
  assert.equal(nextTrainStep({ ...low, inCombat: true }, withHome, p, 0).kind, "wait");
  const h = nextTrainStep(low, withHome, p, 0);
  assert.equal(h.kind === "act" && h.id, "home");
  const ph = afterTrainAction(p, "home", 0, low, withHome);
  const walk = nextTrainStep(low, withHome, ph, 1000);
  assert.equal(walk.kind === "act" && walk.body, "callv3 TeleportDocument TeleportNavigate 3 1055 398 627 100005 0");
  assert.equal(nextTrainStep(inMap(1056, 627, { gold: 5000 }), withHome, ph, 9000).kind, "done");
});

test("area: mediana dos inimigos e aviso quando e fraca pro char", () => {
  // Visto ao vivo: Mangyang nivel 1 pro char 60.
  assert.deepEqual(areaVerdict([1, 1, 2, 1], 60), { median: 1, weak: true });
  assert.deepEqual(areaVerdict([55, 58, 60, 62], 60), { median: 60, weak: false });
  assert.equal(areaVerdict([], 60), undefined);
  assert.equal(areaVerdict([0, 0], 60), undefined);
});

test("opcoes: ao parar devolve so o que mudou, com o valor original", () => {
  // Valores do Heroi: RevivePlace 0 e ReturnFarming 0, o resto ja ligado.
  const cur = { [OPT.AutoHeal]: 1, [OPT.AutoBuy]: 1, [OPT.AutoPickUp]: 1, [OPT.AutoRevive]: 1,
    [OPT.RevivePlace]: 0, [OPT.ReturnFarming]: 0 };
  assert.deepEqual(optionRestores(optionFixes(cur)), [
    "callsi XOptionsDocument SetValue 3 4022 0 1",
    "callsi XOptionsDocument SetValue 3 4039 0 1",
  ]);
  assert.deepEqual(optionRestores(optionFixes({ ...cur, [OPT.RevivePlace]: 2, [OPT.ReturnFarming]: 1 })), []);
});

test("ponto inalcancavel: depois de 8 viagens sem chegar pula pro proximo (ou para com um so)", () => {
  const two = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B] };
  let p = afterTrainAction(newTrainProgress(0), "leave", 0);
  const far = inMap(1055, 627, { channel: 2 });
  for (let i = 0; i < 8; i++) {
    const st = nextTrainStep(far, two, p, i * 30000);
    assert.equal(st.kind === "act" && st.id, "travel");
    p = afterTrainAction(p, "travel", i * 30000);
  }
  const skip = nextTrainStep(far, two, p, 300000);
  assert.equal(skip.kind === "act" && skip.id, "next");
  const one = nextTrainStep(far, { ...DEFAULT_TRAIN_CONFIG, spots: [A] }, p, 300000);
  assert.equal(one.kind, "done");
});

test("EXP do nivel sem sinal: o maximo do Lv.87 passa de 2^31", () => {
  // Visto ao vivo no Heroi: maxExp -2036146935 (int32) = 2.258.820.361.
  assert.equal(unsignedExp(-2036146935), 2258820361);
  assert.equal(unsignedExp(90113), 90113);
});

test("pocao: descricao sem traducao nao e lida como falta de pocao", () => {
  // Visto no Heroi: 2.530 pocoes de MP (351002203) e a descricao so com a chave.
  const keys = [{ id: 351002203, count: 2530, desc: "ItemList_ItemDescription_351002203" }];
  assert.equal(potionsUntranslated(keys), true);
  assert.equal(potionsUntranslated([{ id: 1, count: 1, desc: "Restore 300 MP" }]), false);
  assert.equal(potionsUntranslated([]), false);
});

test("pausa pedida de fora (Continental): sai do combate, vai pra cidade e conclui", () => {
  const home = { scene: 100005, x: 1055, y: 398, z: 627 };
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A], home };
  const p = { ...newTrainProgress(0), pauseReason: "pausa pro Continental" };
  const s = inMap(1325, 620);
  // Em combate: espera (nunca desliga a caca no meio da luta).
  assert.equal(nextTrainStep({ ...s, inCombat: true }, cfg, p, 0).kind, "wait");
  const h = nextTrainStep(s, cfg, p, 0);
  assert.equal(h.kind === "act" && h.id, "home");
  const ph = afterTrainAction(p, "home", 0, s, cfg);
  assert.equal(ph.stopReason, "pausa pro Continental");
  const done = nextTrainStep(inMap(1056, 627), cfg, ph, 9000);
  assert.equal(done.kind === "done" && done.reason, "pausa pro Continental; na cidade");
  // Sem pausa, segue cacando normalmente.
  assert.notEqual(nextTrainStep(s, cfg, newTrainProgress(0), 0).kind, "done");
});

// 2026-11-08 09:49: a pausa do Continental desligou a caca com HP 48% no meio dos
// monstros do Niya Shaman e o Heroi morreu viajando (-59,7 M de EXP).
test("pausa: so desliga a caca com HP alto e sem monstro perto; morte no caminho avisa", () => {
  const home = { scene: 100005, x: 1055, y: 398, z: 627 };
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A], home };
  const p = { ...newTrainProgress(0), pauseReason: "pausa pro Continental" };
  const low = inMap(1325, 620, { hp: 7800, maxHp: 16181, enemiesClose: 0 });
  assert.equal(leaveBlock(low), "o HP passar de 90%");
  assert.equal(nextTrainStep(low, cfg, p, 0).kind, "wait");
  const crowd = inMap(1325, 620, { hp: 16181, maxHp: 16181, enemiesClose: 3 });
  const w = nextTrainStep(crowd, cfg, p, 0);
  assert.equal(w.kind, "wait");
  assert.equal(w.kind === "wait" && w.reason, "pausa pro Continental; esperando nao ter monstro a menos de 10 m pra ir pra cidade");
  const ok = inMap(1325, 620, { hp: 15000, maxHp: 16181, enemiesClose: 0 });
  assert.equal(leaveBlock(ok), null);
  const h = nextTrainStep(ok, cfg, p, 0);
  assert.equal(h.kind === "act" && h.id, "home");
  const ph = afterTrainAction(p, "home", 0, ok, cfg);
  // Atacado no caminho com HP baixo: religa a caca e volta a esperar.
  const hit = inMap(1400, 700, { hp: 7800, maxHp: 16181, inCombat: true });
  const df = nextTrainStep(hit, cfg, ph, 1000);
  assert.equal(df.kind === "act" && df.id, "defend");
  assert.equal(df.kind === "act" && df.body, HUNT_ON);
  const pd = afterTrainAction(ph, "defend", 1000);
  assert.equal(pd.stopReason, null);
  assert.equal(pd.pauseReason, "pausa pro Continental");
  assert.equal(nextTrainStep(hit, cfg, pd, 2000).kind, "wait");
  // Atacado com HP alto: segue viajando.
  assert.notEqual((nextTrainStep(inMap(1400, 700, { hp: 15000, maxHp: 16181, inCombat: true }), cfg, ph, 1000) as { id?: string }).id, "defend");
  // Morreu viajando: conclui dizendo que nao chegou (o Continental nao roda).
  const dead = nextTrainStep({ ...inMap(1400, 700), dead: true }, cfg, ph, 1000);
  assert.equal(dead.kind === "done" && dead.reason, `pausa pro Continental (${DIED_BEFORE_HOME})`);
  // Parada sem pausa (limite de mortes) segue com o motivo puro.
  const lim = { ...newTrainProgress(0), stopReason: "morreu 1 vez(es) (limite 1)" };
  const d2 = nextTrainStep({ ...inMap(1400, 700), dead: true }, cfg, lim, 1000);
  assert.equal(d2.kind === "done" && d2.reason, "morreu 1 vez(es) (limite 1)");
});

// 2026-11-08: parado 2 a 3 min por vez no Niya Shaman sem monstro em volta.
test("parado sem monstro: procura o mais perto dentro do ponto, so com tudo limpo em volta", () => {
  const s = inMap(1325, 620, { hp: 16181, maxHp: 16181 });
  const p = { ...newTrainProgress(0), expAt: 0 };
  assert.equal(shouldSeek(s, p, SEEK_IDLE_MS - 1, -Infinity), false);
  assert.equal(shouldSeek(s, p, SEEK_IDLE_MS, -Infinity), true);
  assert.equal(shouldSeek({ ...s, inCombat: true }, p, SEEK_IDLE_MS, -Infinity), false);
  assert.equal(shouldSeek({ ...s, hp: 9000 }, p, SEEK_IDLE_MS, -Infinity), false);
  assert.equal(shouldSeek(s, { ...p, pauseReason: "pausa pro Continental" }, SEEK_IDLE_MS, -Infinity), false);
  assert.equal(shouldSeek(s, { ...p, goingToSpot: true }, SEEK_IDLE_MS, -Infinity), false);
  assert.equal(shouldSeek(s, p, SEEK_IDLE_MS, SEEK_IDLE_MS - 1000), false); // acabou de procurar
  const pos: [number, number, number] = [1325, 0, 620];
  // Mais perto entre 25 e 70 m.
  assert.deepEqual(pickSeekTarget(pos, [[1325, 0, 680], [1355, 0, 620], [1500, 0, 620]], A), [1355, 0, 620]);
  // Monstro a menos de 25 m: o auto-play cuida, nao desliga nada.
  assert.equal(pickSeekTarget(pos, [[1335, 0, 620], [1355, 0, 620]], A), null);
  // Fora do raio do ponto ou longe demais: nada.
  assert.equal(pickSeekTarget(pos, [[1325 + 200, 0, 620]], A), null);
  assert.equal(pickSeekTarget(pos, [[1325, 0, 700]], A), null);
  assert.equal(seekBody([1, 2, 3], 100003), "callv3 TeleportDocument TeleportNavigate 3 1 2 3 100003 0");
});

test("HP baixo no ponto: troca pro ponto de reserva so fora de combate", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B], switchLowHp: 50 };
  let p = trackTrain(newTrainProgress(0), inMap(1325, 620, { hp: 9000, maxHp: 16181 }), 0, cfg);
  assert.equal(p.lowHpAtSpot, null); // 55%: acima do limite
  p = trackTrain(p, inMap(1325, 620, { hp: 6500, maxHp: 16181, inCombat: true }), 1000, cfg);
  assert.equal(p.lowHpAtSpot, 40);
  // Em combate nunca sai: segue cacando (as pocoes agem).
  assert.notEqual((nextTrainStep(inMap(1325, 620, { hp: 6500, maxHp: 16181, inCombat: true }), cfg, p, 2000) as { id?: string }).id, "next");
  // Fora de combate mas ainda com HP baixo (02:56: saiu com 7%): espera a caca curar.
  assert.equal(nextTrainStep(inMap(1325, 620, { hp: 1100, maxHp: 16181 }), cfg, p, 2500).kind, "wait");
  assert.equal(nextTrainStep(inMap(1325, 620, { hp: 16000, maxHp: 16181, enemiesClose: 2 }), cfg, p, 2500).kind, "wait");
  const out = nextTrainStep(inMap(1325, 620, { hp: 16000, maxHp: 16181 }), cfg, p, 3000);
  assert.equal(out.kind === "act" && out.id, "next");
  assert.match(out.kind === "act" ? out.name : "", /HP caiu a 40%/);
  const moved = afterTrainAction(p, "next", 3000);
  assert.equal(moved.lowHpAtSpot, null);
  assert.equal(moved.spotIdx, 1);
  // Desligado: HP baixo nao troca.
  const off = trackTrain(newTrainProgress(0), inMap(1325, 620, { hp: 100, maxHp: 16181 }), 0, { ...cfg, switchLowHp: 0 });
  assert.equal(off.lowHpAtSpot, null);
});

test("preso no ponto (Heroi 06:13): desliga e religa a caca uma vez, depois vai pro ponto de reserva fora de combate", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B] };
  const hit = (hp: number) => inMap(1325, 620, { hp, maxHp: 16181, inCombat: true });
  let p = trackTrain(newTrainProgress(0), hit(16000), 0, cfg);
  p = afterTrainAction(p, "hunt", IDLE_MS); // o religar de 3 min nao muda o alvo
  // 6 min sem EXP, mesmo em combate (a caca ja nao fazia nada): desliga e religa.
  p = trackTrain(p, hit(14000), STUCK_RESET_MS, cfg);
  const reset = nextTrainStep(hit(14000), cfg, p, STUCK_RESET_MS);
  assert.equal(reset.kind === "act" && reset.id, "reset");
  assert.equal(reset.kind === "act" && reset.body, HUNT_OFF);
  p = afterTrainAction(p, "reset", STUCK_RESET_MS);
  // Uma vez so por periodo parado.
  assert.notEqual((nextTrainStep(hit(14000), cfg, p, STUCK_RESET_MS + 60000) as { id?: string }).id, "reset");
  // 10 min: em combate nunca sai do ponto.
  assert.notEqual((nextTrainStep(hit(14000), cfg, p, STUCK_LEAVE_MS) as { id?: string }).id, "next");
  const out = nextTrainStep(inMap(1325, 620), cfg, p, STUCK_LEAVE_MS);
  assert.equal(out.kind === "act" && out.id, "next");
  assert.match(out.kind === "act" ? out.name : "", /EXP parado ha 10 min no ponto mesmo religando/);
  // EXP voltou a subir depois do reset: segue cacando, sem trocar.
  const ok = trackTrain(p, inMap(1325, 620, { exp: 200 } as Partial<TrainSnapshot>), STUCK_RESET_MS + 30000, cfg);
  assert.equal(nextTrainStep(inMap(1325, 620), cfg, ok, STUCK_RESET_MS + 60000).kind, "wait");
  // Andando pro ponto nao conta como preso; chegar zera.
  const going = afterTrainAction(newTrainProgress(0), "leave", 0);
  assert.notEqual((nextTrainStep(inMap(1325, 620), cfg, going, STUCK_RESET_MS) as { id?: string }).id, "reset");
  assert.equal(afterTrainAction(going, "arrive", STUCK_RESET_MS).expAt, STUCK_RESET_MS);
});

test("suprimentos (Heroi 08:25): pocao de MP zerada nos dois espacos e mochila cheia viram aviso", () => {
  const slots = { 4034: 351002102, 4035: 351002111, 4036: 351002107, 4037: 351002111 };
  // O caso real: MP 351002107 e 351002111 com 0, mochila com 1 espaco.
  const w = supplyWarning({ emptySlots: 1, slots, stock: { 351002102: 50, 351002107: 0, 351002111: 0 } });
  assert.match(w ?? "", /sem pocao de MP/);
  assert.match(w ?? "", /mochila com 1 espaco/);
  assert.match(w ?? "", /nao consegue repor/);
  // HP ainda tem (o espaco 1 tem 50): nao avisa de HP.
  assert.doesNotMatch(w ?? "", /HP/);
  // Depois de liberar a mochila o AutoBuy repos: sem aviso.
  assert.equal(supplyWarning({ emptySlots: 39, slots, stock: { 351002102: 64, 351002107: 17, 351002111: 138 } }), undefined);
  // So mochila cheia, com pocao: avisa da mochila.
  assert.match(supplyWarning({ emptySlots: 2, slots, stock: { 351002102: 64, 351002107: 17, 351002111: 138 } }) ?? "", /^mochila com 2/);
  // Leitura falhou (estoque desconhecido) ou espaco vazio: nao inventa aviso.
  assert.equal(supplyWarning({ emptySlots: 10, slots, stock: {} }), undefined);
  assert.equal(supplyWarning({ emptySlots: undefined, slots: {}, stock: {} }), undefined);
});

test("nascimento da IA (oasis 2026-11-07): o corpo fixa o _born_pos no lugar atual pelo callp", () => {
  assert.equal(RESET_BORN_BODY, "callp XEntityMgr get_Player _ai ResetBornPosition 0");
});

test("parar o bot (12:40): so desliga a caca fora de combate e sem monstro perto", async () => {
  const { safeToStopHunt } = await import("../train");
  assert.equal(safeToStopHunt(true, 0), false); // o caso de hoje
  assert.equal(safeToStopHunt(false, 3), false);
  assert.equal(safeToStopHunt(undefined, 1), false);
  assert.equal(safeToStopHunt(false, 0), true);
});

test("Treino liga o modo Berserk automatico (AutoDemonizate 4006), sem gastar item", async () => {
  const { OPT, TRAIN_OPTIONS } = await import("../train");
  assert.equal(OPT.AutoDemonizate, 4006);
  assert.deepEqual(TRAIN_OPTIONS.find((o) => o.id === 4006), { id: 4006, name: "modo Berserk automatico", value: 1 });
});

// 2026-11-08 16:39: o app novo comecou no ponto 1 a 719 m e saiu com monstro em volta.
test("volta pro ponto: so desliga a caca com o char seguro; atacado no caminho com HP baixo religa", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A] };
  const other = (extra: Partial<TrainSnapshot>) => ({ ...inMap(100, 100), scene: 100003, ...extra });
  const p = newTrainProgress(0);
  const crowd = nextTrainStep(other({ hp: 16181, maxHp: 16181, enemiesClose: 2 }), cfg, p, 0);
  assert.equal(crowd.kind === "wait" && crowd.reason, "voltar pro ponto; esperando nao ter monstro a menos de 10 m");
  const low = nextTrainStep(other({ hp: 9000, maxHp: 16181, enemiesClose: 0 }), cfg, p, 0);
  assert.equal(low.kind === "wait" && low.reason, "voltar pro ponto; esperando o HP passar de 90%");
  const ok = nextTrainStep(other({ hp: 16000, maxHp: 16181, enemiesClose: 0 }), cfg, p, 0);
  assert.equal(ok.kind === "act" && ok.id, "leave");
  // Longe no mesmo mapa: mesma regra depois do LEAVE_AFTER_MS.
  const far = { ...p, farSince: 0 };
  const farCrowd = nextTrainStep(inMap(600, 600, { hp: 16181, maxHp: 16181, enemiesClose: 1 }), cfg, far, LEAVE_AFTER_MS);
  assert.equal(farCrowd.kind, "wait");
  // Andando pro ponto: atacado com HP abaixo de 60% religa a caca e volta a esperar.
  const going = afterTrainAction(p, "leave", 0);
  const hit = other({ hp: 7000, maxHp: 16181, inCombat: true });
  const df = nextTrainStep(hit, cfg, going, 1000);
  assert.equal(df.kind === "act" && df.id, "defend");
  assert.equal(df.kind === "act" && df.body, HUNT_ON);
  const pd = afterTrainAction(going, "defend", 1000);
  assert.equal(pd.goingToSpot, false);
  assert.equal(nextTrainStep(hit, cfg, pd, 2000).kind === "act", false);
  // HP alto: segue andando.
  assert.notEqual((nextTrainStep(other({ hp: 15000, maxHp: 16181, inCombat: true }), cfg, going, 1000) as { id?: string }).id, "defend");
});

test("ponto de partida: o mais perto do char no mesmo mapa (reabrir o app nao volta pro ponto 1)", () => {
  assert.equal(nearestSpotIdx(inMap(660, 790), [A, B]), 1);
  assert.equal(nearestSpotIdx(inMap(1300, 600), [A, B]), 0);
  assert.equal(nearestSpotIdx({ ...inMap(660, 790), scene: 100003 }, [A, B]), 0);
  assert.equal(nearestSpotIdx(null, [A, B]), 0);
  assert.equal(nearestSpotIdx(inMap(660, 790), []), 0);
});

test("parar a caca (Parar bot, Firm, fim da torre): HP abaixo de 90% tambem nao e seguro", () => {
  assert.equal(safeToStopHunt(false, 0, 48), false); // a morte das 09:49
  assert.equal(safeToStopHunt(false, 0, 95), true);
  assert.equal(safeToStopHunt(false, 0, undefined), true);
  assert.equal(hpPercent(8090, 16181)?.toFixed(0), "50");
  assert.equal(hpPercent(undefined, 16181), undefined);
  assert.equal(hpPercent(100, 0), undefined);
});

test("parada que chega na cidade termina com AT_HOME (o Continental so roda assim)", () => {
  const home = { scene: 100005, x: 1055, y: 398, z: 627 };
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A], home };
  const p = { ...newTrainProgress(0), pauseReason: "pausa pro Continental", stopReason: "pausa pro Continental", homeSince: 0 };
  const st = nextTrainStep(inMap(1055, 627), cfg, p, 1000);
  assert.equal(st.kind === "done" && st.reason, `pausa pro Continental${AT_HOME}`);
  const late = nextTrainStep(inMap(1400, 700), cfg, p, 60 * 60 * 1000);
  assert.equal(late.kind === "done" && late.reason.endsWith(AT_HOME), false);
});

test("corpo de monstro (get_IsDead) nao conta como perto nem vira alvo da busca", async () => {
  const { readEnemiesNear, readEnemyPositions } = await import("../train");
  const f = (v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readInt32LE(); };
  // Item 0 vivo a 3 m, item 1 morto a 2 m, os dois inimigos.
  const pos: Record<number, number[]> = { 0: [3, 0, 0], 1: [2, 0, 0] };
  const q = async (_t: string, body: string) => {
    if (body.endsWith("get_Count")) return { ok: true, int: 2 };
    const i = Number(/get_Item:(\d+)/.exec(body)?.[1]);
    if (body.endsWith("_eEntity_Type")) return { ok: true, int: 0x19 };
    if (body.endsWith("get_IsDead")) return { ok: true, bool: i === 1 };
    const off = body.endsWith("+8") ? 2 : body.endsWith("+4") ? 1 : 0;
    return { ok: true, int: f(pos[i][off]) };
  };
  assert.equal(await readEnemiesNear(q, 0, 0, 10), 1);
  assert.deepEqual(await readEnemyPositions(q), [[3, 0, 0]]);
});

// 2026-11-08: o app mostrava 32,5% do Lv.87 com o jogo em 11,3%.
test("EXP de 64 bits: o maximo do Lv.87 e 6,55 G, com os 4 bytes de cima lidos pelo GETP", async () => {
  const { fullExp, readTrainSnapshot, EXP_HI_BODY, MAXEXP_HI_BODY } = await import("../train");
  assert.equal(fullExp(-2036146935, 1), 6553787657); // lido ao vivo: MaxExp = 0x1_86A2_DD09
  assert.equal(fullExp(737730651, 0), 737730651);
  assert.equal(fullExp(5, 2), 2 * 2 ** 32 + 5); // EXP passou de 4,29 G
  assert.equal(fullExp(-2036146935, undefined), 2258820361); // sem a leitura: como antes
  assert.equal(fullExp(6553787657, 1), 6553787657); // engine ja manda 64 bits
  const q = async (tag: string, body: string) => {
    if (tag === "CONN") return { player: { ok: true, dead: false, level: 87, exp: 737730651, maxExp: -2036146935 } };
    if (body === MAXEXP_HI_BODY) return { ok: true, int: 1 };
    if (body === EXP_HI_BODY) return { ok: true, int: 0 };
    return { ok: false };
  };
  const s = await readTrainSnapshot(q);
  assert.equal(s?.maxExp, 6553787657);
  assert.equal(((100 * (s?.exp ?? 0)) / (s?.maxExp ?? 1)).toFixed(1), "11.3");
});

// 2026-11-08: trocou pro ponto 2 (Niya Hunter, ~15,5 M/h) as 11:26 e ficou 5 h la.
test("ponto de reserva: volta pro ponto 1 depois de 30 min, com o char seguro; saindo de novo logo, a espera dobra", async () => {
  const { PRIMARY_RETURN_MS, PRIMARY_RETURN_MAX_MS } = await import("../train");
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B], switchLowHp: 50 };
  const atA = inMap(1325, 620, { hp: 16181, maxHp: 16181, enemiesClose: 0 });
  const atB = inMap(650, 795, { hp: 16181, maxHp: 16181, enemiesClose: 0 });
  // HP baixo no ponto 1: vai pro 2 e marca a reserva.
  let p = afterTrainAction({ ...newTrainProgress(0), lowHpAtSpot: 48 }, "next", 1000, atA, cfg);
  assert.equal(p.reserveSince, 1000);
  assert.equal(p.primaryWaitMs, PRIMARY_RETURN_MS);
  p = afterTrainAction(p, "arrive", 2000);
  assert.notEqual((nextTrainStep(atB, cfg, p, 1000 + PRIMARY_RETURN_MS - 1) as { id?: string }).id, "primary");
  // Com monstro perto espera (caca ligada); seguro, volta.
  const w = nextTrainStep({ ...atB, enemiesClose: 2 }, cfg, p, 1000 + PRIMARY_RETURN_MS);
  assert.equal(w.kind === "wait" && w.reason, "voltar pro ponto 1; esperando nao ter monstro a menos de 10 m");
  assert.notEqual((nextTrainStep({ ...atB, inCombat: true }, cfg, p, 1000 + PRIMARY_RETURN_MS) as { id?: string }).id, "primary");
  const st = nextTrainStep(atB, cfg, p, 1000 + PRIMARY_RETURN_MS);
  assert.equal(st.kind === "act" && st.id, "primary");
  assert.equal(st.kind === "act" && st.body, HUNT_OFF);
  const t1 = 1000 + PRIMARY_RETURN_MS;
  p = afterTrainAction(p, "primary", t1);
  assert.equal(p.spotIdx % 2, 0);
  assert.equal(p.goingToSpot, true);
  assert.equal(p.reserveSince, null);
  // Saiu do ponto 1 de novo em 10 min: a proxima espera dobra, ate 4 h.
  p = afterTrainAction(afterTrainAction(p, "arrive", t1 + 60000), "next", t1 + 10 * 60000, atA, cfg);
  assert.equal(p.primaryWaitMs, 2 * PRIMARY_RETURN_MS);
  p = { ...p, primaryWaitMs: PRIMARY_RETURN_MAX_MS, primaryBackAt: t1 + 20 * 60000 };
  assert.equal(afterTrainAction({ ...p, spotIdx: 2 }, "next", t1 + 25 * 60000, atA, cfg).primaryWaitMs, PRIMARY_RETURN_MAX_MS);
  // Ficou mais de 30 min no ponto 1 antes de sair: a espera volta pra 30 min.
  assert.equal(afterTrainAction({ ...p, spotIdx: 2 }, "next", t1 + 20 * 60000 + PRIMARY_RETURN_MS, atA, cfg).primaryWaitMs, PRIMARY_RETURN_MS);
  // Um ponto so: nunca volta.
  const one = { ...DEFAULT_TRAIN_CONFIG, spots: [A] };
  assert.notEqual((nextTrainStep(atA, one, { ...newTrainProgress(0), reserveSince: 0 }, PRIMARY_RETURN_MS) as { id?: string }).id, "primary");
});

// 2026-11-09 05:10: sem x10 o Heroi morreu no ponto 1 (-59,7 M, ~25 h de caca a 2,4 M/h).
test("sem training time x10: vai pro ponto 2 com o char seguro e volta pro 1 quando o x10 voltar", async () => {
  const { x10LeaveDue, primaryBackDue } = await import("../train");
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B] };
  const atA = inMap(1325, 620, { hp: 16181, maxHp: 16181, enemiesClose: 0 });
  const atB = inMap(650, 795, { hp: 16181, maxHp: 16181, enemiesClose: 0 });
  const id = (st: ReturnType<typeof nextTrainStep>) => (st.kind === "act" ? st.id : undefined);
  // Sem leitura (ou training time desligado) nada muda.
  let p = newTrainProgress(0);
  assert.equal(id(nextTrainStep(atA, cfg, p, 1000)), undefined);
  // Com x10 (aberto ou guardado) fica no ponto 1.
  assert.equal(id(nextTrainStep(atA, cfg, { ...p, x10: true }, 1000)), undefined);
  // Sem x10: sai so seguro (mesma regra da ida pra cidade).
  p = { ...p, x10: false };
  assert.equal(x10LeaveDue(cfg, p), true);
  const w = nextTrainStep({ ...atA, enemiesClose: 3 }, cfg, p, 1000);
  assert.equal(w.kind === "wait" && w.reason, "sem x10, ir pro ponto 2; esperando nao ter monstro a menos de 10 m");
  assert.equal(id(nextTrainStep({ ...atA, hp: 8000 }, cfg, p, 1000)), undefined);
  assert.equal(id(nextTrainStep({ ...atA, inCombat: true }, cfg, p, 1000)), undefined);
  const st = nextTrainStep(atA, cfg, p, 1000);
  assert.equal(id(st), "safe");
  assert.equal(st.kind === "act" && st.body, HUNT_OFF);
  p = afterTrainAction(afterTrainAction(p, "safe", 1000), "arrive", 2000);
  assert.equal(p.spotIdx % 2, 1);
  assert.equal(p.x10Reserve, true);
  // Sem x10 fica na reserva, mesmo depois dos 30 min da volta normal.
  assert.equal(primaryBackDue(cfg, p, 10 * 60 * 60 * 1000), false);
  assert.notEqual(id(nextTrainStep(atB, cfg, p, 10 * 60 * 60 * 1000)), "primary");
  // O jogo devolveu tempo: volta na hora, com o char seguro.
  p = { ...p, x10: true };
  assert.equal(primaryBackDue(cfg, p, 3000), true);
  const back = nextTrainStep(atB, cfg, p, 3000);
  assert.equal(back.kind === "act" && back.name, "training time x10 disponivel: voltando pro ponto 1");
  assert.equal(afterTrainAction(p, "primary", 3000).x10Reserve, false);
  // Na reserva por HP baixo e o x10 acabou: fica la (nao volta pro ponto 1 sem x10).
  const hp = { ...afterTrainAction({ ...newTrainProgress(0), lowHpAtSpot: 30 }, "next", 1000, atA, cfg), goingToSpot: false, x10: false };
  assert.equal(primaryBackDue(cfg, hp, 1000 + 60 * 60 * 1000), false);
  // Desligado na config, ou um ponto so: nada muda.
  assert.equal(x10LeaveDue({ ...cfg, reserveWithoutX10: false }, { ...newTrainProgress(0), x10: false }), false);
  assert.equal(x10LeaveDue({ ...DEFAULT_TRAIN_CONFIG, spots: [A] }, { ...newTrainProgress(0), x10: false }), false);
});

test("parar a caca fora do Treino conta so monstro vivo a menos de 10 m (nao os 7 carregados na cidade)", async () => {
  const { readEnemiesAround } = await import("../train");
  const f = (v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readInt32LE(); };
  // Tres inimigos: vivo a 5 m, vivo a 300 m, morto a 2 m.
  const pos: Record<number, number[]> = { 0: [5, 0, 0], 1: [300, 0, 0], 2: [2, 0, 0] };
  const q = async (_t: string, body: string) => {
    if (body.endsWith("get_Count")) return { ok: true, int: 3 };
    const i = Number(/get_Item:(\d+)/.exec(body)?.[1]);
    if (body.endsWith("_eEntity_Type")) return { ok: true, int: 0x19 };
    if (body.endsWith("get_IsDead")) return { ok: true, bool: i === 2 };
    if (body.endsWith("get_Level")) return { ok: true, int: 76 };
    const off = body.endsWith("+8") ? 2 : body.endsWith("+4") ? 1 : 0;
    return { ok: true, int: f(pos[i][off]) };
  };
  assert.equal(await readEnemiesAround(q, [0, 0, 0]), 1);
  assert.equal(await readEnemiesAround(q, [1000, 0, 0]), 0);
  // Sem posicao: conta todos os carregados (lado seguro).
  assert.equal(await readEnemiesAround(q, undefined), 3);
});

// 2026-11-11, Jangan: os pets vem com o bit de inimigo e o Night Fang do proprio char
// contava como "monstro a 0 m", travando a saida segura.
test("pet nao conta como monstro perto, nao vira alvo da busca nem entra no nivel da area", async () => {
  const { isMonsterType, readEnemiesNear, readEnemyPositions, readNearbyEnemyLevels } = await import("../train");
  assert.equal(isMonsterType(0x19), true); // monstro comum
  assert.equal(isMonsterType(0x99), true); // elite
  assert.equal(isMonsterType(0x10019), false); // pet de combate
  assert.equal(isMonsterType(0x20019), false); // pet de coleta
  assert.equal(isMonsterType(0x3), false); // outro jogador
  assert.equal(isMonsterType(0x7), false); // o proprio char
  assert.equal(isMonsterType(undefined), false);
  const f = (v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readInt32LE(); };
  // Todos a 1 m: monstro, pet de combate, pet de coleta, jogador, tipo nao lido.
  const types: (number | undefined)[] = [0x19, 0x10019, 0x20019, 0x3, undefined];
  const q = async (_t: string, body: string) => {
    if (body.endsWith("get_Count")) return { ok: true, int: types.length };
    const i = Number(/get_Item:(\d+)/.exec(body)?.[1]);
    if (body.endsWith("_eEntity_Type")) return types[i] === undefined ? { ok: false } : { ok: true, int: types[i] };
    if (body.endsWith("get_IsDead")) return { ok: true, bool: false };
    if (body.endsWith("get_Level")) return { ok: true, int: 80 + i };
    return { ok: true, int: f(body.endsWith("+8") ? 0 : 1) };
  };
  assert.equal(await readEnemiesNear(q, 0, 0, 10), 1);
  assert.deepEqual(await readEnemyPositions(q), [[1, 1, 0]]);
  assert.deepEqual(await readNearbyEnemyLevels(q), [80]);
});

test("buff e x10 so dentro do raio do ponto (o booster de 08:31 foi gasto na cidade)", async () => {
  const { atSpot } = await import("../train");
  assert.equal(atSpot(inMap(1325, 620), A), true);
  assert.equal(atSpot(inMap(1325, 760), A), false); // 140 m, raio do ponto 100
  assert.equal(atSpot({ ...inMap(2406, 1975), scene: 100001 }, A), false); // na cidade
  assert.equal(atSpot(inMap(650, 900), B), true); // 105 m, sem raio: vale o SPOT_LEAVE_M
  assert.equal(atSpot(inMap(0, 0), undefined), true); // sem ponto salvo
});

test("na cidade salva, monstro fixo perto nao prende o Treino (Brownie e Elite Penguin, 08:30)", async () => {
  const { inSafeTown } = await import("../train");
  const home = { scene: 100001, x: 2601, y: 73, z: 1781 };
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A, B], home };
  const town = { ...inMap(2406, 1975, { hp: 16345, maxHp: 16346 }), scene: 100001 };
  assert.equal(inSafeTown(town, cfg), true);
  assert.equal(inSafeTown(inMap(1325, 620), cfg), false);
  assert.equal(inSafeTown(town, { ...cfg, home: undefined }), false); // sem cidade salva
  assert.equal(inSafeTown(town, { ...cfg, spots: [{ ...A, scene: 100001 }] }), false); // ponto no mapa da cidade
  // Sem a leitura dos monstros (o main nao le na cidade), so HP e combate seguram.
  const p = { ...newTrainProgress(0), x10: false };
  assert.equal(nextTrainStep(town, cfg, p, 1000).kind === "act" && (nextTrainStep(town, cfg, p, 1000) as { id: string }).id, "safe");
  assert.equal(nextTrainStep({ ...town, hp: 8000 }, cfg, p, 1000).kind, "wait");
});

test("jogador perto por 2 min: troca pro canal mais vazio, nunca o Activity Channel (301 no North Taklamakan)", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A] };
  const lines = { 1: 501, 2: 502, 3: 503, 4: 504 };
  const info = { 1: { state: 3, activity: true }, 2: { state: 3, activity: false }, 3: { state: 2, activity: false }, 4: { state: 3, activity: false } };
  const s = inMap(1325, 620, { channel: 2, channelLines: lines, channelInfo: info, playersNear: 1 });
  let p = trackTrain(newTrainProgress(0), s, 0, cfg);
  assert.equal(p.playersSince, 0);
  assert.equal(nextTrainStep(s, cfg, p, PLAYER_NEAR_MS - 1).kind, "wait");
  const go = nextTrainStep(s, cfg, p, PLAYER_NEAR_MS);
  // 1 e o Activity Channel; 4 e "Good" e 3 so "Crowded".
  assert.equal(go.kind === "act" && go.id, "dodge");
  assert.equal(go.kind === "act" && go.body, "callsi ChannelDocument ReqChangeLine 1 504 0");
  // Em combate espera (a caca segue ligada).
  const busy = nextTrainStep({ ...s, inCombat: true }, cfg, p, PLAYER_NEAR_MS);
  assert.equal(busy.kind === "wait" && busy.reason, "jogador perto: trocar pro canal 4; esperando sair do combate");
  // Desligado na config: nao foge.
  assert.equal(nextTrainStep(s, { ...cfg, avoidPlayers: false }, p, PLAYER_NEAR_MS).kind, "wait");
  // Trocou: fica no 4 (nao volta pro canal 2 do ponto) e espera a recarga antes de fugir de novo.
  p = afterTrainAction(p, "dodge", PLAYER_NEAR_MS, s, cfg);
  assert.equal(p.channelOverride, 4);
  assert.equal(p.playersSince, null);
  const at4 = inMap(1325, 620, { channel: 4, channelLines: lines, channelInfo: info, playersNear: 1 });
  p = trackTrain(p, at4, PLAYER_NEAR_MS + 1000, cfg);
  assert.equal(nextTrainStep(at4, cfg, p, PLAYER_NEAR_MS * 2 + 1000).kind, "wait"); // ainda no DODGE_COOLDOWN_MS
  // Outro jogador no 4: vai pro 3 (o 2 ficou de fora porque fugiu dele).
  const later = PLAYER_NEAR_MS + DODGE_COOLDOWN_MS + 1000;
  const again = nextTrainStep(at4, cfg, p, later);
  assert.equal(again.kind === "act" && again.body, "callsi ChannelDocument ReqChangeLine 1 503 0");
  p = afterTrainAction(p, "dodge", later, at4, cfg);
  // No 3 tambem: sem canal livre e com um ponto so, segue cacando.
  const at3 = inMap(1325, 620, { channel: 3, channelLines: lines, channelInfo: info, playersNear: 2 });
  p = trackTrain(p, at3, later + 1000, cfg);
  const t3 = later + 1000 + DODGE_COOLDOWN_MS;
  const stay = nextTrainStep(at3, cfg, p, t3);
  assert.ok(stay.kind !== "act" || (stay.id !== "dodge" && stay.id !== "next" && stay.id !== "channel"));
  // Com ponto de reserva vai pra ele.
  const two = { ...cfg, spots: [A, B] };
  const nx = nextTrainStep(at3, two, p, t3);
  assert.equal(nx.kind === "act" && nx.id, "next");
  const after = afterTrainAction(p, "next", t3, at3, two);
  assert.deepEqual([after.channelOverride, after.playersSince, after.dodgeFrom], [null, null, {}]);
});

test("jogador perto: some da leitura zera a conta; viajando nao conta; sem lotacao lida nao escolhe canal", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [A] };
  let p = trackTrain(newTrainProgress(0), inMap(1325, 620, { playersNear: 1 }), 0, cfg);
  assert.equal(p.playersSince, 0);
  assert.equal(trackTrain(p, inMap(1325, 620), 5000, cfg).playersSince, 0); // sem leitura: mantem
  p = trackTrain(p, inMap(1325, 620, { playersNear: 0 }), 20000, cfg);
  assert.equal(p.playersSince, null);
  assert.equal(trackTrain({ ...p, goingToSpot: true }, inMap(1325, 620, { playersNear: 3 }), 30000, cfg).playersSince, null);
  assert.equal(pickDodgeChannel({ channel: 2, channelLines: { 1: 501, 2: 502, 3: 503 } }, { dodgeFrom: {} }, 0), undefined);
  // Canal cheio fica de fora.
  assert.equal(pickDodgeChannel({ channel: 2, channelLines: { 2: 502, 3: 503 }, channelInfo: { 3: { state: 1, activity: false } } }, { dodgeFrom: {} }, 0), undefined);
});

test("no mapa do ponto sem posicao (0, 0, 0 depois de trocar de canal, 13:21): espera, nao sai viajando", () => {
  const cfg = { ...DEFAULT_TRAIN_CONFIG, spots: [{ ...A, channel: undefined }] };
  const p = newTrainProgress(0);
  const noPos: TrainSnapshot = { ...alive(100), scene: 100005 };
  const step = nextTrainStep(noPos, cfg, p, 1000);
  assert.ok(step.kind !== "act" || step.id !== "leave");
  // Em outro mapa continua viajando.
  const other = nextTrainStep({ ...alive(100), scene: 100003 }, cfg, p, 1000);
  assert.equal(other.kind === "act" && other.id, "leave");
});

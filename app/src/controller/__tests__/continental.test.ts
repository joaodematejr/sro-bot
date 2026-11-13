import assert from "node:assert";
import { test } from "node:test";

import {
  type BoxSlot,
  continentalMapFor,
  CONTINENTAL_AUTO_CARDS,
  rankContinentalMapsByAlbum,
  AimTracker,
  AIM_SETTLE_MS,
  ARENA_MAX_MS,
  boardPath,
  chooseAim,
  ContinentalDriver,
  GRID_ADVENTURE,
  GRID_BOX,
  GRID_DICE,
  GRID_EMPTY,
  GRID_NORMAL,
  gridListIndex,
  inArena,
  type ContinentalConfig,
  type ContinentalProgress,
  type ContinentalSnapshot,
  MAP_DATA_WAIT_MS,
  DEFAULT_CONTINENTAL_CONFIG,
  emptyContinentalSnapshot,
  newContinentalProgress,
  nextContinentalStep,
  STUCK_MS,
  TIER_BLUE,
  TIER_GREEN,
  TIER_ORANGE,
  TIER_PURPLE,
  TIER_UNKNOWN,
  tierFromSprite,
  trackContinental,
  chestDelayMs,
  CHEST_MAX_MS,
  CHEST_MIN_MS,
  chestPassRolls,
  contScheduleText,
  DICE_REGEN_MS,
} from "../continental";

// Tabuleiro do Chinese na tela, dados carregados, pronto pra rolar, sem baus.
function snap(p: Partial<ContinentalSnapshot>): ContinentalSnapshot {
  return {
    ...emptyContinentalSnapshot(), inWorld: true, dialog: true, board: true, mapId: 1, maxDice: 10, dice: 6,
    gameState: 2, ...p,
  };
}

// itemID do Chinese (200 + cor); a decisao usa so a cor.
const box = (slot: number, tier: number, state: number): BoxSlot => ({ slot, itemId: 200 + tier, state, tier });

function step(s: ContinentalSnapshot | null, cfg: ContinentalConfig = DEFAULT_CONTINENTAL_CONFIG,
  p: ContinentalProgress = newContinentalProgress()) {
  return nextContinentalStep(s, cfg, p);
}

function id(s: ContinentalSnapshot | null, cfg?: ContinentalConfig, p?: ContinentalProgress): string {
  const st = step(s, cfg, p);
  return st.kind === "act" ? st.id : st.kind;
}

test("abre o dialogo, escolhe o mapa da config e mostra o tabuleiro", () => {
  assert.equal(id(null), "wait");
  assert.equal(id(snap({ inWorld: false })), "wait");
  assert.equal(id(snap({ dialog: false, board: false })), "open");
  const sel = { board: false, selectMap: true };
  const set = step(snap({ ...sel, mapId: 3 }));
  assert.equal(set.kind === "act" && set.body, "callsi XSuperRiskDocument set_CurrentMapID 1 1 0");
  const show = step(snap({ ...sel, mapId: 1 }));
  assert.equal(show.kind === "act" && show.body, "calls SuperRiskDlg ShowGameMap 0");
});

test("tabuleiro de outro mapa: fecha e reabre (o ShowGameMap nao troca com o tabuleiro na tela)", () => {
  const st = step(snap({ mapId: 3 }));
  assert.equal(st.kind === "act" && st.id, "reopen");
  assert.equal(st.kind === "act" && st.body, "calls SuperRiskDlg SetVisible 2 0 1");
  assert.equal(id(snap({ mapId: 3 }), DEFAULT_CONTINENTAL_CONFIG, { ...newContinentalProgress(), reopens: 3 }), "fail");
});

test("modo sono e resumo saem antes de tudo", () => {
  assert.equal(id(snap({ sleeping: true, summary: true, dialog: false, itemAccess: true })), "wake");
  assert.equal(id(snap({ summary: true, dialog: false, itemAccess: true })), "summary");
});

test("popup do item fica por cima e sai primeiro", () => {
  const st = step(snap({ itemAccess: true, slots: [box(0, TIER_PURPLE, 3)] }));
  assert.equal(st.kind === "act" && st.body, "callsn ItemAccessDlg OnCloseClicked 1");
});

test("espera os dados do mapa e reabre se nao chegarem", () => {
  const s = snap({ maxDice: -1 });
  assert.equal(id(s), "wait");
  assert.equal(id(s, DEFAULT_CONTINENTAL_CONFIG, { ...newContinentalProgress(), boardMs: MAP_DATA_WAIT_MS }), "reopen");
});

test("jogo recem-aberto com 0 dados: o maximo nao vem, as casas valem como carregado", () => {
  // Visto ao vivo: m_maxLeftTimes -1 com o tabuleiro na tela e 32 casas.
  const s = snap({ maxDice: -1, grids: 32, dice: 0 });
  const st = step(s, DEFAULT_CONTINENTAL_CONFIG, { ...newContinentalProgress(), boardMs: MAP_DATA_WAIT_MS });
  assert.equal(st.kind === "act" && st.name, "fechar (sem dados)");
  const roll = step(snap({ maxDice: -1, grids: 32, dice: 2 }));
  assert.equal(roll.kind === "act" && roll.name, "rolar o dado (2)");
});

test("tabuleiro ocupado: espera; travado alem do limite: falha", () => {
  assert.equal(id(snap({ gameState: 6 })), "wait");
  assert.equal(id(snap({ gameState: 8 }), DEFAULT_CONTINENTAL_CONFIG, { ...newContinentalProgress(), busyMs: STUCK_MS }), "fail");
  let p = trackContinental(newContinentalProgress(), snap({ gameState: 8 }), 1000);
  p = trackContinental(p, snap({ gameState: 8 }), 1000 + STUCK_MS);
  assert.equal(p.busyMs, STUCK_MS);
  p = trackContinental(p, snap({ gameState: 2 }), 2000 + STUCK_MS);
  assert.equal(p.busyMs, 0);
});

test("baus: pega o pronto com GETREWARD (4), nunca no destravando", () => {
  const ready = step(snap({ slots: [box(0, TIER_GREEN, 2), box(1, TIER_PURPLE, 3)] }));
  assert.equal(ready.kind === "act" && ready.body, "callsi XSuperRiskDocument ChangeBoxState 2 1 4");
  // So destravando: nada a fazer com o bau, rola.
  assert.equal(id(snap({ slots: [box(0, TIER_GREEN, 2)] })), "roll");
});

test("baus: destrava um por vez, cor nao ignorada e melhor primeiro", () => {
  const st = step(snap({ slots: [box(0, TIER_GREEN, 1), box(1, TIER_PURPLE, 1), box(2, TIER_ORANGE, 1)] }));
  // Cheio com verde ignorado trancado: descarta antes de destravar.
  assert.equal(st.kind === "act" && st.body, "callsi XSuperRiskDocument ChangeBoxState 2 0 5");
  const two = step(snap({ slots: [box(0, TIER_GREEN, 1), box(1, TIER_PURPLE, 1)] }));
  assert.equal(two.kind === "act" && two.body, "callsi XSuperRiskDocument ChangeBoxState 2 1 2");
  const ign = step(snap({ slots: [box(0, TIER_BLUE, 1)] }));
  assert.equal(ign.kind === "act" && ign.body, "callsi XSuperRiskDocument ChangeBoxState 2 0 2"); // so tem ele
  assert.equal(id(snap({ slots: [box(0, TIER_GREEN, 2), box(1, TIER_PURPLE, 1)] })), "roll"); // ja tem um destravando
});

test("baus: cheio sem cor ignorada trancada nao descarta nada", () => {
  const full = [box(0, TIER_GREEN, 2), box(1, TIER_PURPLE, 1), box(2, TIER_PURPLE, 1)];
  assert.equal(id(snap({ slots: full })), "roll");
  const keep = { ...DEFAULT_CONTINENTAL_CONFIG, ignoreGreen: false, ignoreBlue: false };
  assert.equal(id(snap({ slots: [box(0, TIER_GREEN, 1), box(1, TIER_BLUE, 1), box(2, TIER_BLUE, 2)] }), keep), "roll");
  // Pego (4) e descartado (5) nao ocupam espaco.
  assert.equal(id(snap({ slots: [box(0, TIER_GREEN, 1), box(1, TIER_PURPLE, 4), box(2, TIER_PURPLE, 2)] })), "roll");
});

test("cor do bau vem do sprite do jogo, igual em qualquer mapa", () => {
  // Visto ao vivo: 200..203 (Chinese) e 350..353 (Desert) davam chest_0..chest_3.
  assert.equal(tierFromSprite("chest_0"), TIER_GREEN);
  assert.equal(tierFromSprite("chest_3"), TIER_ORANGE);
  assert.equal(tierFromSprite(""), TIER_UNKNOWN);
  assert.equal(tierFromSprite(undefined), TIER_UNKNOWN);
  // Verde do Desert ignorado do mesmo jeito que o do Chinese.
  const desertGreen: BoxSlot = { slot: 0, itemId: 350, state: 1, tier: TIER_GREEN };
  const st = step(snap({ slots: [desertGreen, box(1, TIER_PURPLE, 1), box(2, TIER_ORANGE, 1)] }));
  assert.equal(st.kind === "act" && st.body, "callsi XSuperRiskDocument ChangeBoxState 2 0 5");
});

test("cor nao lida: nunca descarta e destrava por ultimo", () => {
  const unknown: BoxSlot = { slot: 0, itemId: 999, state: 1, tier: TIER_UNKNOWN };
  const full = [unknown, box(1, TIER_PURPLE, 2), box(2, TIER_PURPLE, 3)];
  const take = step(snap({ slots: full }));
  assert.equal(take.kind === "act" && take.id, "take"); // pega o pronto, nao mexe no desconhecido
  assert.equal(id(snap({ slots: [unknown, box(1, TIER_PURPLE, 2), box(2, TIER_PURPLE, 1)] })), "roll");
  const order = step(snap({ slots: [unknown, box(1, TIER_GREEN, 1)] }));
  assert.equal(order.kind === "act" && order.body, "callsi XSuperRiskDocument ChangeBoxState 2 0 2"); // verde ignorado fica pra depois
  assert.equal(order.kind === "act" && order.name, "destravar o bau item 999 (espaco 0)");
});

test("fim: sem dados, so abrir baus, 3 roxos ou melhores", () => {
  const none = step(snap({ dice: 0 }));
  assert.equal(none.kind === "act" && none.id, "close");
  const only = { ...DEFAULT_CONTINENTAL_CONFIG, onlyOpenChests: true };
  assert.equal(id(snap({ slots: [box(0, TIER_GREEN, 2)] }), only), "close");
  assert.equal(id(snap({ slots: [box(0, TIER_GREEN, 1)] }), only), "unlock");
  const stop = { ...DEFAULT_CONTINENTAL_CONFIG, stopWhenAllPurple: true };
  const purple = [box(0, TIER_PURPLE, 2), box(1, TIER_ORANGE, 1), box(2, TIER_PURPLE, 1)];
  assert.equal(id(snap({ slots: purple }), stop), "close");
  // Com bau roxo a frente nas proximas casas, nao fecha: continua rolando para buscar o bau!
  const purpleAhead = [{ type: GRID_BOX, tier: TIER_PURPLE, used: false }, { type: GRID_NORMAL, tier: 0 }];
  assert.equal(id(snap({ slots: purple, ahead: purpleAhead }), stop), "roll");
  // Com bau dourado a frente e espacos cheios com roxo trancado, descarta o roxo para abrir vaga ao dourado:
  const orangeAhead = [{ type: GRID_BOX, tier: TIER_ORANGE, used: false }, { type: GRID_NORMAL, tier: 0 }];
  assert.equal(id(snap({ slots: purple, ahead: orangeAhead }), stop), "discard");
  assert.equal(id(snap({ slots: purple })), "roll"); // desligado continua rolando
});

test("driver: cooldown da mesma acao, fecha e conclui com o motivo", () => {
  const d = new ContinentalDriver();
  const s = snap({ dice: 2 });
  assert.equal(d.next(s, 0).send, true);
  assert.equal(d.next(s, 1000).send, false); // mesma rolagem dentro do cooldown
  assert.equal(d.progress.rolls, 1);
  const empty = snap({ dice: 0 });
  const c = d.next(empty, 10000);
  assert.equal(c.step.kind === "act" && c.step.id, "close");
  assert.equal(d.progress.closeSent, true);
  assert.equal(d.next(empty, 11000).send, false); // fechar repete so depois do cooldown
  const fim = d.next(snap({ dialog: false, board: false }), 20000);
  assert.deepEqual(fim.step, { kind: "done", reason: "sem dados" });
});

test("goal do controlador: manda o passo, conclui e falha quando trava", async () => {
  const { ContinentalExplorationGoal, buildActivity } = await import("../activities");
  const { GoalStatus } = await import("../goals");
  let cur: ContinentalSnapshot | null = snap({ dice: 1 });
  const sent: string[] = [];
  let t = 0;
  const io = { send: (_tag: string, body: string) => sent.push(body), state: () => cur };
  const g = new ContinentalExplorationGoal(io, DEFAULT_CONTINENTAL_CONFIG, () => t);
  assert.equal(g.process(), GoalStatus.ACTIVE);
  assert.deepEqual(sent, ["callsi XSuperRiskDocument RequestDicing 1 1 0"]);
  cur = snap({ dice: 0 });
  t = 10000;
  g.process(); // fecha
  cur = snap({ dialog: false, board: false });
  assert.equal(g.process(), GoalStatus.COMPLETED);
  const stuck = new ContinentalExplorationGoal({ send: () => {}, state: () => snap({ gameState: 8 }) },
    DEFAULT_CONTINENTAL_CONFIG, () => t);
  t = 0;
  stuck.process();
  t = STUCK_MS;
  assert.equal(stuck.process(), GoalStatus.FAILED);
  assert.ok(buildActivity("continental_exploration", {} as never, {} as never, undefined, io));
  assert.equal(buildActivity("continental_exploration", {} as never, {} as never), null);
});

const cell = (type: number, tier = TIER_UNKNOWN) => ({ type, tier });
const EMPTY6 = [1, 2, 3, 4, 5, 6].map(() => cell(GRID_EMPTY));

test("caveira: LOSE volta pelo Return, nunca pelo Try Again pago", () => {
  const lose = step(snap({ dialog: false, board: false, gameState: 8, reward: "XMainClient.LevelRewardSuperRiskFailHandler" }));
  assert.equal(lose.kind === "act" && lose.body, "callp XLevelRewardView _DlgHandler OnReturnButtonClicked 1");
  assert.equal(lose.kind === "act" && lose.name, "voltar da caveira (perdeu)");
  const win = step(snap({ dialog: false, board: false, gameState: 8, reward: "XMainClient.LevelRewardSuperRiskHandler" }));
  assert.equal(win.kind === "act" && win.name, "voltar da caveira (venceu)");
  assert.ok(!(lose.kind === "act" && lose.body.includes("ChallengeAgain")));
});

test("caveira: na arena liga o auto-fight uma vez, espera e falha se demorar", () => {
  const arena = snap({ dialog: false, board: false, gameState: 8 });
  const st = step(arena);
  assert.equal(st.kind === "act" && st.body, JSON.stringify({ on: 1 }));
  assert.equal(id(arena, DEFAULT_CONTINENTAL_CONFIG, { ...newContinentalProgress(), arenaAutoSent: true }), "wait");
  assert.equal(id(arena, DEFAULT_CONTINENTAL_CONFIG, { ...newContinentalProgress(), arenaMs: ARENA_MAX_MS }), "fail");
  // Fora da arena (dialogo fechado, jogo parado): abre o dialogo de novo.
  assert.equal(id(snap({ dialog: false, board: false, gameState: 2 })), "open");
});

// 2026-11-08 09:50: o bot reabriu o dialogo enquanto a arena (cena 4009) carregava;
// com o tabuleiro na tela e pronto pra rolar ele so mandava rolar e o Heroi morreu parado.
test("caveira: na cena da arena com o dialogo aberto fecha o dialogo e luta, sem rolar", () => {
  const arena = snap({ scene: 4009, dice: 2, gameState: 2 });
  assert.ok(inArena(arena));
  const st = step(arena);
  assert.equal(st.kind === "act" && st.id, "arenaclose");
  assert.equal(id({ ...arena, dialog: false, board: false }), "arenaauto");
  // Resultado na tela: volta pelo Return mesmo na cena da arena.
  assert.equal(id({ ...arena, dialog: false, reward: "XMainClient.LevelRewardSuperRiskFailHandler" }), "arenareturn");
  // Fechar na arena nao encerra o ciclo (o "close" normal encerra).
  const d = new ContinentalDriver();
  d.next(arena, 0);
  assert.equal(d.progress.closeSent, false);
  // De volta ao mundo segue o tabuleiro.
  assert.ok(!inArena(snap({ scene: 100001, dice: 2, gameState: 2 })));
});

test("caminho e indice das casas batem com o tabuleiro lido ao vivo (12x6)", () => {
  const path = boardPath(12, 6);
  assert.equal(path.length, 32);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path[11], { x: 11, y: 0 });
  assert.deepEqual(path[16], { x: 11, y: 5 });
  assert.deepEqual(path[27], { x: 0, y: 5 });
  assert.deepEqual(path[31], { x: 0, y: 1 }); // END
  // CurrentDynamicInfo ao vivo: 12:(0,1) 13:(11,1) 20:(0,5) 31:(11,5).
  assert.equal(gridListIndex(0, 1, 12, 6), 12);
  assert.equal(gridListIndex(11, 1, 12, 6), 13);
  assert.equal(gridListIndex(0, 5, 12, 6), 20);
  assert.equal(gridListIndex(11, 5, 12, 6), 31);
  assert.equal(gridListIndex(7, 0, 12, 6), 7);
});

test("mira: pede a faixa do melhor alvo e foge da caveira", () => {
  const cfg = DEFAULT_CONTINENTAL_CONFIG;
  // Bau laranja a 6: faixa 5-6 (n=5).
  const orange = [...EMPTY6.slice(0, 5), cell(GRID_BOX, TIER_ORANGE)];
  assert.equal(chooseAim(orange, cfg, false)?.n, 5);
  // Dado extra a 1 e caveira a 4: faixa 1-2.
  const dice = [cell(GRID_DICE), cell(GRID_EMPTY), cell(GRID_EMPTY), cell(GRID_ADVENTURE), cell(GRID_EMPTY), cell(GRID_EMPTY)];
  assert.equal(chooseAim(dice, cfg, false)?.n, 1);
  // Caveira a 3 e 4, "?" a 6: nunca pede 3-4.
  const skull = [cell(GRID_EMPTY), cell(GRID_EMPTY), cell(GRID_ADVENTURE), cell(GRID_ADVENTURE), cell(GRID_EMPTY), cell(GRID_NORMAL)];
  assert.notEqual(chooseAim(skull, cfg, false)?.n, 3);
  // Tudo vazio: faixa do meio (a de mais acerto).
  assert.equal(chooseAim(EMPTY6, cfg, false)?.n, 3);
  // Verde ignorado vale menos que "?".
  const green = [cell(GRID_BOX, TIER_GREEN), cell(GRID_EMPTY), cell(GRID_EMPTY), cell(GRID_EMPTY), cell(GRID_NORMAL), cell(GRID_NORMAL)];
  assert.equal(chooseAim(green, cfg, false)?.n, 5);
  assert.equal(chooseAim(green, { ...cfg, ignoreGreen: false }, false)?.n, 5);
  assert.equal(chooseAim(undefined, cfg, false), undefined);
  // Casa ja usada (cinza) nao vale nada, nem a caveira usada.
  const used = [cell(GRID_EMPTY), cell(GRID_EMPTY), cell(GRID_EMPTY), cell(GRID_EMPTY),
    { type: GRID_BOX, tier: TIER_ORANGE, used: true }, { type: GRID_DICE, tier: TIER_UNKNOWN, used: true }];
  assert.equal(chooseAim(used, cfg, false)?.n, 3);
  assert.equal(chooseAim(used, cfg, false)?.target, "");
});

test("mira: o rolar manda o argumento escolhido e diz o alvo", () => {
  const ahead = [...EMPTY6.slice(0, 5), cell(GRID_BOX, TIER_PURPLE)];
  const st = step(snap({ dice: 3, ahead }));
  assert.equal(st.kind === "act" && st.body, "callsi XSuperRiskDocument RequestDicing 1 5 0");
  assert.equal(st.kind === "act" && st.name, "rolar o dado (3/10) mirando 5-6 (bau roxo a 6)");
  // Sem leitura das casas: rola como antes (1).
  const blind = step(snap({ dice: 3 }));
  assert.equal(blind.kind === "act" && blind.body, "callsi XSuperRiskDocument RequestDicing 1 1 0");
});

test("mira: espera o tabuleiro assentar depois do ShowGameMap", () => {
  const d = new ContinentalDriver();
  const sel = snap({ board: false, selectMap: true, mapId: 1 });
  assert.equal(d.next(sel, 0).step.kind === "act" && d.progress.showSentAt, 0); // mandou o ShowGameMap
  const ahead = [1, 2, 3, 4, 5, 6].map(() => ({ type: 1, tier: -1 }));
  const early = d.next(snap({ dice: 2, ahead }), 2000);
  assert.equal(early.step.kind, "wait");
  const late = d.next(snap({ dice: 2, ahead }), AIM_SETTLE_MS + 100);
  assert.equal(late.step.kind === "act" && late.step.id, "roll");
});

test("mira medida em uso: casa antes e depois da rolagem mirada", () => {
  const t = new AimTracker();
  t.rolled(10, "callsi XSuperRiskDocument RequestDicing 1 3 0", true); // faixa 3-4
  assert.equal(t.observe(undefined), undefined); // andando: sem leitura
  assert.equal(t.observe(10), undefined); // ainda parado na mesma casa
  assert.deepEqual(t.observe(14), { steps: 4, band: 2, hit: true });
  t.rolled(14, "callsi XSuperRiskDocument RequestDicing 1 5 0", true); // faixa 5-6
  assert.deepEqual(t.observe(16), { steps: 2, band: 3, hit: false });
  // Sem mira, ou casa especial que leva longe: nao conta.
  t.rolled(16, "callsi XSuperRiskDocument RequestDicing 1 1 0", false);
  assert.equal(t.observe(18), undefined);
  t.rolled(18, "callsi XSuperRiskDocument RequestDicing 1 1 0", true);
  assert.equal(t.observe(30), undefined);
  assert.deepEqual([t.hits, t.total], [1, 2]);
});

test("passada de baus: logo depois do cronometro, entre 10 min e 2 h", () => {
  // Visto ao vivo: verde destravando com 947 s (15 min) faltando.
  assert.equal(chestDelayMs(947), 947000 + 60000);
  assert.equal(chestDelayMs(0), CHEST_MIN_MS);
  assert.equal(chestDelayMs(28800), CHEST_MAX_MS); // laranja de 8 h: confere a cada 2 h
  assert.equal(chestDelayMs(null), CHEST_MAX_MS);
});

test("passada de baus rola os dados so com o char fora da caca e um dado recarregado", () => {
  const idle = { training: false, inCombat: false, multiChar: false, sinceRoundMs: DICE_REGEN_MS };
  assert.equal(chestPassRolls(idle), true);
  assert.equal(chestPassRolls({ ...idle, training: true }), false); // no ponto: caveira abre luta
  assert.equal(chestPassRolls({ ...idle, inCombat: true }), false);
  assert.equal(chestPassRolls({ ...idle, multiChar: true }), false); // troca de char reinicia o jogo
  assert.equal(chestPassRolls({ ...idle, sinceRoundMs: DICE_REGEN_MS - 1 }), false);
});

test("agenda do Continental mostra a rodada de dados e a passada de baus antes dela", () => {
  const fmt = (t: number) => `t${t}`;
  assert.equal(contScheduleText(500, 200, 100, fmt), "próxima rodada de dados: t500 · passada de baús: t200");
  assert.equal(contScheduleText(500, 600, 100, fmt), "próxima rodada de dados: t500"); // baus depois: a rodada trata
  assert.equal(contScheduleText(50, 200, 100, fmt), "próxima rodada de dados: agora");
  assert.equal(contScheduleText(500, 0, 100, fmt), "próxima rodada de dados: t500 · passada de baús: agora");
});

// Continental no ponto com a caca ligada (sem ir pra cidade; a morte das 09:49
// de 2026-11-08 foi na ida da pausa antiga).
test("no ponto: so comeca com HP de 90% ou mais e desiste fora da arena com HP abaixo de 60%", async () => {
  const { atSpotHpStop } = await import("../continental");
  assert.equal(atSpotHpStop(95, true, false), null);
  assert.equal(atSpotHpStop(85, true, false), "HP em 85% no ponto; rola quando passar de 90%");
  assert.equal(atSpotHpStop(70, false, false), null); // rolando: so desiste abaixo de 60%
  assert.equal(atSpotHpStop(55, false, false), "HP caiu a 55% no ponto: tabuleiro fechado, Continental fica pra depois");
  assert.equal(atSpotHpStop(20, false, true), null); // na arena luta ate o fim (perder nao custa EXP)
  assert.equal(atSpotHpStop(undefined, true, false), null);
});

test("mapa automatico: o mais alto que o nivel do char libera (Lv.87 rolava no Chinese Lv.30)", () => {
  const auto = { ...DEFAULT_CONTINENTAL_CONFIG, mapId: 0 };
  assert.equal(continentalMapFor(auto, 87), 6); // Asia Minor (Lv85)
  assert.equal(continentalMapFor(auto, 90), 7); // Central Asia
  assert.equal(continentalMapFor(auto, 60), 3); // Desert
  assert.equal(continentalMapFor(auto, 59), 2);
  assert.equal(continentalMapFor(auto, 0), 1); // nivel nao lido
  assert.equal(continentalMapFor({ mapId: 3 }, 87), 3); // fixo na config
  const sel = { board: false, selectMap: true };
  const set = step(snap({ ...sel, mapId: 1, level: 87 }), auto);
  assert.equal(set.kind === "act" && set.body, "callsi XSuperRiskDocument set_CurrentMapID 1 6 0");
  // Tabuleiro do Chinese aberto com o automatico pedindo o Asia Minor: reabre pra trocar.
  const st = step(snap({ mapId: 1, level: 87 }), auto);
  assert.equal(st.kind === "act" && st.id, "reopen");
});

test("mapa automatico por cards: prioriza o mapa cujos cards faltam para fechar estrelas", () => {
  const groupChinese = {
    groupId: 1,
    name: "Beginning",
    currentStar: 0,
    maxStar: 2,
    actionNum: 0,
    sets: [
      {
        setId: 101,
        groupId: 1,
        status: 2,
        active: false,
        canActive: false,
        starRequirements: {
          0: [{ cardId: 6001, count: 2 }],
          1: [{ cardId: 6001, count: 4 }],
          2: [{ cardId: 6001, count: 6 }],
        },
      },
    ],
  };

  const groupHotan = {
    groupId: 2,
    name: "Discover",
    currentStar: 2,
    maxStar: 2,
    actionNum: 10,
    sets: [],
  };

  const groupDesert = {
    groupId: 3,
    name: "Master",
    currentStar: 1,
    maxStar: 2,
    actionNum: 2,
    sets: [
      {
        setId: 301,
        groupId: 3,
        status: 2,
        active: false,
        canActive: false,
        starRequirements: {
          1: [{ cardId: 6041, count: 5 }],
          2: [{ cardId: 6041, count: 10 }],
        },
      },
    ],
  };

  const owned = new Map<number, number>([
    [6001, 1], // falta apenas 1 para fechar no Chinese (urgencia maxima)
    [6041, 0], // faltam 5 no Desert
  ]);

  const ranked = rankContinentalMapsByAlbum([groupChinese, groupHotan, groupDesert], owned, 80);
  assert.ok(ranked.length >= 3);
  // Chinese (id 1) deve vir em 1º lugar porque falta só 1 carta para fechar o set atual
  assert.equal(ranked[0].mapId, 1);
  assert.ok(ranked[0].score > ranked[1].score);
  // Hotan (id 2) ja esta no maximo (currentStar === maxStar), entao score 0
  const hotanScore = ranked.find((r) => r.mapId === 2);
  assert.equal(hotanScore?.score, 0);

  // continentalMapFor com CONTINENTAL_AUTO_CARDS escolhe o mapa de maior score
  const cfgAutoCards = {
    ...DEFAULT_CONTINENTAL_CONFIG,
    mapId: CONTINENTAL_AUTO_CARDS,
    albumSnapshot: {
      inWorld: true,
      tablesLoaded: true,
      groups: [groupChinese, groupHotan, groupDesert],
      ownedCounts: owned,
      cardMeta: new Map(),
    },
  };
  assert.equal(continentalMapFor(cfgAutoCards, 80), 1);
});

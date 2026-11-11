// Continental Exploration (nome interno SuperRisk) 100% por metodo e guiado por
// estado: le o tabuleiro e os baus pelo engine e escolhe UMA acao por vez.
// Logica pura; quem chama (main ou goal do controlador) faz as leituras com
// readContinentalSnapshot e manda o comando devolvido.
//
// Estado mapeado ao vivo (engine GETP/KEYS/ENUM, 2026-11-05; ver DISCOVERY.md):
//   Dialogo            -> SuperRiskDlg.IsVisible; abre na selecao de mapa
//   Tabuleiro na tela  -> SuperRiskDlg _GameHandler IsVisible
//   Selecao de mapa    -> SuperRiskDlg _SelectMapHandler IsVisible. Trocar de mapa
//                         so pega daqui: set_CurrentMapID(id) + ShowGameMap(). Com o
//                         tabuleiro ja na tela o ShowGameMap nao recarrega (o doc
//                         fica com um id e a tela com outro), entao fecha e reabre.
//   Dados carregados   -> m_maxLeftTimes >= 0 (vem -1 ate o ShowGameMap pedir o mapa)
//                         ou CurrentDynamicInfo com as casas: com o jogo recem-aberto
//                         e 0 dados o servidor manda o tabuleiro mas o maximo fica -1
//   Dados restantes    -> m_leftDiceTime (compartilhado entre mapas)
//   Estado do jogo     -> GameState (SuperRiskState): 2 = pronto pra rolar; 4..8
//                         rolando/andando/evento; 9 recarregando o mapa (END); 10
//                         animacao do bau
//   Baus guardados     -> SlotBoxInfo (Dictionary slot -> ClientBoxInfo, 3 espacos,
//                         compartilhado entre mapas): itemID e state
//                         (RiskBoxState 1 trancado, 2 destravando, 3 pronto, 4 pegar,
//                         5 descartar)
//   Cor do bau         -> SuperRiskDlg _GameHandler GetBoxSprNameByState:<itemID>
//                         = "chest_0".."chest_3" (verde, azul, roxo, laranja). O
//                         itemID muda por mapa (Chinese 200..203, Desert 350..353)
//   Popup do item      -> ItemAccessDlg visivel ("How to receive")
//   Modo sono          -> XSleepModeUI / XBattleRewardDlg, como na torre: o jogo
//                         parado escurece a tela e esconde o dialogo
//
// Mira (2026-11-06, 47 rolagens): RequestDicing(n) puxa o dado pra faixa
// ceil(n/2) do medidor (1-2, 3-4, 5-6) em ~70% das vezes; o resto desvia uma
// casa. O bot olha as 6 casas a frente e pede a faixa de maior valor esperado:
// bau (pela cor; ignorada vale pouco), dado extra, "?" e END; a caveira vale
// negativo (chars lv60 perderam 2 de 2 na arena dela).
//   Tamanho            -> XSuperRiskMapMgr CurrentMap StaticInfo get_Width/get_Height (12x6)
//   Posicao do char    -> XSuperRiskMapMgr CurrentMap PlayerCoord (x) e PlayerCoord+4 (y)
//   Casas              -> CurrentDynamicInfo, so a borda, por linha (y, depois x);
//                         o caminho e horario de Start (0,0) ate END (0,1)
//
// Casa caveira: arena fora do tabuleiro (SuperRiskDlg some). No fim vem o
// XLevelRewardView com o _DlgHandler LevelRewardSuperRiskFailHandler (LOSE) ou
// LevelRewardSuperRiskHandler (vitoria). Sair = OnReturnButtonClicked. O
// OnChallengeAgainButtonClicked ("Try Again") custa 10 Silk: nunca chamar.
// A arena e uma cena de instancia (4009 no Chinese, visto ao vivo em 2026-11-08);
// os mapas do mundo sao 100001 em diante. Em 2026-11-08 09:50 o bot reabriu o
// SuperRiskDlg durante o carregamento da arena: com o dialogo na tela a regra
// antiga (dialogo fechado + estado 8) nao via a arena, o bot ficou 9 min tentando
// rolar e o char principal morreu parado. Por isso a cena manda, e na arena sempre luta
// (parado perde sempre; perder la nao custa EXP).

import { type EngineQuery, SAME_ACTION_COOLDOWN_MS } from "./tower";
import { LEAVE_DEFEND_HP_PCT, LEAVE_MIN_HP_PCT } from "./train";

export interface ContinentalConfig {
  mapId: number; // 0 = automatico (o mais alto que o nivel do char libera); 1..7 = mapa fixo
  ignoreGreen: boolean; // CHK_GREEN
  ignoreBlue: boolean; // CHK_BLUE
  restartWhenStuck: boolean; // CHK_RESTART: "Stuck in the activity for too long => Quit the game"
  onlyOpenChests: boolean; // CHK_ONLY_OPEN_BOX: so destrava e pega, nao rola
  stopWhenAllPurple: boolean; // CHK_STOP_BOX_FULL: para de rolar com os 3 baus roxos ou melhores
  // Rolando no ponto de caca com a caca ligada: so comeca com HP alto, desiste
  // se o HP cair (fora da arena) e nunca pede pra reiniciar o jogo.
  atSpot?: boolean;
}

// Ficam de fora de proposito: CHK_NORMAL_REWARD (so faz sentido mirando o dado)
// e CHK_BUY_ONLINE_BOX (Special Chest, pago). O "Open now" do bau tambem e pago
// e nunca e chamado.
export const DEFAULT_CONTINENTAL_CONFIG: ContinentalConfig = {
  mapId: 0,
  ignoreGreen: true,
  ignoreBlue: true,
  restartWhenStuck: true,
  onlyOpenChests: false,
  stopWhenAllPurple: false,
};

// Nomes e niveis lidos no jogo em 2026-11-11 (GetMapIdByIndex:0..6, NeedLevel e
// MapTittleName). Todos tem o mesmo tabuleiro (5 baus, ~7 "?", 3 dados, 1
// caveira); muda o conteudo: baus proprios por mapa e cartas dos monstros da
// regiao nos "?".
export const CONTINENTAL_MAPS: { id: number; name: string; level: number }[] = [
  { id: 1, name: "Chinese", level: 30 },
  { id: 2, name: "Hotan", level: 45 },
  { id: 3, name: "Desert", level: 60 },
  { id: 4, name: "Roc Mountain", level: 75 },
  { id: 5, name: "Eastern Europe", level: 80 },
  { id: 6, name: "Asia Minor", level: 85 },
  { id: 7, name: "Central Asia", level: 90 },
];

export const CONTINENTAL_AUTO_MAP = 0;

// Mapa da sessao: o fixo da config ou, no automatico, o mais alto que o nivel
// do char libera (o char Lv.87 rolava no Chinese Lv.30 com a config antiga).
// Nivel nao lido: o primeiro mapa (liberado pra todo char que chega no Continental).
export function continentalMapFor(cfg: Pick<ContinentalConfig, "mapId">, level: number): number {
  if (cfg.mapId !== CONTINENTAL_AUTO_MAP) return cfg.mapId;
  const open = CONTINENTAL_MAPS.filter((m) => level >= m.level);
  return open.length ? open[open.length - 1].id : CONTINENTAL_MAPS[0].id;
}

export const BOX_LOCKED = 1;
export const BOX_UNLOCKING = 2;
export const BOX_READY = 3;
export const BOX_TAKE = 4;
export const BOX_DELETE = 5;

// Passada so de baus (sem dado): o jogo destrava um bau por vez (verde 1 h,
// laranja 8 h). Agenda a proxima pra logo depois do cronometro acabar, pra nao
// perder tempo de destrave entre as rodadas de dado.
export const CHEST_MIN_MS = 10 * 60 * 1000;
export const CHEST_MAX_MS = 2 * 3600 * 1000;

export function chestDelayMs(unlockLeftSec: number | null): number {
  if (unlockLeftSec === null || !Number.isFinite(unlockLeftSec)) return CHEST_MAX_MS;
  return Math.min(CHEST_MAX_MS, Math.max(CHEST_MIN_MS, unlockLeftSec * 1000 + 60000));
}

export const SLOT_COUNT = 3;
export const STATE_READY_TO_MOVE = 2;
export const STATE_EVENT = 8;

export const GRID_EMPTY = 1;
export const GRID_NORMAL = 2;
export const GRID_BOX = 3;
export const GRID_ADVENTURE = 4;
export const GRID_DICE = 5;

// Cor do bau (indice do sprite "chest_N" que o jogo usa). -1 = nao lida.
// >= roxo conta pro CHK_STOP_BOX_FULL.
export const TIER_UNKNOWN = -1;
export const TIER_GREEN = 0;
export const TIER_BLUE = 1;
export const TIER_PURPLE = 2;
export const TIER_ORANGE = 3;

export function tierFromSprite(name: unknown): number {
  const m = typeof name === "string" ? /^chest_(\d+)$/.exec(name) : null;
  return m ? Number(m[1]) : TIER_UNKNOWN;
}

export function boxColor(b: BoxSlot): string {
  const names = ["verde", "azul", "roxo", "laranja"];
  return names[b.tier] ?? `item ${b.itemId}`;
}

// Fora do estado "pronto pra rolar" por mais que isso conta como travado
// (rolar + andar + evento leva ~3 s ao vivo).
export const STUCK_MS = 90000;
// Luta da caveira alem disso conta como travado.
export const ARENA_MAX_MS = 360000;
// Depois de abrir o tabuleiro (ShowGameMap) o PlayerCoord do XSuperRiskMapMgr
// ainda traz a posicao do mapa anterior por 2 a 4 s (visto ao vivo trocando
// Desert -> Chinese). Os dois tem a mesma grade, entao a conferencia das casas
// nao pega: so mira depois disso.
export const AIM_SETTLE_MS = 5000;
// Dados do mapa nao chegaram depois disso com o tabuleiro na tela: reabre.
export const MAP_DATA_WAIT_MS = 8000;
const MAX_REOPENS = 3;

export interface BoxSlot {
  slot: number;
  itemId: number;
  state: number;
  tier: number; // TIER_*; o itemID sozinho nao diz a cor
}

// Casa a frente: tipo (RiskGridType), cor do bau (TIER_*) e se ja foi usada
// (boxState da casa: 1 disponivel, 2 usada, cinza na tela), lidos antes de rolar.
export interface AheadCell {
  type: number;
  tier: number;
  used?: boolean;
}

export interface ContinentalSnapshot {
  inWorld: boolean;
  dialog: boolean;
  board: boolean; // tabuleiro na tela
  selectMap: boolean; // selecao de mapa na tela
  itemAccess: boolean;
  sleeping: boolean;
  summary: boolean;
  mapId: number;
  level: number; // nivel do char (CONN; 0 = nao lido), pro mapa automatico
  maxDice: number; // -1 = nao veio (mapa nao carregado, ou 0 dados desde o boot)
  grids: number; // casas do tabuleiro recebidas (32 com o mapa carregado)
  dice: number;
  gameState: number;
  slots: BoxSlot[];
  // Classe do _DlgHandler do XLevelRewardView na tela ("" = fechado).
  reward: string;
  scene: number; // XScene get_SceneID (-1 = nao lido)
  // Casas 1..6 a frente do char (a ultima repete no END). undefined = nao lido.
  ahead?: AheadCell[];
  // Indice da casa do char no caminho do tabuleiro (lido com o tabuleiro parado
  // pra rolar). Serve pra medir onde o dado caiu.
  pathAt?: number;
}

// Mira medida em uso: casa antes da rolagem mirada e casa na proxima leitura
// parada. So conta 1 a 6 casas (casa especial que move o char ou troca de mapa
// fica de fora).
export interface AimResult {
  steps: number;
  band: number; // faixa mirada: 1 = 1-2, 2 = 3-4, 3 = 5-6
  hit: boolean;
}

export class AimTracker {
  hits = 0;
  total = 0;
  private pending?: { from: number; band: number };

  rolled(from: number | undefined, body: string, aimed: boolean): void {
    const n = Number(/RequestDicing 1 (\d+)/.exec(body)?.[1]);
    this.pending = aimed && from !== undefined && n > 0 ? { from, band: Math.ceil(n / 2) } : undefined;
  }

  observe(at: number | undefined): AimResult | undefined {
    if (!this.pending || at === undefined || at === this.pending.from) return undefined;
    const { from, band } = this.pending;
    this.pending = undefined;
    const steps = at - from;
    if (steps < 1 || steps > 6) return undefined;
    const hit = Math.ceil(steps / 2) === band;
    this.total++;
    if (hit) this.hits++;
    return { steps, band, hit };
  }
}

export function emptyContinentalSnapshot(): ContinentalSnapshot {
  return {
    inWorld: false, dialog: false, board: false, selectMap: false, itemAccess: false, sleeping: false, summary: false,
    mapId: -1, level: 0, maxDice: -1, grids: 0,
    dice: 0, gameState: -1, slots: [], reward: "", scene: -1,
  };
}

export type ContinentalAction = "wake" | "summary" | "closeaccess" | "open" | "setmap" | "show" | "reopen" | "take" | "unlock" | "discard"
  | "roll" | "close" | "arenareturn" | "arenaauto" | "arenaclose";

export type ContinentalStep =
  | { kind: "done"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "wait"; reason: string }
  | { kind: "act"; id: ContinentalAction; name: string; tag: string; body: string; cooldownMs?: number };

const DLG = "SuperRiskDlg";
const DOC = "XSuperRiskDocument";

function act(id: ContinentalAction, name: string, body: string, cooldownMs?: number): ContinentalStep {
  return { kind: "act", id, name, tag: "SKIL", body, cooldownMs };
}

function boxState(slot: number, state: number): string {
  return `callsi ${DOC} ChangeBoxState 2 ${slot} ${state}`;
}

// Cor nao lida nunca conta como ignorada (nao descarta o que nao conhece).
export function isIgnored(cfg: ContinentalConfig, b: BoxSlot): boolean {
  return (cfg.ignoreGreen && b.tier === TIER_GREEN) || (cfg.ignoreBlue && b.tier === TIER_BLUE);
}

// Ordem de destrave: cor nao ignorada antes da ignorada, e a melhor cor antes.
function unlockOrder(cfg: ContinentalConfig, a: BoxSlot, b: BoxSlot): number {
  const ia = isIgnored(cfg, a) ? 1 : 0;
  const ib = isIgnored(cfg, b) ? 1 : 0;
  return ia - ib || b.tier - a.tier || a.slot - b.slot;
}

export interface ContinentalProgress {
  rolls: number;
  taken: number;
  unlocked: number;
  discarded: number;
  reopens: number;
  closeSent: boolean; // mandou fechar o dialogo; conclui quando ele sumir
  doneReason: string;
  boardShownAt: number | null; // quando o tabuleiro apareceu (pra esperar os dados)
  boardMs: number;
  busySince: number | null; // desde quando o jogo esta fora do "pronto pra rolar"
  busyMs: number;
  arenas: number; // voltas da casa caveira (Return mandado)
  arenaSince: number | null; // desde quando esta na arena
  arenaMs: number;
  arenaAutoSent: boolean; // auto-fight ja ligado nesta arena
  showSentAt: number | null; // quando o ShowGameMap foi mandado
  sinceShowMs: number; // tempo desde o ShowGameMap (Infinity = nunca)
}

export function newContinentalProgress(): ContinentalProgress {
  return {
    rolls: 0, taken: 0, unlocked: 0, discarded: 0, reopens: 0, closeSent: false, doneReason: "",
    boardShownAt: null, boardMs: 0, busySince: null, busyMs: 0,
    arenas: 0, arenaSince: null, arenaMs: 0, arenaAutoSent: false,
    showSentAt: null, sinceShowMs: Infinity,
  };
}

// Cenas do mundo aberto comecam aqui (100001 Jangan); abaixo e instancia.
export const WORLD_SCENE_MIN = 100000;

// Rolando no ponto (atSpot): so comeca com HP de LEAVE_MIN_HP_PCT ou mais e, fora
// da arena, desiste com HP abaixo de LEAVE_DEFEND_HP_PCT (mesmas regras da saida
// segura do Treino). Null = pode seguir.
export function atSpotHpStop(hpPct: number | undefined, starting: boolean, inArenaNow: boolean): string | null {
  if (hpPct === undefined) return null;
  if (starting && hpPct < LEAVE_MIN_HP_PCT) return `HP em ${Math.round(hpPct)}% no ponto; rola quando passar de ${LEAVE_MIN_HP_PCT}%`;
  if (!starting && !inArenaNow && hpPct < LEAVE_DEFEND_HP_PCT) return `HP caiu a ${Math.round(hpPct)}% no ponto: tabuleiro fechado, Continental fica pra depois`;
  return null;
}

export function inInstanceScene(s: ContinentalSnapshot): boolean {
  return s.scene > 0 && s.scene < WORLD_SCENE_MIN;
}

// Arena da caveira: cena de instancia, ou (cena nao lida) fora do dialogo com o
// jogo no estado de evento; sem a tela de resultado.
export function inArena(s: ContinentalSnapshot): boolean {
  if (!s.inWorld || s.reward) return false;
  return inInstanceScene(s) || (!s.dialog && s.gameState === STATE_EVENT);
}

export function mapLoaded(s: ContinentalSnapshot): boolean {
  return s.maxDice >= 0 || s.grids > 0;
}

export function trackContinental(p: ContinentalProgress, s: ContinentalSnapshot | null, now: number): ContinentalProgress {
  if (!s) return p;
  const out = { ...p };
  if (s.board) {
    if (out.boardShownAt === null) out.boardShownAt = now;
    out.boardMs = now - out.boardShownAt;
  } else {
    out.boardShownAt = null;
    out.boardMs = 0;
  }
  const busy = s.board && mapLoaded(s) && s.gameState !== STATE_READY_TO_MOVE;
  if (busy) {
    if (out.busySince === null) out.busySince = now;
    out.busyMs = now - out.busySince;
  } else {
    out.busySince = null;
    out.busyMs = 0;
  }
  out.sinceShowMs = out.showSentAt === null ? Infinity : now - out.showSentAt;
  if (inArena(s)) {
    if (out.arenaSince === null) out.arenaSince = now;
    out.arenaMs = now - out.arenaSince;
  } else if (!s.reward) {
    out.arenaSince = null;
    out.arenaMs = 0;
    out.arenaAutoSent = false;
  }
  return out;
}

export function afterContinentalAction(p: ContinentalProgress, id: ContinentalAction): ContinentalProgress {
  if (id === "roll") return { ...p, rolls: p.rolls + 1 };
  if (id === "take") return { ...p, taken: p.taken + 1 };
  if (id === "unlock") return { ...p, unlocked: p.unlocked + 1 };
  if (id === "discard") return { ...p, discarded: p.discarded + 1 };
  if (id === "reopen") return { ...p, reopens: p.reopens + 1 };
  if (id === "arenareturn") return { ...p, arenas: p.arenas + 1 };
  if (id === "arenaauto") return { ...p, arenaAutoSent: true };
  return p;
}

// Acao nos baus, antes de rolar: pegar o pronto, destravar o proximo (um por
// vez, como o jogo mostra o cronometro so num) e abrir espaco descartando cor
// ignorada ainda trancada quando os 3 espacos estao cheios.
function boxStep(s: ContinentalSnapshot, cfg: ContinentalConfig): ContinentalStep | null {
  const ready = s.slots.find((b) => b.state === BOX_READY);
  if (ready) return act("take", `pegar o bau ${boxColor(ready)} (espaco ${ready.slot})`, boxState(ready.slot, BOX_TAKE));
  const locked = s.slots.filter((b) => b.state === BOX_LOCKED);
  if (occupied(s).length >= SLOT_COUNT && !cfg.onlyOpenChests) {
    const drop = locked.filter((b) => isIgnored(cfg, b)).sort((a, b) => a.tier - b.tier || a.slot - b.slot)[0];
    if (drop)
      return act("discard", `descartar o bau ${boxColor(drop)} (espaco ${drop.slot}, cor ignorada, espacos cheios)`,
        boxState(drop.slot, BOX_DELETE));
  }
  if (s.slots.some((b) => b.state === BOX_UNLOCKING)) return null;
  const next = [...locked].sort((a, b) => unlockOrder(cfg, a, b))[0];
  if (next) return act("unlock", `destravar o bau ${boxColor(next)} (espaco ${next.slot})`, boxState(next.slot, BOX_UNLOCKING));
  return null;
}

// Bau pego (4) ou descartado (5) pode ficar um instante no dicionario: nao ocupa.
export function occupied(s: ContinentalSnapshot): BoxSlot[] {
  return s.slots.filter((b) => b.state >= BOX_LOCKED && b.state <= BOX_READY);
}

export function allPurpleOrBetter(s: ContinentalSnapshot): boolean {
  const boxes = occupied(s);
  return boxes.length >= SLOT_COUNT && boxes.every((b) => b.tier >= TIER_PURPLE);
}

function finish(reason: string): ContinentalStep {
  return { kind: "done", reason };
}

// Ordem importa: sono, resumo e o popup do item ficam por cima e engolem o resto; trocar de mapa
// exige a selecao de mapa na tela; baus antes do dado (pegar libera espaco).
export function nextContinentalStep(
  s: ContinentalSnapshot | null,
  cfg: ContinentalConfig,
  p: ContinentalProgress,
): ContinentalStep {
  if (!s) return { kind: "wait", reason: "engine fora" };
  if (!s.inWorld) return { kind: "wait", reason: "fora de mundo" };
  if (s.sleeping) return act("wake", "sair do modo sono", "calls XSleepModeUI SetVisible 1 0");
  if (s.summary) return act("summary", "fechar o resumo", "callsn XBattleRewardDlg _OnClicked2 1");
  if (s.itemAccess) return act("closeaccess", "fechar o popup do item", "callsn ItemAccessDlg OnCloseClicked 1", 3000);
  // Fim da luta da caveira: so o Return (o "Try Again" e pago).
  if (s.reward.includes("SuperRisk"))
    return act("arenareturn", `voltar da caveira (${s.reward.includes("Fail") ? "perdeu" : "venceu"})`,
      "callp XLevelRewardView _DlgHandler OnReturnButtonClicked 1", 5000);
  if (inArena(s)) {
    if (p.arenaMs >= ARENA_MAX_MS) return { kind: "fail", reason: "travado na luta da caveira" };
    // Dialogo aberto por cima da arena: fecha antes (com ele o bot tentava rolar).
    if (s.dialog) return act("arenaclose", "fechar o dialogo (esta na arena da caveira)", `calls ${DLG} SetVisible 2 0 1`, 3000);
    if (!p.arenaAutoSent)
      return { kind: "act", id: "arenaauto", name: "ligar o auto-fight na caveira", tag: "SKIL", body: JSON.stringify({ on: 1 }) };
    return { kind: "wait", reason: "luta na casa caveira" };
  }
  if (p.closeSent) return s.dialog ? act("close", "fechar o dialogo", `calls ${DLG} SetVisible 2 0 1`, 3000) : finish(p.doneReason);
  // Logo depois de fechar outra janela o SetVisible pode nao pegar: repete.
  if (!s.dialog) return act("open", "abrir o dialogo", `calls ${DLG} SetVisible 2 1 1`, 3000);
  const map = continentalMapFor(cfg, s.level);
  if (s.selectMap) {
    if (s.mapId !== map)
      return act("setmap", `escolher o mapa ${mapName(map)}`, `callsi ${DOC} set_CurrentMapID 1 ${map} 0`, 3000);
    return act("show", `abrir o tabuleiro ${mapName(map)}`, `calls ${DLG} ShowGameMap 0`, 4000);
  }
  if (!s.board) return { kind: "wait", reason: "abrindo o dialogo" };
  if (!mapLoaded(s)) {
    if (p.boardMs < MAP_DATA_WAIT_MS) return { kind: "wait", reason: "esperando os dados do mapa" };
    if (p.reopens < MAX_REOPENS) return act("reopen", "reabrir o dialogo (dados do mapa nao chegaram)", `calls ${DLG} SetVisible 2 0 1`);
    return { kind: "fail", reason: "dados do mapa nao chegaram" };
  }
  // Tabuleiro de outro mapa: so a selecao troca, entao fecha e reabre.
  if (s.mapId !== map) {
    if (p.reopens < MAX_REOPENS)
      return act("reopen", `reabrir pra trocar do mapa ${mapName(s.mapId)} pro ${mapName(map)}`, `calls ${DLG} SetVisible 2 0 1`);
    return { kind: "fail", reason: `nao trocou pro mapa ${mapName(map)}` };
  }
  if (s.gameState !== STATE_READY_TO_MOVE) {
    if (p.busyMs >= STUCK_MS) return { kind: "fail", reason: `travado no estado ${s.gameState} do tabuleiro` };
    return { kind: "wait", reason: `tabuleiro ocupado (estado ${s.gameState})` };
  }
  const box = boxStep(s, cfg);
  if (box) return box;
  if (cfg.onlyOpenChests) return act("close", "fechar (so abrir baus)", `calls ${DLG} SetVisible 2 0 1`, 3000);
  if (cfg.stopWhenAllPurple && allPurpleOrBetter(s))
    return act("close", "fechar (3 baus roxos ou melhores)", `calls ${DLG} SetVisible 2 0 1`, 3000);
  if (s.dice > 0) {
    if (p.sinceShowMs < AIM_SETTLE_MS) return { kind: "wait", reason: "esperando o tabuleiro assentar pra mirar" };
    const aim = chooseAim(s.ahead, cfg, occupied(s).length >= SLOT_COUNT);
    const count = s.maxDice >= 0 ? `${s.dice}/${s.maxDice}` : `${s.dice}`;
    const why = aim ? ` mirando ${2 * aim.band - 1}-${2 * aim.band}${aim.target ? ` (${aim.target})` : ""}` : "";
    return act("roll", `rolar o dado (${count})${why}`, `callsi ${DOC} RequestDicing 1 ${aim ? aim.n : 1} 0`, 4000);
  }
  return act("close", "fechar (sem dados)", `calls ${DLG} SetVisible 2 0 1`, 3000);
}

// Probabilidade de cada face (1..6) pedindo a faixa b (1, 2 ou 3), pelo que
// foi medido: ~70% dentro da faixa (dividido igual) e o resto nas vizinhas.
export function faceProbs(band: number): number[] {
  const p = [0, 0, 0, 0, 0, 0];
  const lo = 2 * band - 2; // indice da face mais baixa da faixa
  p[lo] = 0.35;
  p[lo + 1] = 0.35;
  if (band === 1) { p[2] = 0.2; p[3] = 0.1; }
  else if (band === 3) { p[3] = 0.2; p[2] = 0.1; }
  else { p[1] = 0.15; p[4] = 0.15; }
  return p;
}

// Valor de cair numa casa. Cor ignorada vale pouco (nao zero: ainda e bau);
// com os 3 espacos cheios o bau vale metade (cai sem lugar).
export function cellValue(c: AheadCell, cfg: ContinentalConfig, slotsFull: boolean): number {
  if (c.used) return 0;
  if (c.type === GRID_ADVENTURE) return -3;
  if (c.type === GRID_DICE) return 2.5;
  if (c.type === GRID_NORMAL) return 1;
  if (c.type === GRID_BOX) {
    const base = [1, 2, 3, 4][c.tier] ?? 1;
    const ignored = (cfg.ignoreGreen && c.tier === TIER_GREEN) || (cfg.ignoreBlue && c.tier === TIER_BLUE);
    const v = ignored ? 0.3 : base;
    return slotsFull ? v / 2 : v;
  }
  return 0;
}

const CELL_NAMES: Record<number, string> = { [GRID_NORMAL]: "?", [GRID_DICE]: "dado extra", [GRID_ADVENTURE]: "caveira" };
const TIER_NAMES = ["verde", "azul", "roxo", "laranja"];

export interface Aim {
  band: number; // 1..3
  n: number; // argumento do RequestDicing
  ev: number;
  target: string; // melhor casa da faixa, so pro log
}

// Faixa de maior valor esperado. Sem leitura das casas: undefined (rola com 1,
// como antes). Empate fica com a faixa do meio, a de mais acerto (86% com n=3).
export function chooseAim(ahead: AheadCell[] | undefined, cfg: ContinentalConfig, slotsFull: boolean): Aim | undefined {
  if (!ahead || ahead.length < 6) return undefined;
  const values = ahead.slice(0, 6).map((c) => cellValue(c, cfg, slotsFull));
  let best: Aim | undefined;
  for (const band of [2, 1, 3]) {
    const probs = faceProbs(band);
    const ev = probs.reduce((acc, pr, i) => acc + pr * values[i], 0);
    if (!best || ev > best.ev + 1e-9) {
      const lo = 2 * band - 2;
      const top = values[lo + 1] > values[lo] ? lo + 1 : lo;
      const c = ahead[top];
      const what = c.used ? "" : c.type === GRID_BOX ? `bau ${TIER_NAMES[c.tier] ?? ""}`.trim() : CELL_NAMES[c.type];
      best = { band, n: 2 * band - 1, ev, target: what ? `${what} a ${top + 1}` : "" };
    }
  }
  return best;
}

// Caminho do tabuleiro (so a borda), horario a partir de Start (0,0); a ultima
// casa e o END (0,1).
export function boardPath(w: number, h: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let x = 0; x < w; x++) out.push({ x, y: 0 });
  for (let y = 1; y < h; y++) out.push({ x: w - 1, y });
  for (let x = w - 2; x >= 0; x--) out.push({ x, y: h - 1 });
  for (let y = h - 2; y >= 1; y--) out.push({ x: 0, y });
  return out;
}

// Indice da casa (x, y) no CurrentDynamicInfo: so a borda, por linha.
export function gridListIndex(x: number, y: number, w: number, h: number): number {
  if (y === 0) return x;
  if (y === h - 1) return w + 2 * (h - 2) + x;
  return w + 2 * (y - 1) + (x === 0 ? 0 : 1);
}

export function mapName(id: number): string {
  return CONTINENTAL_MAPS.find((m) => m.id === id)?.name ?? `mapa ${id}`;
}

// Motivo do fim conforme o fechar que foi mandado.
function closeReason(step: ContinentalStep): string {
  if (step.kind !== "act") return "";
  if (step.name.includes("so abrir")) return "baus tratados (so abrir baus)";
  if (step.name.includes("roxos")) return "3 baus roxos ou melhores";
  if (step.name.includes("sem dados")) return "sem dados";
  return "ciclo concluido";
}

// Junta progresso e cooldown: usado pelo runner do main e pelo goal do
// controlador. `send` diz se o comando do passo deve sair agora.
export class ContinentalDriver {
  progress = newContinentalProgress();
  private lastBody = "";
  private lastAt = 0;

  constructor(public cfg: ContinentalConfig = DEFAULT_CONTINENTAL_CONFIG) {}

  next(s: ContinentalSnapshot | null, now: number): { step: ContinentalStep; send: boolean } {
    this.progress = trackContinental(this.progress, s, now);
    const step = nextContinentalStep(s, this.cfg, this.progress);
    if (step.kind !== "act") return { step, send: false };
    const cooldown = step.cooldownMs ?? SAME_ACTION_COOLDOWN_MS;
    if (step.body === this.lastBody && now - this.lastAt < cooldown) return { step, send: false };
    this.lastBody = step.body;
    this.lastAt = now;
    this.progress = afterContinentalAction(this.progress, step.id);
    if (step.id === "show") this.progress = { ...this.progress, showSentAt: now };
    if (step.id === "close" && !this.progress.closeSent)
      this.progress = { ...this.progress, closeSent: true, doneReason: closeReason(step) };
    return { step, send: true };
  }
}

// Le o estado pelo engine. Null = engine fora. Com o dialogo fechado so le o
// jogador e o popup (o resto nao atualiza fora da tela).
export async function readContinentalSnapshot(q: EngineQuery): Promise<ContinentalSnapshot | null> {
  const s = emptyContinentalSnapshot();
  const conn = await q("CONN", "");
  const player = conn.player as Record<string, unknown> | undefined;
  if (!player) return null;
  s.inWorld = player.ok === true;
  if (!s.inWorld) return s;
  if (typeof player.level === "number") s.level = player.level;
  const int = async (body: string, dflt: number) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : dflt;
  };
  s.scene = await int("XScene get_SceneID", -1);
  const bool = async (tag: string, body: string) => (await q(tag, body)).bool === true;
  s.sleeping = await bool("SKIL", "getv XSleepModeUI IsVisible");
  s.summary = await bool("SKIL", "getv XBattleRewardDlg IsVisible");
  s.itemAccess = await bool("SKIL", "getv ItemAccessDlg IsVisible");
  s.dialog = await bool("SKIL", `getv ${DLG} IsVisible`);
  if (!s.dialog || inInstanceScene(s)) {
    // Arena da caveira: o documento continua no estado de evento.
    s.gameState = await int(`${DOC} GameState`, -1);
    if (await bool("SKIL", "getv XLevelRewardView IsVisible")) {
      const r = await q("GETP", "XLevelRewardView _DlgHandler ToString");
      s.reward = typeof r.str === "string" ? r.str : "";
    }
    return s;
  }
  s.board = await bool("GETP", `${DLG} _GameHandler IsVisible`);
  s.selectMap = await bool("GETP", `${DLG} _SelectMapHandler IsVisible`);
  s.mapId = await int(`${DOC} m_curMapID`, -1);
  if (!s.board) return s;
  s.maxDice = await int(`${DOC} m_maxLeftTimes`, -1);
  s.grids = await int(`${DOC} CurrentDynamicInfo get_Count`, 0);
  s.dice = await int(`${DOC} m_leftDiceTime`, 0);
  s.gameState = await int(`${DOC} GameState`, -1);
  const keys = await q("KEYS", `${DOC} SlotBoxInfo`);
  for (const k of Array.isArray(keys.keys) ? (keys.keys as number[]) : []) {
    const itemId = await int(`${DOC} SlotBoxInfo get_Item:${k} itemID`, -1);
    const state = await int(`${DOC} SlotBoxInfo get_Item:${k} state`, -1);
    const spr = await q("GETP", `${DLG} _GameHandler GetBoxSprNameByState:${itemId}`);
    s.slots.push({ slot: k, itemId, state, tier: spr.ok === true ? tierFromSprite(spr.str) : TIER_UNKNOWN });
  }
  if (s.gameState === STATE_READY_TO_MOVE) {
    s.pathAt = await readPathAt(q);
    if (s.dice > 0) s.ahead = await readAhead(q);
  }
  return s;
}

// Casa do char no caminho do tabuleiro (undefined = nao deu pra ler).
export async function readPathAt(q: EngineQuery): Promise<number | undefined> {
  const num = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const MAP = "XSuperRiskMapMgr CurrentMap";
  const w = await num(`${MAP} StaticInfo get_Width`);
  const h = await num(`${MAP} StaticInfo get_Height`);
  const px = await num(`${MAP} PlayerCoord`);
  const py = await num(`${MAP} PlayerCoord+4`);
  if (!w || !h || w < 2 || h < 2 || px === undefined || py === undefined) return undefined;
  const at = boardPath(w, h).findIndex((c) => c.x === px && c.y === py);
  return at < 0 ? undefined : at;
}

// Le as 6 casas a frente. Qualquer leitura que nao bate (tamanho, posicao fora
// do caminho, casa com outra coordenada) devolve undefined e o bot rola sem mirar.
export async function readAhead(q: EngineQuery): Promise<AheadCell[] | undefined> {
  const num = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const MAP = "XSuperRiskMapMgr CurrentMap";
  const w = await num(`${MAP} StaticInfo get_Width`);
  const h = await num(`${MAP} StaticInfo get_Height`);
  const px = await num(`${MAP} PlayerCoord`);
  const py = await num(`${MAP} PlayerCoord+4`);
  if (!w || !h || w < 2 || h < 2 || px === undefined || py === undefined) return undefined;
  const path = boardPath(w, h);
  const at = path.findIndex((c) => c.x === px && c.y === py);
  if (at < 0) return undefined;
  const out: AheadCell[] = [];
  for (let d = 1; d <= 6; d++) {
    const c = path[Math.min(at + d, path.length - 1)];
    const base = `${DOC} CurrentDynamicInfo get_Item:${gridListIndex(c.x, c.y, w, h)}`;
    if ((await num(`${base} get_x`)) !== c.x || (await num(`${base} get_y`)) !== c.y) return undefined;
    const type = (await num(`${base} get_gridType`)) ?? GRID_EMPTY;
    const used = (await num(`${base} get_boxState`)) === 2;
    let tier = TIER_UNKNOWN;
    if (type === GRID_BOX && !used) {
      const item = await num(`${base} _rewardItem get_itemID`);
      if (item !== undefined) {
        const spr = await q("GETP", `${DLG} _GameHandler GetBoxSprNameByState:${item}`);
        tier = tierFromSprite(spr.str);
      }
    }
    out.push({ type, tier, used });
  }
  return out;
}

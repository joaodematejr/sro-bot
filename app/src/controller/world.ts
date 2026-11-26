// Sair de cena, relogio do servidor e canal na mao (aba Mapa). Tudo so pelo
// botao do painel; o bot nao chama nada daqui sozinho.
//
//   Sair de cena -> XScene ReqLeaveScene (o botao de sair da cena do jogo; o mesmo
//                   que o Qigong usa pra sair do Guild Hall). So em instancia: cena
//                   abaixo de 100000 (o mundo aberto comeca em 100001, Jangan) ou a
//                   torre (cena 102000 + andar, XScene _scene_type 16).
//   Relogio      -> hora do aparelho no fuso do servidor (XServerTimeMgr
//                   get_ServerTimeZone, 8 no servidor do usuario). O dia do jogo vira
//                   as 05:00 do servidor (daily.ts gameDay, XWelfareDocument).
//   Canal        -> ChannelDocument: lista e lotacao pelo readChannel do Treino; troca
//                   pelo ReqChangeLine, que o servidor ignora em combate (ate ~6 s depois
//                   do ultimo golpe, XLevelStatistics get_IsInFightingState).

import { WORLD_SCENE_MIN } from "./continental";
import { LEAVE_HALL_BODY } from "./qigong";
import { SERVER_TZ_DEFAULT } from "./sekhmet";
import { type EngineQuery, TOWER_SCENE_TYPE } from "./tower";
import { channelBody, readChannel } from "./train";

export const LEAVE_SCENE_BODY = LEAVE_HALL_BODY;
export { channelBody };

// Hora em que o dia do jogo vira, no relogio do servidor.
export const DAY_RESET_HOUR = 5;
// Espera do char voltar ao mundo depois do pedido (troca de canal e saida de cena).
export const WORLD_CHANGE_MAX_MS = 30000;

// KKSG.SceneLineState.
const LINE_STATE_TEXT: Record<number, string> = { 1: "cheio", 2: "lotado", 3: "bom" };
const LINE_FULL = 1;

export interface ChannelRow {
  channel: number; // numero que o jogo mostra (1, 2, ...)
  line: number; // id da linha neste mapa (Jangan 101..104)
  state?: number;
  activity: boolean; // Activity Channel (metade dos monstros)
  current: boolean;
}

export interface WorldSnapshot {
  scene: number;
  sceneType: number;
  tz: number; // fuso do servidor em horas
  channel?: number;
  channels: ChannelRow[];
}

export function lineStateText(state: number | undefined): string {
  return state === undefined ? "" : (LINE_STATE_TEXT[state] ?? "");
}

// Linhas do readChannel em ordem de canal.
export function channelRows(r: { channel?: number; lines: Record<number, number>; info: Record<number, { state?: number; activity: boolean }> }): ChannelRow[] {
  return Object.keys(r.lines)
    .map(Number)
    .filter((c) => Number.isInteger(c) && c > 0)
    .sort((a, b) => a - b)
    .map((c) => ({
      channel: c,
      line: r.lines[c],
      state: r.info[c]?.state,
      activity: r.info[c]?.activity === true,
      current: c === r.channel,
    }));
}

// Relogio do servidor: "HH:MM:SS" e o fuso ("UTC+8").
export function serverClock(nowMs: number, tzHours: number): { time: string; zone: string } {
  const d = new Date(nowMs + tzHours * 3600000);
  const p = (n: number) => String(n).padStart(2, "0");
  const sign = tzHours < 0 ? "-" : "+";
  return { time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`, zone: `UTC${sign}${Math.abs(tzHours)}` };
}

// Quanto falta pra virada do dia do jogo (05:00 no servidor), em ms.
export function msToDayReset(nowMs: number, tzHours: number): number {
  const day = 86400000;
  const local = nowMs + tzHours * 3600000;
  const into = (((local - DAY_RESET_HOUR * 3600000) % day) + day) % day;
  return day - into;
}

export function durationText(ms: number): string {
  const min = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}min` : `${m}min`;
}

// Cena de instancia (Guild Hall, arena, dungeon) ou a torre: da pra sair.
export function canLeaveScene(scene: number | undefined, sceneType?: number): boolean {
  if (scene === undefined || !(scene > 0)) return false;
  return scene < WORLD_SCENE_MIN || sceneType === TOWER_SCENE_TYPE;
}

export interface WorldActionState {
  inWorld: boolean;
  dead: boolean;
  inCombat: boolean; // CONN inCombat ou XLevelStatistics get_IsInFightingState
  busy?: string; // atividade do bot rodando (nome), que mexe em cena e canal
}

// Null = pode sair; senao o motivo.
export function leaveSceneCheck(scene: number | undefined, sceneType: number | undefined, s: WorldActionState): string | null {
  if (!s.inWorld) return "jogo nao conectado";
  if (s.busy) return `${s.busy} rodando: pare antes de sair da cena`;
  if (!canLeaveScene(scene, sceneType)) return "o char esta no mundo aberto: nao ha cena pra sair";
  if (s.dead) return "char morto: renasca antes de sair";
  return null;
}

// Troca de canal na mao: confere tudo antes de mandar. Ok traz o id da linha.
export function channelChangeCheck(rows: ChannelRow[], target: number, s: WorldActionState): { ok: true; line: number } | { ok: false; erro: string } {
  if (!s.inWorld) return { ok: false, erro: "jogo nao conectado" };
  if (s.busy) return { ok: false, erro: `${s.busy} rodando: ele escolhe o canal; pare antes de trocar na mao` };
  const row = rows.find((r) => r.channel === target);
  if (!row) return { ok: false, erro: `canal ${target} nao existe neste mapa` };
  if (row.current) return { ok: false, erro: `o char ja esta no canal ${target}` };
  if (row.state === LINE_FULL) return { ok: false, erro: `canal ${target} cheio` };
  if (s.dead) return { ok: false, erro: "char morto: renasca antes de trocar de canal" };
  if (s.inCombat) return { ok: false, erro: "em combate: o jogo ignora a troca. Desligue a caca e espere uns 6 s" };
  return { ok: true, line: row.line };
}

const int = (r: Record<string, unknown>): number | undefined => (r.ok === true && typeof r.int === "number" ? r.int : undefined);

export async function readWorld(q: EngineQuery): Promise<WorldSnapshot> {
  const scene = int(await q("GETP", "XScene get_SceneID")) ?? -1;
  const sceneType = int(await q("GETP", "XScene _scene_type")) ?? -1;
  const tz = int(await q("GETP", "XServerTimeMgr get_ServerTimeZone")) ?? SERVER_TZ_DEFAULT;
  // Instancia e torre nao tem canal (a lista fica a do ultimo mapa aberto).
  if (scene < WORLD_SCENE_MIN || canLeaveScene(scene, sceneType)) return { scene, sceneType, tz, channels: [] };
  const r = await readChannel(q);
  return { scene, sceneType, tz, channel: r.channel, channels: channelRows(r) };
}

// Em combate pelo jogo: o mesmo teste do Treino antes de trocar de canal.
export async function readFighting(q: EngineQuery): Promise<boolean> {
  return (await q("GETP", "XLevelStatistics get_IsInFightingState")).bool !== false;
}

// Mapa ao vivo (aba Mapa): o char no centro e o que esta em volta. Logica pura e
// as leituras; o desenho fica no renderer.
//
// Fonte principal: o comando ENTS do engine (uma consulta so): jogador, alvo do
// auto-play (XAIComponent._target), entidades ate o raio [tipo, id, x, z, nivel,
// morto, hp, maxHp, nome] e itens no chao (XLevelDoodadMgr._doodads). Engine sem
// ENTS (responde o estado do jogador pra tag desconhecida): leitura reserva pelo
// GETP, mais lenta, sem HP e sem itens no chao.

import type { EngineQuery } from "./tower";

// XEntity._eEntity_Type (EnitityType), lido no XMainClient.dll.
export const ENTITY = {
  Role: 0x2,
  Player: 0x4, // o proprio char
  Enemy: 0x8,
  Boss: 0x20,
  Puppet: 0x40,
  Elite: 0x80,
  Npc: 0x100,
  Affiliate: 0x2000,
  Mount: 0x4000,
  Spirit: 0x10000,
  Scavenger: 0x20000,
} as const;

// Pets vem marcados como inimigo: lido ao vivo em Jangan, 2026-11-11, pet de combate
// (Elite Penguin, Gray Wolf, o Night Fang do proprio char) = 0x10019 (Spirit + Enemy
// + Opposer) e pet de coleta (Cat, Brownie) = 0x20019 (Scavenger + Enemy + Opposer).
// Jogador = 0x3, o proprio char = 0x7.
const PET_BITS = ENTITY.Spirit | ENTITY.Scavenger | ENTITY.Puppet | ENTITY.Affiliate | ENTITY.Mount;

export type MapKind = "boss" | "elite" | "monster" | "party" | "player" | "pet" | "npc" | "other";

export interface MapEntity {
  kind: MapKind;
  id: number; // 32 bits de baixo
  x: number;
  z: number;
  level: number;
  dead: boolean;
  hp: number; // 0 = nao lido
  maxHp: number;
  name: string;
}

export interface MapDrop {
  x: number;
  z: number;
  item: number;
  count: number;
}

export interface MapPoint {
  x: number;
  z: number;
}

export interface MapSnapshot {
  me: { x: number; z: number; id: number };
  target: number; // id do alvo do auto-play (0 = sem alvo)
  ents: MapEntity[];
  drops: MapDrop[];
  path: MapPoint[]; // caminho que o char esta andando (vazio parado; so com o ENTS)
  source: "ents" | "getp";
}

// Raio lido em volta do char (o ENTS limita a 150 entidades e 80 itens).
export const MAP_RADIUS_M = 120;

// Monstro mais forte que o jogo nao marca com o bit de elite: "Niya Hunter -
// Champion" veio tipo 0x19 com o dobro do HP (ponto 2, 2026-11-12).
const STRONG_NAME = /\b(Champion|Giant|Elite)\b/i;

// Pet ou montaria (antes de tudo: pet tambem tem o bit de inimigo), monstro (chefe,
// elite ou comum), NPC, jogador da party, outro jogador ou outro.
export function classifyEntity(type: number, id: number, team: Set<number>, name = ""): MapKind {
  if (type & PET_BITS) return "pet";
  if (type & ENTITY.Enemy) {
    if (type & ENTITY.Boss) return "boss";
    if (type & ENTITY.Elite || STRONG_NAME.test(name)) return "elite";
    return "monster";
  }
  if (type & ENTITY.Npc) return "npc";
  if (type & ENTITY.Role) return team.has(id) ? "party" : "player";
  return "other";
}

// Resposta do ENTS. null = engine sem ENTS (devolveu o estado do jogador).
export function parseEnts(r: Record<string, unknown>, team: Set<number>): MapSnapshot | null {
  const me = r.me as { x?: number; z?: number; id?: number; target?: number } | undefined;
  if (r.ok !== true || !me || !Array.isArray(r.ents)) return null;
  const ents: MapEntity[] = [];
  for (const e of r.ents as unknown[]) {
    if (!Array.isArray(e) || e.length < 9) continue;
    const [type, id, x, z, level, dead, hp, maxHp, name] = e as [number, number, number, number, number, number, number, number, string];
    if (typeof x !== "number" || typeof z !== "number") continue;
    ents.push({ kind: classifyEntity(type, id, team, String(name ?? "")), id, x, z, level, dead: dead === 1, hp, maxHp, name: String(name ?? "") });
  }
  const drops: MapDrop[] = [];
  for (const d of Array.isArray(r.drops) ? (r.drops as unknown[]) : []) {
    if (Array.isArray(d) && d.length >= 4) drops.push({ x: d[0] as number, z: d[1] as number, item: d[2] as number, count: d[3] as number });
  }
  const path: MapPoint[] = [];
  for (const p of Array.isArray(r.path) ? (r.path as unknown[]) : []) {
    if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") path.push({ x: p[0], z: p[1] });
  }
  return { me: { x: me.x ?? 0, z: me.z ?? 0, id: me.id ?? 0 }, target: me.target ?? 0, ents, drops, path, source: "ents" };
}

// O que falta andar: o jogo guarda o caminho inteiro (o primeiro ponto e onde o
// char comecou). Acha o trecho mais perto do char e devolve os pontos depois dele,
// com o total em metros.
export function pathAhead(me: MapPoint, pts: MapPoint[]): { pts: MapPoint[]; meters: number } {
  if (pts.length < 2) return { pts: [], meters: 0 };
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const k = len2 ? Math.max(0, Math.min(1, ((me.x - a.x) * dx + (me.z - a.z) * dz) / len2)) : 0;
    const d = Math.hypot(a.x + k * dx - me.x, a.z + k * dz - me.z);
    if (d < bestD) { bestD = d; best = i; }
  }
  const ahead = pts.slice(best + 1);
  let meters = 0;
  let prev = me;
  for (const p of ahead) { meters += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
  return { pts: ahead, meters };
}

// Coordenada do jogo (x, z) na tela, com o char no centro e o norte (z maior) pra
// cima. pxPerM = zoom.
export function worldToScreen(x: number, z: number, me: { x: number; z: number }, cx: number, cy: number, pxPerM: number): [number, number] {
  return [cx + (x - me.x) * pxPerM, cy - (z - me.z) * pxPerM];
}

// Ids (32 bits de baixo) dos membros do time, pra marcar a party.
export async function readTeamIds(q: EngineQuery): Promise<Set<number>> {
  const r = await q("GETP", "XTeamDocument get_MyTeam members get_Count");
  const n = r.ok === true && typeof r.int === "number" ? Math.min(r.int, 10) : 0;
  const out = new Set<number>();
  for (let i = 0; i < n; i++) {
    const id = await q("GETP", `XTeamDocument get_MyTeam members get_Item:${i} entityID`);
    if (id.ok === true && typeof id.int === "number") out.add(id.int >>> 0);
  }
  return out;
}

// Float guardado como bits no int do GETP.
function bitsToFloat(i: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setInt32(0, i, true);
  return b.getFloat32(0, true);
}

// Nome que veio como chave de traducao (NPC: "XNpcList_NPCName_200" = "Jowi").
export const isLocalizationKey = (s: string) => /^[A-Za-z]+_[A-Za-z]+_\d+$/.test(s);

// Leitura reserva pelo GETP (engine sem ENTS): ate `max` entidades olhadas, so as
// do raio leem o resto (~5 consultas cada); sem HP e sem itens no chao. Nome so de
// quem nao e monstro comum.
export async function readMapGetp(q: EngineQuery, team: Set<number>, max = 80): Promise<MapSnapshot | null> {
  const p = (await q("CONN", "")).player as { ok?: boolean; corrected?: number[] } | undefined;
  if (p?.ok !== true || !Array.isArray(p.corrected)) return null;
  const num = async (body: string) => {
    const r = await q("GETP", body);
    return r.ok === true && typeof r.int === "number" ? r.int : undefined;
  };
  const me = { x: p.corrected[0], z: p.corrected[2], id: ((await num("XEntityMgr get_Player get_ID")) ?? 0) >>> 0 };
  const target = ((await num("XEntityMgr get_Player _ai get_Target get_ID")) ?? 0) >>> 0;
  const n = Math.min((await num("XEntityMgr GetAll get_Count")) ?? 0, max);
  const ents: MapEntity[] = [];
  for (let i = 0; i < n; i++) {
    const b = `XEntityMgr GetAll get_Item:${i}`;
    const type = (await num(`${b} _eEntity_Type`)) ?? 0;
    if (type & ENTITY.Player) continue;
    const ex = await num(`${b} _correctedPosition`);
    const ez = await num(`${b} _correctedPosition+8`);
    if (ex === undefined || ez === undefined) continue;
    // Fora do raio nao gasta mais leitura (em 2026-11-11, em Jangan, 28 de 49
    // entidades eram NPCs a 3 km e a passada levou 13 s).
    if (Math.hypot(bitsToFloat(ex) - me.x, bitsToFloat(ez) - me.z) > MAP_RADIUS_M) continue;
    const id = ((await num(`${b} get_ID`)) ?? 0) >>> 0;
    const kind = classifyEntity(type, id, team);
    const dead = (await q("GETP", `${b} get_IsDead`)).bool === true;
    const level = kind === "pet" || kind === "other" ? 0 : (await num(`${b} get_Attributes get_Level`)) ?? 0;
    const name = kind === "monster" ? "" : String((await q("GETP", `${b} get_Name`)).str ?? "");
    ents.push({ kind, id, x: bitsToFloat(ex), z: bitsToFloat(ez), level, dead, hp: 0, maxHp: 0, name });
  }
  return { me, target, ents, drops: [], path: [], source: "getp" };
}

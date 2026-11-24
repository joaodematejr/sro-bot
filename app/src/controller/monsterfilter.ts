// Filtro de monstros do Treino: o auto-play do jogo escolhe o alvo sozinho (a
// busca fica no XMainClient interpretado, sem como filtrar la dentro). O bot olha
// o alvo atual (ENTS) e, se for um monstro ignorado, manda a IA pro monstro
// permitido mais perto pelo TARG (XAIComponent.SetTarget). Provado ao vivo em
// 2026-11-24: a troca leva < 1 s, a caca continua ligada e, morto o novo alvo, a
// IA volta a escolher sozinha. O alvo gruda ate o monstro morrer, entao basta
// trocar uma vez por monstro.
//
// Ignora por especie (XAttributes._type_id, igual pra todo Niya Mage) ou por
// categoria: normal, champion (Champion, Giant e Elite pelo nome ou pelo bit) e
// boss (bit Boss), a mesma classificacao do mapa.

import type { MapEntity, MapSnapshot } from "./map";

export type MonsterCategory = "monster" | "elite" | "boss";

export const CATEGORY_LABEL: Record<MonsterCategory, string> = {
  monster: "normal",
  elite: "champion",
  boss: "boss",
};

export interface IgnoredSpecies {
  id: number; // XAttributes._type_id
  name: string; // so pra mostrar na tela e no log
}

export interface MonsterFilterConfig {
  species?: IgnoredSpecies[];
  categories?: MonsterCategory[];
}

// Distancia maxima do char pro monstro novo. Mais longe que isso o char sairia
// do ponto atras de um alvo; sem nenhum ate aqui, luta com o ignorado mesmo.
export const SWAP_MAX_M = 50;
// O mesmo monstro ignorado voltando a ser alvo INSIST_MAX vezes em INSIST_WINDOW_MS
// (ele esta batendo no char e a lista de odio puxa de volta): desiste dele por
// GIVE_UP_MS e deixa a IA matar. Trocar sem parar deixaria o char apanhando.
export const INSIST_MAX = 2;
export const INSIST_WINDOW_MS = 30000;
export const GIVE_UP_MS = 60000;

export interface FilterMemory {
  tries: Record<number, number[]>; // id do monstro -> quando a troca saiu dele
  giveUp: Record<number, number>; // id -> ate quando deixa lutar
}

export function newFilterMemory(): FilterMemory {
  return { tries: {}, giveUp: {} };
}

export type FilterStep =
  | { kind: "none" }
  | { kind: "swap"; from: MapEntity; to: MapEntity; dist: number }
  | { kind: "keep"; target: MapEntity; why: "sem-permitido" | "insiste" };

const MONSTER_KINDS = new Set<string>(["monster", "elite", "boss"]);

export function filterActive(cfg: MonsterFilterConfig | undefined): boolean {
  return !!cfg && ((cfg.species?.length ?? 0) > 0 || (cfg.categories?.length ?? 0) > 0);
}

export function isMonster(e: MapEntity): boolean {
  return MONSTER_KINDS.has(e.kind);
}

// Monstro que o filtro manda largar. Jogador, pet e NPC nunca. Especie so pega
// com o engine que manda o _type_id (sem ele so a categoria vale).
export function isIgnored(e: MapEntity, cfg: MonsterFilterConfig | undefined): boolean {
  if (!cfg || !isMonster(e)) return false;
  if (cfg.categories?.includes(e.kind as MonsterCategory)) return true;
  return e.typeId !== undefined && !!cfg.species?.some((s) => s.id === e.typeId);
}

// Vivo de verdade: o corpo fica uns segundos no chao com HP 0.
function alive(e: MapEntity): boolean {
  return !e.dead && !(e.maxHp > 0 && e.hp <= 0);
}

export function monsterFilterStep(
  snap: MapSnapshot,
  cfg: MonsterFilterConfig | undefined,
  mem: FilterMemory,
  now: number,
  maxM = SWAP_MAX_M,
): FilterStep {
  if (!filterActive(cfg) || !snap.target) return { kind: "none" };
  const t = snap.ents.find((e) => e.id === snap.target);
  if (!t || !alive(t) || !isIgnored(t, cfg)) return { kind: "none" };
  if ((mem.giveUp[t.id] ?? 0) > now) return { kind: "keep", target: t, why: "insiste" };
  let best: MapEntity | undefined;
  let bestD = Infinity;
  for (const e of snap.ents) {
    if (e.id === t.id || !isMonster(e) || !alive(e) || isIgnored(e, cfg)) continue;
    const d = Math.hypot(e.x - snap.me.x, e.z - snap.me.z);
    if (d <= maxM && d < bestD) { best = e; bestD = d; }
  }
  if (!best) return { kind: "keep", target: t, why: "sem-permitido" };
  return { kind: "swap", from: t, to: best, dist: bestD };
}

// Anota a troca que saiu de `fromId`. Na INSIST_MAX-esima dentro da janela, desiste
// desse monstro por GIVE_UP_MS. Limpa o que ja passou (a memoria nao cresce).
export function afterSwap(mem: FilterMemory, fromId: number, now: number): FilterMemory {
  const tries: Record<number, number[]> = {};
  for (const [k, v] of Object.entries(mem.tries)) {
    const keep = v.filter((at) => now - at < INSIST_WINDOW_MS);
    if (keep.length) tries[Number(k)] = keep;
  }
  const giveUp: Record<number, number> = {};
  for (const [k, until] of Object.entries(mem.giveUp)) if (until > now) giveUp[Number(k)] = until;
  const mine = [...(tries[fromId] ?? []), now];
  if (mine.length >= INSIST_MAX) {
    giveUp[fromId] = now + GIVE_UP_MS;
    delete tries[fromId];
  } else {
    tries[fromId] = mine;
  }
  return { tries, giveUp };
}

// Resposta do TARG: "ok" trocou; "old-engine" = engine sem a tag (tag desconhecida
// devolve o estado do jogador, {player: ...}); "refused" = o engine recusou (monstro
// sumiu ou morreu entre a leitura e a troca) ou falhou a conexao.
export type TargResult = "ok" | "old-engine" | "refused";

export function targResult(r: Record<string, unknown>): TargResult {
  if (r.ok === true && typeof r.targ === "number") return "ok";
  if (r.player !== undefined) return "old-engine";
  return "refused";
}

export function targBody(id: number): string {
  return String(id >>> 0);
}

// Texto curto do monstro pro log.
export function monsterLabel(e: MapEntity): string {
  return `${e.name || "monstro"}${e.level ? ` Lv.${e.level}` : ""}`;
}

// Especies de monstro em volta, sem repetir, pra tela escolher o que ignorar.
export function nearbySpecies(ents: MapEntity[]): { id: number; name: string; level: number; kind: MonsterCategory; count: number }[] {
  const out = new Map<number, { id: number; name: string; level: number; kind: MonsterCategory; count: number }>();
  for (const e of ents) {
    if (!isMonster(e) || e.typeId === undefined) continue;
    const cur = out.get(e.typeId);
    if (cur) cur.count++;
    else out.set(e.typeId, { id: e.typeId, name: e.name, level: e.level, kind: e.kind as MonsterCategory, count: 1 });
  }
  return [...out.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

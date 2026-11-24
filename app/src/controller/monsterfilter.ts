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
// Insistencia: o ignorado volta a ser alvo enquanto o monstro pra onde a troca
// mandou ainda esta vivo (a lista de odio puxou de volta; ele deve estar batendo no
// char). Na INSIST_MAX-esima volta dentro de INSIST_WINDOW_MS desiste dele por
// GIVE_UP_MS e deixa a IA matar: trocar sem parar deixaria o char apanhando. Voltar
// depois que o substituto morreu e so a IA escolhendo o mais perto de novo (visto
// ao vivo em 2026-11-24, 14 s depois): troca de novo sem contar.
export const INSIST_MAX = 2;
export const INSIST_WINDOW_MS = 30000;
export const GIVE_UP_MS = 60000;

// O TARG so enfileira: o SetTarget roda no proximo frame. Ate la o ENTS ainda mostra
// o alvo velho; sem esperar, a troca sairia duas vezes e contaria como insistencia.
export const PENDING_MS = 1500;
// Laco proprio do filtro: no ponto do teste (Niya, 2026-11-24) o char mata em 1,5 a
// 3 s; no ritmo do loop do Treino (1 a 3 s) quase todo ignorado morria antes.
export const FILTER_POLL_MS = 300;

export interface FilterMemory {
  bounces: Record<number, number[]>; // id do ignorado -> quando voltou com o substituto vivo
  giveUp: Record<number, number>; // id -> ate quando deixa lutar
  pending?: { from: number; until: number }; // troca mandada, ainda nao aplicada
  // Substituto da ultima troca de CADA ignorado (id -> pra quem foi e quando). Por
  // ignorado e nao so a ultima troca: com dois batendo no char (A, B, A, B) a
  // ultima troca seria sempre do outro e a insistencia nunca fecharia.
  lastTo: Record<number, { to: number; at: number }>;
}

export function newFilterMemory(): FilterMemory {
  return { bounces: {}, giveUp: {}, lastTo: {} };
}

export type FilterStep =
  | { kind: "none" }
  | { kind: "swap"; from: MapEntity; to: MapEntity; dist: number; bounce: boolean }
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
  if (mem.pending && mem.pending.from === t.id && now < mem.pending.until) return { kind: "none" };
  if ((mem.giveUp[t.id] ?? 0) > now) return { kind: "keep", target: t, why: "insiste" };
  let best: MapEntity | undefined;
  let bestD = Infinity;
  for (const e of snap.ents) {
    if (e.id === t.id || !isMonster(e) || !alive(e) || isIgnored(e, cfg)) continue;
    const d = Math.hypot(e.x - snap.me.x, e.z - snap.me.z);
    if (d <= maxM && d < bestD) { best = e; bestD = d; }
  }
  if (!best) return { kind: "keep", target: t, why: "sem-permitido" };
  const prev = mem.lastTo[t.id];
  const bounce = !!prev && snap.ents.some((e) => e.id === prev.to && alive(e));
  return { kind: "swap", from: t, to: best, dist: bestD, bounce };
}

// Anota a troca mandada (`bounce` = o ignorado tinha voltado com o substituto vivo).
// Na INSIST_MAX-esima volta dentro da janela, desiste dele por GIVE_UP_MS. Limpa o
// que ja passou (a memoria nao cresce).
export function afterSwap(mem: FilterMemory, fromId: number, toId: number, bounce: boolean, now: number): FilterMemory {
  const bounces: Record<number, number[]> = {};
  for (const [k, v] of Object.entries(mem.bounces)) {
    const keep = v.filter((at) => now - at < INSIST_WINDOW_MS);
    if (keep.length) bounces[Number(k)] = keep;
  }
  const giveUp: Record<number, number> = {};
  for (const [k, until] of Object.entries(mem.giveUp)) if (until > now) giveUp[Number(k)] = until;
  if (bounce) {
    const mine = [...(bounces[fromId] ?? []), now];
    if (mine.length >= INSIST_MAX) {
      giveUp[fromId] = now + GIVE_UP_MS;
      delete bounces[fromId];
    } else {
      bounces[fromId] = mine;
    }
  }
  const lastTo: Record<number, { to: number; at: number }> = {};
  for (const [k, v] of Object.entries(mem.lastTo)) if (now - v.at < INSIST_WINDOW_MS) lastTo[Number(k)] = v;
  lastTo[fromId] = { to: toId, at: now };
  return { bounces, giveUp, pending: { from: fromId, until: now + PENDING_MS }, lastTo };
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

// Par da troca pro log. O jogo tem especies diferentes com o mesmo nome (Niya Mage
// de 11170 e de 111700 de HP, visto em 2026-11-24): com nome igual, mostra o HP.
export function swapLabels(from: MapEntity, to: MapEntity): [string, string] {
  const a = from.name || "monstro";
  const b = to.name || "monstro";
  if (a !== b) return [a, b];
  return [`${a} (HP ${from.maxHp})`, `${b} (HP ${to.maxHp}, outra especie)`];
}

// Especies de monstro em volta, sem repetir, pra tela escolher o que ignorar.
export interface NearbySpecies {
  id: number;
  name: string;
  level: number;
  maxHp: number; // separa especies de mesmo nome
  kind: MonsterCategory;
  count: number;
}

export function nearbySpecies(ents: MapEntity[]): NearbySpecies[] {
  const out = new Map<number, NearbySpecies>();
  for (const e of ents) {
    if (!isMonster(e) || e.typeId === undefined) continue;
    const cur = out.get(e.typeId);
    if (cur) cur.count++;
    else out.set(e.typeId, { id: e.typeId, name: e.name, level: e.level, maxHp: e.maxHp, kind: e.kind as MonsterCategory, count: 1 });
  }
  return [...out.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

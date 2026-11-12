// Aviso de monstro unico: o ENTS traz as entidades em volta com o tipo; chefe
// (bit Boss) vivo vira aviso no log, no Windows e no Telegram. So avisa: o bot
// nao vai atras dele (o char segue no ponto de caca).

import type { MapEntity } from "./map";

// O mesmo unico (id) so avisa de novo depois de sumir por esse tempo.
export const UNIQUE_FORGET_MS = 30 * 60 * 1000;

export interface UniqueStep {
  fresh: MapEntity[];
  seen: Map<number, number>; // id -> ultima vez visto
}

export function uniqueStep(seen: Map<number, number>, ents: MapEntity[], now: number): UniqueStep {
  const next = new Map([...seen].filter(([, t]) => now - t < UNIQUE_FORGET_MS));
  const fresh: MapEntity[] = [];
  for (const e of ents) {
    if (e.kind !== "boss" || e.dead) continue;
    if (!next.has(e.id)) fresh.push(e);
    next.set(e.id, now);
  }
  return { fresh, seen: next };
}

export function uniqueText(e: MapEntity, me: { x: number; z: number }): string {
  const d = Math.round(Math.hypot(e.x - me.x, e.z - me.z));
  const lv = e.level > 0 ? ` Lv.${e.level}` : "";
  return `Unico por perto: ${e.name || "monstro unico"}${lv} a ${d} m.`;
}

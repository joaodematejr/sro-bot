// Buffs de item no Treino (ver controller/booster): acha o item na mochila, usa e
// guarda ate quando vale em userData/booster.json (por grupo), pra nao usar outro
// por cima nem depois de reabrir o app.

import fs from "node:fs";
import path from "node:path";

import { boosterUntil, buffDue, BUFF_GROUPS, type BuffKey, pickBuff, untilOf, useItemBody } from "../controller/booster";

type Query = (tag: string, body: string) => Promise<Record<string, unknown>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (r: Record<string, unknown>) => (r.ok === true && typeof r.int === "number" ? r.int : undefined);

let file = "";

export function setBoosterDir(dir: string): void {
  file = path.join(dir, "booster.json");
}

function load(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveUntil(key: BuffKey, until: number, name: string): void {
  if (!file) return;
  const saved = load();
  // Formato antigo ({until} do Exp Booster) vira o novo, por grupo.
  if (typeof saved.until === "number") {
    saved.exp = { until: saved.until, name: saved.name };
    delete saved.until;
    delete saved.id;
    delete saved.name;
    delete saved.usedAt;
  }
  saved[key] = { until, name, usedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
}

async function stock(q: Query, id: number): Promise<number | undefined> {
  return num(await q("GETP", `XBagDocument GetItemCount:${id},0`));
}

async function findIndex(q: Query, id: number): Promise<number | undefined> {
  const n = num(await q("GETP", "XBagDocument ItemBag Items get_Count")) ?? 0;
  for (let i = 0; i < n; i++) if (num(await q("GETP", `XBagDocument ItemBag Items get_Item:${i} itemID`)) === id) return i;
  return undefined;
}

// Buff no char? (lista do servidor; undefined se a leitura falhar)
const BUFFS = "XEntityMgr get_Player _buff _ServerBuffList";
async function hasBuff(q: Query, id: number): Promise<boolean | undefined> {
  const n = num(await q("GETP", `${BUFFS} get_Count`));
  if (n === undefined) return undefined;
  for (let i = 0; i < n; i++) {
    const b = num(await q("GETP", `${BUFFS} get_Item:${i} buffID`));
    if (b === undefined) return undefined;
    if (b === id) return true;
  }
  return false;
}

// Usa um item de cada grupo ligado que nao tenha buff valendo (com o app sabendo).
export async function maybeUseBuffs(q: Query, on: Partial<Record<BuffKey, boolean>>, log: (m: string) => void): Promise<void> {
  for (const g of BUFF_GROUPS) {
    if (!on[g.key]) continue;
    const active = g.buffId !== undefined ? await hasBuff(q, g.buffId).catch(() => undefined) : undefined;
    if (!buffDue(active, untilOf(load(), g.key), Date.now())) continue;
    const counts: Record<number, number | undefined> = {};
    for (const it of g.items) counts[it.id] = await stock(q, it.id);
    const b = pickBuff(g.items, counts);
    if (!b) continue;
    const idx = await findIndex(q, b.id);
    if (idx === undefined) continue;
    const before = counts[b.id] ?? 0;
    await q("SKIL", useItemBody(idx));
    await sleep(2500);
    const after = await stock(q, b.id);
    if (after !== undefined && after < before) {
      saveUntil(g.key, boosterUntil(b, Date.now()), b.name);
      log(`${g.label} ativado: ${b.name} (sobram ${after}).`);
    } else {
      // Nao gastou: tenta de novo daqui a 10 min (sem martelar o servidor).
      saveUntil(g.key, Date.now() + 10 * 60 * 1000, b.name);
      log(`${g.label}: ${b.name} nao foi usado (o jogo recusou); tento de novo em 10 min.`);
    }
  }
}

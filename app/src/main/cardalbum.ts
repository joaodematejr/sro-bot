// Automacao do Album de Cards por metodo: le grupos, estrelas, combinacoes e
// cartas possuidas no XCardCollectDocument, ativa conjuntos prontos, sobe
// estrela quando o grupo completa e quebra apenas excedentes seguros acima do
// necessario ate StarLevelMAX.

import fs from "node:fs";
import path from "node:path";

import {
  canUpgradeGroupStar,
  type CardAlbumConfig,
  type CardSurplusItem,
  computeCardSurplus,
  createCardStaticCache,
  exportCardStaticCache,
  importCardStaticCache,
  nextCardAlbumStep,
  readCardAlbumSnapshot,
} from "../controller/cardalbum";
import { createEngineClient } from "../controller/enginechannel";
import { queryPlayer } from "./engine";

type Log = (msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SERVER_WAIT_MS = 1800;
const PRE_STEP_WAIT_MS = 300;
const MAX_STEPS = 80;

let stopRequested = false;
let cacheFile = "";
let staticCache = createCardStaticCache();

export function setCardAlbumDir(dir: string): void {
  cacheFile = path.join(dir, "cardalbum-cache.json");
  try {
    if (fs.existsSync(cacheFile)) {
      staticCache = importCardStaticCache(JSON.parse(fs.readFileSync(cacheFile, "utf8")));
    }
  } catch {
    staticCache = createCardStaticCache();
  }
}

function saveCache(): void {
  if (!cacheFile || !staticCache.groups.size) return;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(exportCardStaticCache(staticCache)));
  } catch {
    /* noop */
  }
}

export function stopCardAlbum(): void {
  stopRequested = true;
}

export async function previewCardAlbum(
  host: string,
  port: number,
  cfg: CardAlbumConfig,
  log: Log = () => {},
): Promise<{
  ok: boolean;
  erro?: string;
  surplus?: CardSurplusItem[];
  readySets?: number;
  upgradeGroups?: number;
  groups?: { groupId: number; name?: string; currentStar: number; maxStar: number; actionNum: number; totalSets: number }[];
}> {
  const p0 = await queryPlayer(host, port);
  if (!p0.ok) {
    log("char nao esta em mundo; analise cancelada.");
    return { ok: false, erro: "char nao esta em mundo" };
  }
  const client = createEngineClient(host, port, 5000);
  try {
    log("lendo grupos, estrelas e cartas do album...");
    const s = await readCardAlbumSnapshot(client.request, staticCache);
    if (!s || !s.tablesLoaded) {
      log("nao foi possivel carregar todo o album de cards (leitura incompleta; nada quebrado).");
      return { ok: false, erro: "tabelas do album incompletas" };
    }
    saveCache();
    const surplus = computeCardSurplus(s, cfg);
    let readySets = 0;
    let upgradeGroups = 0;
    for (const g of s.groups) {
      if (cfg.targetGroupId && cfg.targetGroupId > 0 && g.groupId !== cfg.targetGroupId) continue;
      for (const set of g.sets) if (!set.active && set.canActive) readySets++;
      if (canUpgradeGroupStar(g, s.level)) upgradeGroups++;
    }
    const groups = s.groups.map((g) => ({
      groupId: g.groupId,
      name: g.name,
      currentStar: g.currentStar,
      maxStar: g.maxStar,
      actionNum: g.actionNum,
      totalSets: g.sets.length,
    }));
    const totalSurplus = surplus.reduce((acc, x) => acc + x.surplus, 0);
    log(`analise: ${readySets} combinacao(oes) pronta(s), ${upgradeGroups} estrela(s) pronta(s), ${totalSurplus} card(s) excedente(s) em ${surplus.length} tipo(s).`);
    return { ok: true, surplus, readySets, upgradeGroups, groups };
  } finally {
    client.close();
  }
}

export async function runCardAlbum(
  host: string,
  port: number,
  cfg: CardAlbumConfig,
  log: Log = () => {},
): Promise<{ ok: boolean; erro?: string; activated?: number; upgraded?: number; broken?: number; surplus?: CardSurplusItem[] }> {
  stopRequested = false;
  const p0 = await queryPlayer(host, port);
  if (!p0.ok) {
    log("char nao esta em mundo; nao iniciado.");
    return { ok: false, erro: "char nao esta em mundo" };
  }
  const client = createEngineClient(host, port, 5000);
  const tried = new Set<string>();
  let activated = 0;
  let upgraded = 0;
  let broken = 0;

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (stopRequested) {
        log("parado.");
        return { ok: false, erro: "parado", activated, upgraded, broken };
      }
      const s = await readCardAlbumSnapshot(client.request, staticCache);
      if (s?.tablesLoaded) saveCache();
      const step = nextCardAlbumStep(s, cfg, tried);
      if (step.kind === "done") {
        const surplus = s ? computeCardSurplus(s, cfg) : [];
        log(`concluido: ${step.reason} (${activated} ativada(s), ${upgraded} estrela(s), ${broken} quebrado(s)).`);
        return { ok: true, activated, upgraded, broken, surplus };
      }
      if (step.kind === "fail") {
        log(`falhou: ${step.reason}.`);
        return { ok: false, erro: step.reason, activated, upgraded, broken };
      }
      log(step.name);
      if (step.preBody) {
        await client.request("SKIL", step.preBody);
        await sleep(PRE_STEP_WAIT_MS);
      }
      await client.request("SKIL", step.body);
      tried.add(step.key);
      if (step.op === "activate") activated++;
      else if (step.op === "upgrade") upgraded++;
      else if (step.op === "break") broken += step.count ?? 1;
      await sleep(SERVER_WAIT_MS);
    }
    log("muitas acoes numa passada; parando por seguranca.");
    return { ok: false, erro: "limite de acoes", activated, upgraded, broken };
  } finally {
    client.close();
  }
}


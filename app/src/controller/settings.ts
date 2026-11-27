// Configuracao de caminhos do app (emulador, pasta, instancia, adb). Logica
// pura; o main le e grava o arquivo e aplica.
//
// LDPlayer 9: ldconsole.exe e adb.exe na pasta; instancia N no adb 127.0.0.1:(5555+2N).
// MuMu (6.x/12): nx_main\MuMuManager.exe e nx_main\adb.exe; a porta sai do
//   `MuMuManager info -v N` (adb_port) com a instancia aberta; sem ela, o padrao
//   do MuMu 12 e 16384+32N.

export type EmulatorKind = "ldplayer" | "mumu";

// Versao do jogo: cada uma e um APK proprio (pacote Android diferente), e as
// duas podem estar instaladas no mesmo emulador.
//   global: com.silkroad.mb (2.3.x, Unity 6000.0.60f1)
//   eu:     com.hive.silkroad (Europa, publicado pela Hive, Unity 6000.0.77f1)
export type GameVersion = "global" | "eu";

export const GAME_PACKAGES: Record<GameVersion, string> = {
  global: "com.silkroad.mb",
  eu: "com.hive.silkroad",
};

export const GAME_LABELS: Record<GameVersion, string> = {
  global: "Global",
  eu: "Europa",
};

export function gamePackage(g: GameVersion): string {
  return GAME_PACKAGES[g] ?? GAME_PACKAGES.global;
}

export function parseGameVersion(v: unknown): GameVersion {
  return v === "eu" ? "eu" : "global";
}

export interface AppSettings {
  emulator: EmulatorKind;
  ldplayerDir: string; // pasta com ldconsole.exe e adb.exe
  mumuDir: string; // pasta com nx_main\MuMuManager.exe
  instance: number; // indice da instancia no emulador (0, 1, ...)
  adbPath: string; // vazio = o adb do emulador, senao o do PATH
  game: GameVersion; // qual APK do jogo o bot controla
}

export const DEFAULT_SETTINGS: AppSettings = {
  emulator: "ldplayer",
  ldplayerDir: "C:\\LDPlayer\\LDPlayer9",
  mumuDir: "C:\\Program Files\\Netease\\MuMuPlayer",
  instance: 0,
  adbPath: "",
  game: "global",
};

// Pasta do backup do libmain.so por emulador E por jogo: com os dois APKs no
// mesmo emulador, o backup de um nao pode sobrescrever o do outro. O Global
// fica no nome antigo (so o serial) pra achar os backups ja guardados.
export function backupDirName(serial: string, pkg: string): string {
  const s = serial.replace(/[^\w.-]/g, "_");
  return pkg === GAME_PACKAGES.global ? s : `${s}_${pkg.replace(/[^\w.-]/g, "_")}`;
}

export function joinWin(dir: string, file: string): string {
  return dir.replace(/[\\/]+$/, "") + "\\" + file;
}

// Endereco padrao do adb da instancia (o MuMu pode informar outra porta).
export function serialFor(s: Pick<AppSettings, "emulator" | "instance">): string {
  const n = Math.max(0, Math.floor(s.instance));
  return s.emulator === "mumu" ? `127.0.0.1:${16384 + 32 * n}` : `127.0.0.1:${5555 + 2 * n}`;
}

// Programa de linha de comando do emulador (abrir instancia, listar).
export function consolePath(s: AppSettings): string {
  return s.emulator === "mumu" ? joinWin(s.mumuDir, "nx_main\\MuMuManager.exe") : joinWin(s.ldplayerDir, "ldconsole.exe");
}

// adb escolhido: o configurado, senao o do emulador (se existir), senao o do PATH.
export function resolveAdb(s: AppSettings, exists: (p: string) => boolean): string {
  if (s.adbPath.trim()) return s.adbPath.trim();
  const own = s.emulator === "mumu" ? joinWin(s.mumuDir, "nx_main\\adb.exe") : joinWin(s.ldplayerDir, "adb.exe");
  return exists(own) ? own : "adb";
}

// Junta o que veio do arquivo/UI com o padrao e corrige valores invalidos.
export function normalizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const r = raw ?? {};
  const inst = Number(r.instance);
  const dir = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);
  return {
    emulator: r.emulator === "mumu" ? "mumu" : "ldplayer",
    ldplayerDir: dir(r.ldplayerDir, DEFAULT_SETTINGS.ldplayerDir),
    mumuDir: dir(r.mumuDir, DEFAULT_SETTINGS.mumuDir),
    instance: Number.isFinite(inst) && inst >= 0 && inst <= 99 ? Math.floor(inst) : DEFAULT_SETTINGS.instance,
    adbPath: typeof r.adbPath === "string" ? r.adbPath.trim() : "",
    game: parseGameVersion(r.game),
  };
}

export interface MumuInstance {
  name: string;
  started: boolean; // Android ligado
  adbSerial?: string; // 127.0.0.1:<adb_port>, quando o MuMu informa
}

// Saida JSON do `MuMuManager info -v N` (objeto da instancia) ou do
// `info -v all` (mapa indice -> objeto).
export function parseMumuInfo(json: string, instance: number): MumuInstance | undefined {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const item = (typeof d.index === "string" || typeof d.index === "number" ? d : d[String(instance)]) as
    | Record<string, unknown>
    | undefined;
  if (!item || typeof item !== "object") return undefined;
  const port = Number(item.adb_port);
  const host = typeof item.adb_host_ip === "string" && item.adb_host_ip ? item.adb_host_ip : "127.0.0.1";
  return {
    name: typeof item.name === "string" ? item.name : `instancia ${instance}`,
    started: item.is_android_started === true,
    adbSerial: Number.isFinite(port) && port > 0 ? `${host}:${port}` : undefined,
  };
}

// Pasta das libs ARM do jogo a partir do `pm path` (Android 9:
// /data/app/<pkg>-x/base.apk; Android 11+: /data/app/~~a/<pkg>-b/base.apk).
export function libDirFromPmPath(out: string): string | undefined {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("package:") && l.endsWith("base.apk"));
  if (!line) return undefined;
  const apk = line.slice("package:".length);
  return apk.slice(0, apk.lastIndexOf("/")) + "/lib/arm64";
}

// Servicos do VirtualBox do LDPlayer que ficam presos com o emulador fechado e
// impedem a instancia de subir (visto em 2026-11-06: Ld9BoxSVC de dias antes).
export const LD_STALE_SERVICES = ["Ld9BoxSVC.exe", "VBoxNetNAT.exe", "VBoxNetDHCP.exe"];
const LD_INSTANCE_PROCS = ["dnplayer.exe", "Ld9BoxHeadless.exe"];
export const LD_UNSTICK_AFTER_MS = 40000;

// Encerrar os servicos so se: e LDPlayer, ja passou o prazo desde o launch, a
// instancia nao responde e NENHUMA instancia do LDPlayer esta rodando (senao
// derrubaria uma instancia em uso).
export function shouldUnstickLd(
  kind: EmulatorKind,
  running: Set<string>,
  sinceLaunchMs: number,
  online: boolean,
  alreadyTried: boolean,
): boolean {
  if (kind !== "ldplayer" || online || alreadyTried || sinceLaunchMs < LD_UNSTICK_AFTER_MS) return false;
  const lower = new Set([...running].map((n) => n.toLowerCase()));
  if (LD_INSTANCE_PROCS.some((p) => lower.has(p.toLowerCase()))) return false;
  return LD_STALE_SERVICES.some((p) => lower.has(p.toLowerCase()));
}

// Nomes de processo da saida CSV do `tasklist /FO CSV /NH`.
export function parseTasklist(csv: string): Set<string> {
  const out = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return out;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

// ---- Os dois APKs no mesmo emulador ----

export function otherGame(g: GameVersion): GameVersion {
  return g === "eu" ? "global" : "eu";
}

// Pacote da janela em foco, da saida do `dumpsys window | grep mCurrentFocus`
// (visto no MuMu em 2026-11-27):
//   mCurrentFocus=Window{412aee7 u0 com.hive.silkroad/com.gihot.unityplugin.GihotGameActivity}
export function focusedPackage(out: string): string | undefined {
  return /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\//.exec(out)?.[1];
}

export interface OtherGameOpen {
  version: GameVersion; // a versao que NAO esta na configuracao
  foreground: boolean; // na frente (senao so o processo vivo em segundo plano)
}

// O outro APK esta aberto? Na frente pelo foco; em segundo plano pelo pidof
// (sair pro launcher deixa o processo vivo).
export function otherGameOpen(selected: GameVersion, focusedPkg: string | undefined, otherRunning: boolean): OtherGameOpen | undefined {
  const other = otherGame(selected);
  const foreground = focusedPkg === gamePackage(other);
  if (!foreground && !otherRunning) return undefined;
  return { version: other, foreground };
}

export function otherGameText(selected: GameVersion, o: OtherGameOpen): string {
  const where = o.foreground ? "esta aberta na frente" : "esta aberta em segundo plano";
  return `a versao ${GAME_LABELS[o.version]} (${gamePackage(o.version)}) ${where}, mas o bot esta configurado pra ${GAME_LABELS[selected]}: ele so controla a ${GAME_LABELS[selected]}.`;
}

// Linhas do "Testar conexao" pros dois APKs. So o selecionado precisa estar
// instalado; o outro e informativo e nunca conta como falha.
export function gameChecks(selected: GameVersion, installed: Record<GameVersion, boolean>): CheckResult[] {
  return (["global", "eu"] as GameVersion[]).map((g) => {
    const pkg = gamePackage(g);
    const sel = g === selected;
    const inst = installed[g] ? "instalado" : "nao instalado";
    return {
      name: `jogo ${GAME_LABELS[g]}`,
      ok: sel ? installed[g] : true,
      detail: sel ? `${pkg} ${inst} (selecionado: o bot usa este)` : `${pkg} ${inst} (nao selecionado)`,
    };
  });
}

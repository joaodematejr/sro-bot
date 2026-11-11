import { contextBridge, ipcRenderer } from "electron";

// Ponte segura: expoe so as funcoes do engine ao renderer.
contextBridge.exposeInMainWorld("sro", {
  setup: () => ipcRenderer.invoke("engine:setup"),
  player: () => ipcRenderer.invoke("engine:player"),
  inject: () => ipcRenderer.invoke("engine:inject"),
  restore: () => ipcRenderer.invoke("engine:restore"),
  gameForeground: () => ipcRenderer.invoke("engine:gamefg"),
  reopen: (restart?: boolean) => ipcRenderer.invoke("engine:reopen", restart),
  connectionLost: () => ipcRenderer.invoke("engine:connlost"),
  autoFight: (on: boolean) => ipcRenderer.invoke("engine:autofight", on),
  autoFightOffSafe: () => ipcRenderer.invoke("engine:autofightoff"),
  sellJunk: () => ipcRenderer.invoke("engine:selljunk"),
  runTower: (cfg: {
    refreshOnFailure: boolean;
    sweep: boolean;
    fightOnceBeforeSweeping: boolean;
    refreshRewardRatio: number;
    useBuff: boolean;
  }) => ipcRenderer.invoke("engine:tower", cfg),
  stopTower: () => ipcRenderer.invoke("engine:towerstop"),
  runContinental: (cfg: {
    mapId: number;
    ignoreGreen: boolean;
    ignoreBlue: boolean;
    restartWhenStuck: boolean;
    onlyOpenChests: boolean;
    stopWhenAllPurple: boolean;
    atSpot?: boolean;
  }) => ipcRenderer.invoke("engine:continental", cfg),
  stopContinental: () => ipcRenderer.invoke("engine:continentalstop"),
  chestLeft: () => ipcRenderer.invoke("engine:chestleft"),
  switchChar: (name: string) => ipcRenderer.invoke("engine:switchchar", name),
  mainChar: () => ipcRenderer.invoke("engine:mainchar"),
  isChar: (entry: string) => ipcRenderer.invoke("engine:ischar", entry),
  runTrain: (cfg: { deathLimit: number; setupPotions: boolean; spot?: { scene: number; x: number; y: number; z: number } }) =>
    ipcRenderer.invoke("engine:train", cfg),
  stopTrain: () => ipcRenderer.invoke("engine:trainstop"),
  pauseTrain: (reason: string | null) => ipcRenderer.invoke("engine:trainpause", reason),
  trainSpot: () => ipcRenderer.invoke("engine:trainspot"),
  runFirm: (cfg: { stopAfter: number; maxQuality: number; allowItems: number[]; askHelp: boolean; allowTeleport: boolean }) =>
    ipcRenderer.invoke("engine:firm", cfg),
  stopFirm: () => ipcRenderer.invoke("engine:firmstop"),
  runGuild: (cfg: { signIn: string; chests: boolean; salary: boolean; redPacket: boolean; storeWeekly?: boolean }) =>
    ipcRenderer.invoke("engine:guild", cfg),
  stopGuild: () => ipcRenderer.invoke("engine:guildstop"),
  runActChests: () => ipcRenderer.invoke("engine:actchest"),
  runFreebies: (donate: boolean) => ipcRenderer.invoke("engine:freebies", donate),
  qigongAccept: () => ipcRenderer.invoke("engine:qigongaccept"),
  qigongRequest: () => ipcRenderer.invoke("engine:qigongrequest"),
  guildHallCheck: () => ipcRenderer.invoke("engine:guildhallcheck"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: { emulator: string; ldplayerDir: string; mumuDir: string; instance: number; adbPath: string }) =>
    ipcRenderer.invoke("settings:set", s),
  testSettings: () => ipcRenderer.invoke("settings:test"),
  vpnStatus: () => ipcRenderer.invoke("vpn:status"),
  vpnEnable: (ips: string[]) => ipcRenderer.invoke("vpn:enable", ips),
  vpnDisable: () => ipcRenderer.invoke("vpn:disable"),
  vpnPing: (ip: string) => ipcRenderer.invoke("vpn:ping", ip),
  vpnHealth: () => ipcRenderer.invoke("vpn:health"),
  aiGet: () => ipcRenderer.invoke("ai:get"),
  aiSet: (s: unknown, key?: string) => ipcRenderer.invoke("ai:set", s, key),
  aiSnapshot: (appInfo: unknown) => ipcRenderer.invoke("ai:snapshot", appInfo),
  aiChat: (history: unknown, appInfo: unknown) => ipcRenderer.invoke("ai:chat", history, appInfo),
  aiModels: () => ipcRenderer.invoke("ai:models"),
  credGet: () => ipcRenderer.invoke("cred:get"),
  bag: () => ipcRenderer.invoke("engine:bag"),
  credSet: (id: string, pwd: string) => ipcRenderer.invoke("cred:set", id, pwd),
  histTick: (training: boolean) => ipcRenderer.invoke("hist:tick", training),
  histEvent: (ev: unknown) => ipcRenderer.invoke("hist:event", ev),
  histSummary: (hours: number) => ipcRenderer.invoke("hist:summary", hours),
  autoLogin: () => ipcRenderer.invoke("engine:autologin"),
  stopLogin: () => ipcRenderer.invoke("engine:loginstop"),
  uiLog: (m: string) => ipcRenderer.send("ui:log", m),
  onLog: (cb: (msg: string) => void) =>
    ipcRenderer.on("sro:log", (_e, m: string) => cb(m)),
  // Atualizacao pelos Releases (ver main/updater.ts).
  appVersion: () => ipcRenderer.invoke("app:version"),
  updateState: () => ipcRenderer.invoke("update:state"),
  updateInstall: (resume: { game: boolean; bot: boolean }) => ipcRenderer.invoke("update:install", resume),
  updateResume: () => ipcRenderer.invoke("update:resume"),
  onUpdate: (cb: (s: { kind: string; version?: string; pct?: number; reason?: string }) => void) =>
    ipcRenderer.on("update:status", (_e, s) => cb(s)),
});

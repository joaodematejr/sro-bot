// adb, emulador e versao do jogo em uso (definidos pela configuracao do app).

import { type AppSettings, DEFAULT_SETTINGS, gamePackage } from "../controller/settings";

let adb = "adb";
let emu: AppSettings = { ...DEFAULT_SETTINGS };

export function setAdbBin(path: string): void {
  adb = path || "adb";
}

export function adbBin(): string {
  return adb;
}

export function setEmulator(s: AppSettings): void {
  emu = { ...s };
}

export function emulator(): AppSettings {
  return emu;
}

// Pacote Android do jogo escolhido (Global ou Europa).
export function gamePkg(): string {
  return gamePackage(emu.game);
}

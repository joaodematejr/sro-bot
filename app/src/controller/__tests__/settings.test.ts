import assert from "node:assert";
import { test } from "node:test";

import {
  backupDirName,
  consolePath,
  DEFAULT_SETTINGS,
  gamePackage,
  libDirFromPmPath,
  normalizeSettings,
  parseGameVersion,
  LD_UNSTICK_AFTER_MS,
  parseMumuInfo,
  parseTasklist,
  resolveAdb,
  serialFor,
  shouldUnstickLd,
} from "../settings";

// Saida real do `tasklist /FO CSV /NH` nesta maquina com o LDPlayer aberto.
const TASKLIST_OPEN = [
  '"OtherBot.exe","30280","Console","1","26.548 K"',
  '"dnplayer.exe","9228","Console","1","96.896 K"',
  '"Ld9BoxSVC.exe","6964","Console","1","23.332 K"',
  '"Ld9BoxHeadless.exe","12836","Console","1","3.313.504 K"',
  '"VBoxNetDHCP.exe","29524","Console","1","16.408 K"',
  '"VBoxNetNAT.exe","1836","Console","1","24.892 K"',
].join("\r\n");
// Como estava travado: so os servicos, sem instancia.
const TASKLIST_STUCK = TASKLIST_OPEN.split("\r\n").filter((l) => !/dnplayer|Headless/.test(l)).join("\r\n");

test("destravar o LDPlayer so com servico preso e nenhuma instancia rodando", () => {
  const open = parseTasklist(TASKLIST_OPEN);
  const stuck = parseTasklist(TASKLIST_STUCK);
  assert.ok(open.has("Ld9BoxHeadless.exe") && open.has("OtherBot.exe"));
  const late = LD_UNSTICK_AFTER_MS + 1;
  assert.equal(shouldUnstickLd("ldplayer", stuck, late, false, false), true);
  // Instancia rodando (mesmo que nao seja a nossa): nao derruba.
  assert.equal(shouldUnstickLd("ldplayer", open, late, false, false), false);
  // Cedo demais, ja online, ja tentou, ou MuMu: nao mexe.
  assert.equal(shouldUnstickLd("ldplayer", stuck, LD_UNSTICK_AFTER_MS - 1, false, false), false);
  assert.equal(shouldUnstickLd("ldplayer", stuck, late, true, false), false);
  assert.equal(shouldUnstickLd("ldplayer", stuck, late, false, true), false);
  assert.equal(shouldUnstickLd("mumu", stuck, late, false, false), false);
  // Sem servico nenhum preso: nada pra encerrar.
  assert.equal(shouldUnstickLd("ldplayer", parseTasklist('"OtherBot.exe","1","Console","1","1 K"'), late, false, false), false);
});

const MUMU = { ...DEFAULT_SETTINGS, emulator: "mumu" as const };

test("instancia vira o endereco do adb: LDPlayer 5555+2N, MuMu 16384+32N", () => {
  assert.equal(serialFor({ emulator: "ldplayer", instance: 0 }), "127.0.0.1:5555");
  assert.equal(serialFor({ emulator: "ldplayer", instance: 1 }), "127.0.0.1:5557");
  assert.equal(serialFor({ emulator: "ldplayer", instance: -2 }), "127.0.0.1:5555");
  assert.equal(serialFor({ emulator: "mumu", instance: 0 }), "127.0.0.1:16384");
  assert.equal(serialFor({ emulator: "mumu", instance: 2 }), "127.0.0.1:16448");
});

test("adb e linha de comando de cada emulador", () => {
  const ld = "C:\\LDPlayer\\LDPlayer9\\adb.exe";
  assert.equal(resolveAdb(DEFAULT_SETTINGS, (p) => p === ld), ld);
  assert.equal(resolveAdb({ ...DEFAULT_SETTINGS, ldplayerDir: "C:\\LDPlayer\\LDPlayer9\\" }, (p) => p === ld), ld);
  assert.equal(resolveAdb(DEFAULT_SETTINGS, () => false), "adb");
  assert.equal(resolveAdb({ ...DEFAULT_SETTINGS, adbPath: " D:\\tools\\adb.exe " }, () => true), "D:\\tools\\adb.exe");
  // Caminhos do MuMu 6.8 instalado nesta maquina.
  const mumuAdb = "C:\\Program Files\\Netease\\MuMuPlayer\\nx_main\\adb.exe";
  assert.equal(resolveAdb(MUMU, (p) => p === mumuAdb), mumuAdb);
  assert.equal(consolePath(MUMU), "C:\\Program Files\\Netease\\MuMuPlayer\\nx_main\\MuMuManager.exe");
  assert.equal(consolePath(DEFAULT_SETTINGS), "C:\\LDPlayer\\LDPlayer9\\ldconsole.exe");
});

test("valores invalidos voltam ao padrao; arquivo antigo (sem emulador) vira LDPlayer", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ ldplayerDir: "  ", instance: -1 }), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ ldplayerDir: "D:\\LD9", instance: 2, adbPath: "" }),
    { ...DEFAULT_SETTINGS, ldplayerDir: "D:\\LD9", instance: 2 });
  assert.equal(normalizeSettings({ emulator: "mumu" }).emulator, "mumu");
  assert.equal(normalizeSettings({ emulator: "x" as never }).emulator, "ldplayer");
});

test("info do MuMuManager: instancia fechada (lida aqui) e aberta com porta", () => {
  // Saida real do `MuMuManager info -v all` nesta maquina.
  const all = '{"0":{"android_version":"15.0","index":"0","is_android_started":false,"name":"Android Device"}}';
  assert.deepEqual(parseMumuInfo(all, 0), { name: "Android Device", started: false, adbSerial: undefined });
  const one = '{"index":"1","name":"Jogo","is_android_started":true,"adb_host_ip":"127.0.0.1","adb_port":16416}';
  assert.deepEqual(parseMumuInfo(one, 1), { name: "Jogo", started: true, adbSerial: "127.0.0.1:16416" });
  assert.equal(parseMumuInfo(all, 3), undefined);
  assert.equal(parseMumuInfo("nao e json", 0), undefined);
});

test("pasta das libs pelo pm path, no Android 9 e no 11+", () => {
  assert.equal(libDirFromPmPath("package:/data/app/com.silkroad.mb-AYsI-yUTuAlWJR31x7SdCg==/base.apk\n"),
    "/data/app/com.silkroad.mb-AYsI-yUTuAlWJR31x7SdCg==/lib/arm64");
  assert.equal(libDirFromPmPath("package:/data/app/~~Zx1==/com.silkroad.mb-Qw2==/base.apk\npackage:/data/app/~~Zx1==/com.silkroad.mb-Qw2==/split_config.arm64_v8a.apk"),
    "/data/app/~~Zx1==/com.silkroad.mb-Qw2==/lib/arm64");
  assert.equal(libDirFromPmPath(""), undefined);
});

test("versao do jogo: pacote, normalizacao e pasta do backup", () => {
  assert.equal(gamePackage("global"), "com.silkroad.mb");
  assert.equal(gamePackage("eu"), "com.hive.silkroad");
  assert.equal(parseGameVersion("eu"), "eu");
  assert.equal(parseGameVersion("x"), "global");
  assert.equal(parseGameVersion(undefined), "global");
  // settings.json antigo (sem o campo) continua no Global.
  assert.equal(normalizeSettings({ emulator: "mumu" }).game, "global");
  assert.equal(normalizeSettings({ game: "eu" }).game, "eu");
  // Global mantem o nome antigo da pasta; Europa ganha o pacote no nome.
  assert.equal(backupDirName("127.0.0.1:5555", "com.silkroad.mb"), "127.0.0.1_5555");
  assert.equal(backupDirName("127.0.0.1:5555", "com.hive.silkroad"), "127.0.0.1_5555_com.hive.silkroad");
  assert.equal(backupDirName("emulator-5554", "com.hive.silkroad"), "emulator-5554_com.hive.silkroad");
});

// Pacote da Europa no MuMu (Android 12), saida real do `pm path` em 2026-11-27.
test("libDirFromPmPath acha a pasta do APK da Europa", () => {
  assert.equal(libDirFromPmPath("package:/data/app/~~Can2kNvel35DliA_PxVieA==/com.hive.silkroad-Jaf5YN5qqQufWK5IwqqBNA==/base.apk\n"),
    "/data/app/~~Can2kNvel35DliA_PxVieA==/com.hive.silkroad-Jaf5YN5qqQufWK5IwqqBNA==/lib/arm64");
});

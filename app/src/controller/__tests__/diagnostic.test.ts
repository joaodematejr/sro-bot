import assert from "node:assert";
import { test } from "node:test";

import { buildDiagnostic, diagnosticFileName, redact, scrubText } from "../diagnostic";

const TG_TOKEN = "123456789:AAHk3vQx9_abcdefghijklmnopqrstuvwxyz0";
const WG_KEY = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";

test("campo com nome de segredo vira *** e o resto fica", () => {
  const r = redact({ emulator: "ldplayer", instance: 2, pwd: "x", nested: { apiKey: "y", token: "z", chatId: 42, ok: true }, list: [{ password: "w" }] });
  assert.deepEqual(r, { emulator: "ldplayer", instance: 2, pwd: "***", nested: { apiKey: "***", token: "***", chatId: "***", ok: true }, list: [{ password: "***" }] });
});

test("texto livre perde token do Telegram, chave sk- e chave WireGuard", () => {
  const s = scrubText(`erro com ${TG_TOKEN} e sk-ant-abcdefghijklmnop1234 e ${WG_KEY} fim`);
  assert.equal(s, "erro com *** e *** e *** fim");
  assert.equal(scrubText("[12:00:01] chegou no ponto (cena 21, 120, 340)"), "[12:00:01] chegou no ponto (cena 21, 120, 340)");
});

test("diagnostico junta versoes, arquivos, painel, historico e log sem segredo", () => {
  const txt = buildDiagnostic({
    when: new Date("2026-11-12T15:00:00Z"),
    versions: { app: "0.145.0" },
    files: { "settings.json": '{"instance":2}', "telegram.json": `{"enabled":true,"chatId":42,"chatName":"Fulano"}`, "ai.json": null },
    local: { "act-cont": "1", continentalConfig: '{"mapId":0}', "tg-token-draft": TG_TOKEN },
    history: { samples: 3 },
    log: `[12:00] falhou: token ${TG_TOKEN}`,
  });
  assert.ok(txt.includes('"app": "0.145.0"'));
  assert.ok(txt.includes("== ai.json\n(nao existe)"));
  assert.ok(txt.includes('"chatId": "***"'));
  assert.ok(txt.includes('"mapId": 0'));
  assert.ok(txt.includes('"tg-token-draft": "***"'));
  assert.ok(txt.includes("[12:00] falhou: token ***"));
  assert.ok(!txt.includes(TG_TOKEN));
  assert.ok(!txt.includes("Fulano"));
});

test("nome do arquivo leva data e hora local", () => {
  assert.equal(diagnosticFileName(new Date(2026, 10, 12, 9, 5)), "sro-bot-diagnostico-20261112-0905.txt");
});

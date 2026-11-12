import test from "node:test";
import assert from "node:assert/strict";

import { alertDue, alertFromLog, alertMessage, ALERT_REPEAT_MS, chatFromUpdates, hideToken, validToken } from "../telegram";

test("linhas do log que viram aviso no Telegram", () => {
  assert.deepEqual(alertFromLog("[10:00:00] morreu (2/5)."), { kind: "morte", group: "problem", text: "morreu (2/5)." });
  assert.equal(alertFromLog("[treino] morreu (1/3).")?.kind, "morte"); // como chega do main
  assert.equal(alertFromLog("conexao com o servidor caiu (Connection failed); reiniciando o jogo...")?.kind, "queda");
  assert.equal(alertFromLog("jogo congelado; reiniciando o jogo...")?.kind, "queda");
  assert.equal(alertFromLog("falha ao reabrir: timeout")?.kind, "reabrir");
  assert.equal(alertFromLog("a conta entrou em outro aparelho (\"logged in on another device\"): bot parado")?.kind, "outro aparelho");
  assert.equal(alertFromLog("Mochila cheia: 0 espaco(s) livre(s).")?.kind, "mochila");
  assert.equal(alertFromLog("EXP/h caiu de 20 M pra 2 M nos ultimos 20 min.")?.kind, "exp");
  assert.equal(alertFromLog("treino concluido (1 morte(s)).")?.group, "done");
  assert.equal(alertFromLog("[continental] concluido: 10 dados")?.group, "done");
  // Linhas comuns nao avisam (nem "Mochila enchendo" nem a contagem de mortes da tela).
  assert.equal(alertFromLog("Mochila enchendo: 4 espacos livres."), undefined);
  assert.equal(alertFromLog("chegou no ponto 1"), undefined);
  assert.equal(alertFromLog("treino parado."), undefined);
});

test("o mesmo aviso no maximo a cada 10 min; morte sempre", () => {
  const last = { queda: 1000, morte: 1000 };
  assert.equal(alertDue(last, "queda", 1000 + ALERT_REPEAT_MS - 1), false);
  assert.equal(alertDue(last, "queda", 1000 + ALERT_REPEAT_MS), true);
  assert.equal(alertDue(last, "mochila", 1001), true);
  assert.equal(alertDue(last, "morte", 1001), true);
});

test("mensagem, token e chat", () => {
  assert.equal(alertMessage({ kind: "morte", group: "problem", text: "morreu (1)." }, "Heroi"), "SRO Bot | Heroi: morreu (1).");
  assert.equal(alertMessage({ kind: "morte", group: "problem", text: "morreu (1)." }, "-"), "SRO Bot | morreu (1).");
  assert.equal(validToken("123456789:AAHk3t0kenDeTesteComTrintaECincoCh"), true);
  assert.equal(validToken("123456789"), false);
  assert.equal(validToken("abc:def"), false);
  const up = {
    ok: true,
    result: [
      { message: { chat: { id: 1, type: "private", first_name: "Antigo" } } },
      { message: { chat: { id: -5, type: "group", title: "grupo" } } },
      { message: { chat: { id: 42, type: "private", first_name: "Novo" } } },
      { edited_message: {} },
    ],
  };
  assert.deepEqual(chatFromUpdates(up), { id: 42, name: "Novo" });
  assert.equal(chatFromUpdates({ ok: true, result: [] }), undefined);
  assert.equal(chatFromUpdates({ ok: false, description: "Unauthorized" }), undefined);
  assert.equal(hideToken("fetch https://api.telegram.org/bot1:SEGREDO/getMe falhou", "1:SEGREDO"), "fetch https://api.telegram.org/bot***/getMe falhou");
});

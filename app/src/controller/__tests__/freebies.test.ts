import assert from "node:assert";
import { test } from "node:test";

import { type FreebiesSnapshot, luckyMoneyWindow, nextFreebieStep, payCardDay, payCardsToClaim } from "../freebies";

// Estado real em 2026-11-10 07:2x: 202 diario 0/1 gratis, 303 semanal e 401 mensal
// pegos, o resto pago; attendance de hoje pendente com 3 dias; caixinha liberada.
function snap(p: Partial<FreebiesSnapshot> = {}): FreebiesSnapshot {
  return {
    inWorld: true,
    donateAsks: [],
    firmNeeds: [],
    redPackets: [],
    guildProgress: 0,
    guildBoxes: [],
    packs: [
      { id: 202, price: 0, limit: 1, bought: 0, type: 2 },
      { id: 203, price: 29, limit: 5, bought: 0, type: 2 },
      { id: 303, price: 0, limit: 1, bought: 1, type: 3 },
      { id: 401, price: 0, limit: 1, bought: 1, type: 4 },
    ],
    todayChecked: false,
    dayChecked: 3,
    cumulativeDays: [7, 14, 21, 28],
    cumulativeTaken: 0,
    littleGift: 0,
    diamond: 3,
    silk: 393,
    ...p,
  };
}

test("gratis: pacote de preco 0, attendance e caixinha, um por vez; nunca pacote pago", () => {
  const tried = new Set<string>();
  const order: string[] = [];
  for (let i = 0; i < 10; i++) {
    const s = nextFreebieStep(snap(), tried, false);
    if (s.kind !== "act") break;
    tried.add(s.key);
    order.push(s.body);
  }
  assert.deepEqual(order, [
    "callsi XRechargeDocument BuyPackageLimitedTime 1 202 0",
    "calls XLoginRewardDocument ReqCheckin 0",
    "calls XWelfareDocument GetLittleGiftBag 0",
  ]);
  // So pacote pago sobrando: nada.
  const paid = snap({ packs: [{ id: 203, price: 29, limit: 5, bought: 0, type: 2 }], todayChecked: true, littleGift: 37773 });
  assert.equal(nextFreebieStep(paid, new Set(), false).kind, "done");
});

test("gratis: attendance so com o dia sem marcar e uma vez por dia (o re-sign e pago)", () => {
  const base = { packs: [], littleGift: 1 };
  assert.equal(nextFreebieStep(snap({ ...base, todayChecked: true }), new Set(), false).kind, "done");
  assert.equal(nextFreebieStep(snap({ ...base, todayChecked: undefined }), new Set(), false).kind, "done");
  // Leitura velha dizendo "pendente" depois de o app ja ter marcado hoje: nao pede.
  assert.equal(nextFreebieStep(snap({ ...base, todayChecked: false }), new Set(), true).kind, "done");
});

test("gratis: premio acumulado de 7 dias so com 7 marcados e o bit livre", () => {
  const base = { packs: [], todayChecked: true, littleGift: 1 };
  assert.equal(nextFreebieStep(snap({ ...base, dayChecked: 6 }), new Set(), false).kind, "done");
  const s = nextFreebieStep(snap({ ...base, dayChecked: 7 }), new Set(), false);
  assert.equal(s.kind === "act" && s.body, "callsi XLoginRewardDocument ReqCummulativeCheckin 1 7 0");
  assert.equal(nextFreebieStep(snap({ ...base, dayChecked: 7, cumulativeTaken: 1 << 7 }), new Set(), false).kind, "done");
  // Bits nao lidos (todos ligados) nao pedem nada.
  assert.equal(nextFreebieStep(snap({ ...base, dayChecked: 28, cumulativeTaken: 0xffffffff }), new Set(), false).kind, "done");
});

test("gratis: sem Diamond/Silk lidos nao pede nada (a conferencia de saldo depende deles)", () => {
  assert.equal(nextFreebieStep(snap({ diamond: undefined }), new Set(), false).kind, "fail");
  assert.equal(nextFreebieStep(snap({ silk: undefined }), new Set(), false).kind, "fail");
  assert.equal(nextFreebieStep(snap({ inWorld: false }), new Set(), false).kind, "fail");
  // Caixinha nao lida (padrao do jogo 1) nao pede.
  assert.equal(nextFreebieStep(snap({ packs: [], todayChecked: true, littleGift: undefined }), new Set(), false).kind, "done");
});

test("gratis: baus do sign-in da guilda conforme o progresso sobe no dia (caso de 2026-11-10)", () => {
  const boxes = [20, 40, 80, 120].map((need, index) => ({ index, need, open: false }));
  const base = { packs: [], todayChecked: true, littleGift: 1, guildBoxes: boxes };
  const tried = new Set<string>();
  const got: string[] = [];
  for (let i = 0; i < 6; i++) {
    const s = nextFreebieStep(snap({ ...base, guildProgress: 80 }), tried, false);
    if (s.kind !== "act") break;
    tried.add(s.key);
    got.push(s.body);
  }
  assert.deepEqual(got, [0, 1, 2].map((i) => `callsi XGuildSignInDocument ReqFetchBox 1 ${i} 0`));
  // Ja abertos (ou nao lidos, que contam como abertos): nada; o de 120 so com 120.
  const opened = boxes.map((b) => ({ ...b, open: b.need <= 80 }));
  const s80 = nextFreebieStep(snap({ ...base, guildBoxes: opened, guildProgress: 80 }), new Set(), false);
  assert.equal(s80.kind === "done" && s80.reason.includes("proximo bau com 120"), true);
  const s120 = nextFreebieStep(snap({ ...base, guildBoxes: opened, guildProgress: 120 }), new Set(), false);
  assert.equal(s120.kind === "act" && s120.body, "callsi XGuildSignInDocument ReqFetchBox 1 3 0");
});

test("gratis: red envelope da guilda (Lucky Money) so o que da pra pegar, uma vez por passada", () => {
  const base = { packs: [], todayChecked: true, littleGift: 1 };
  const reds = [{ uid: 501, canFetch: false }, { uid: 502, canFetch: true }];
  const s = nextFreebieStep(snap({ ...base, redPackets: reds }), new Set(), false);
  assert.equal(s.kind === "act" && s.body, "callx XGuildRedPacketDocument ReqFetch 1 -- u:502");
  assert.equal(nextFreebieStep(snap({ ...base, redPackets: reds }), new Set(["red502"]), false).kind, "done");
  assert.equal(nextFreebieStep(snap({ ...base, redPackets: [{ uid: 501, canFetch: false }] }), new Set(), false).kind, "done");
});

test("gratis: janela do Lucky Money e 20:00-22:15 do servidor (09:00-11:15 em Brasilia)", () => {
  const brt = (h: number, m: number) => Date.UTC(2026, 10, 10, h + 3, m);
  assert.equal(luckyMoneyWindow(brt(8, 59)), false);
  assert.equal(luckyMoneyWindow(brt(9, 0)), true);
  assert.equal(luckyMoneyWindow(brt(10, 31)), true);
  assert.equal(luckyMoneyWindow(brt(11, 14)), true);
  assert.equal(luckyMoneyWindow(brt(11, 15)), false);
  assert.equal(luckyMoneyWindow(brt(18, 0)), false);
});

test("gratis: doar no Support so com a opcao ligada, a outros membros, sem item do Firm do dia e dentro do limite", () => {
  // Pedidos reais de 2026-11-10 10:3x.
  const asks = [
    { id: 11, name: "Heroi", itemId: 410000045, need: 4, got: 0, have: 0 },
    { id: 12, name: "DeathGunX", itemId: 410000046, need: 4, got: 0, have: 0 },
    { id: 13, name: "DeathGunX", itemId: 410000040, need: 1, got: 0, have: 620 },
    { id: 14, name: "BalacaObama", itemId: 410000041, need: 3, got: 1, have: 345 },
  ];
  const base = { packs: [], todayChecked: true, littleGift: 1, me: "Heroi", donateAsks: asks, donatedToday: 0, donateLimit: 10 };
  assert.equal(nextFreebieStep(snap(base), new Set(), false).kind, "done"); // opcao desligada
  const tried = new Set<string>();
  const got: string[] = [];
  for (let i = 0; i < 5; i++) {
    const s = nextFreebieStep(snap(base), tried, false, true);
    if (s.kind !== "act") break;
    tried.add(s.key);
    got.push(s.body);
  }
  assert.deepEqual(got, [
    "callx XGuildDonateDocument SendDonateMemberItem 3 -- u:13 u:1 n:",
    "callx XGuildDonateDocument SendDonateMemberItem 3 -- u:14 u:2 n:",
  ]);
  // Item que o Firm do dia ainda precisa: nao doa. Limite do dia: respeita.
  assert.equal(nextFreebieStep(snap({ ...base, firmNeeds: [410000040, 410000041] }), new Set(), false, true).kind, "done");
  const s9 = nextFreebieStep(snap({ ...base, donatedToday: 9 }), new Set(["don13"]), false, true);
  assert.equal(s9.kind === "act" && s9.body, "callx XGuildDonateDocument SendDonateMemberItem 3 -- u:14 u:1 n:");
  assert.equal(nextFreebieStep(snap({ ...base, donatedToday: 10 }), new Set(), false, true).kind, "done");
  assert.equal(nextFreebieStep(snap({ ...base, donatedToday: undefined }), new Set(), false, true).kind, "done");
});

test("cartao de privilegio: o dia do premio vira as 05:00 do servidor (21:00 UTC no fuso 8)", () => {
  const antes = Date.UTC(2026, 10, 11, 20, 59, 59);
  const depois = Date.UTC(2026, 10, 11, 21, 0, 0);
  assert.equal(payCardDay(depois, 8) - payCardDay(antes, 8), 1);
  assert.equal(payCardDay(Date.UTC(2026, 10, 11, 18, 22), 8), 20768); // lido ao vivo em 2026-11-11
});

test("cartao de privilegio: so ativo e sem o premio de hoje (valores de 2026-11-11)", () => {
  const now = Date.UTC(2026, 10, 11, 18, 22);
  const premium = { id: 3, expire: 1796840425, lastFetch: 20698 };
  const silverVencido = { id: 1, expire: 1730041499, lastFetch: 20023 };
  assert.deepEqual(payCardsToClaim([silverVencido, premium], now, 8), [premium]);
  assert.deepEqual(payCardsToClaim([{ ...premium, lastFetch: 20768 }], now, 8), []);
  assert.deepEqual(payCardsToClaim([{ id: 9, expire: 1796840425, lastFetch: 0 }], now, 8), []); // id fora da tabela
});

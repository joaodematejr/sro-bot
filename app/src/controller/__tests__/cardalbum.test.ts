import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canUpgradeGroupStar,
  type CardAlbumConfig,
  type CardAlbumSnapshot,
  type CardGroupState,
  type CardMeta,
  cardQualityFromItemQuality,
  COMB_STATUS,
  computeCardSurplus,
  DEFAULT_CARDALBUM_CONFIG,
  neededCardsTotal,
  nextCardAlbumStep,
  parseStarFireCondition,
  reqActiveBody,
  reqBreakBody,
  reqUpStarBody,
  selectGroupBody,
} from "../cardalbum";

function snap(p: Partial<CardAlbumSnapshot> = {}): CardAlbumSnapshot {
  const cardMeta = new Map<number, CardMeta>([
    [6013, { cardId: 6013, groupId: 1, quality: "blue", name: "Tomb Stone" }],
    [6017, { cardId: 6017, groupId: 1, quality: "normal", name: "Old Weasel" }],
    [6004, { cardId: 6004, groupId: 1, quality: "gold", name: "Tiger" }],
    [6001, { cardId: 6001, groupId: 1, quality: "red", name: "Chakji" }],
    [6073, { cardId: 6073, groupId: 4, quality: "blue", name: "Ishutar Guard" }],
  ]);
  return {
    inWorld: true,
    inCombat: false,
    tablesLoaded: true,
    level: 98,
    groups: [],
    ownedCounts: new Map(),
    cardMeta,
    ...p,
  };
}

test("parseStarFireCondition decodifica fatias reais com multiplas cartas e quantidades por estrela", () => {
  // G4 Set[0] observado ao vivo: starPostion=[0,2,4], precisa 1 -> 2 -> 4 de 6073.
  const s0 = parseStarFireCondition(
    [[1, 0], [6073, 1], [1, 0], [6073, 2], [1, 0], [6073, 4]],
    [0, 2, 4],
    2,
  );
  assert.deepEqual(s0[0], [{ cardId: 6073, count: 1 }]);
  assert.deepEqual(s0[1], [{ cardId: 6073, count: 2 }]);
  assert.deepEqual(s0[2], [{ cardId: 6073, count: 4 }]);

  // G4 Set[8] observado ao vivo: starPostion=[0,3,6], 2 cartas por estrela.
  const s8 = parseStarFireCondition(
    [
      [2, 0], [6064, 1], [6068, 1],
      [2, 0], [6064, 2], [6068, 2],
      [2, 0], [6064, 4], [6068, 4],
    ],
    [0, 3, 6],
    2,
  );
  assert.deepEqual(s8[0], [{ cardId: 6064, count: 1 }, { cardId: 6068, count: 1 }]);
  assert.deepEqual(s8[1], [{ cardId: 6064, count: 2 }, { cardId: 6068, count: 2 }]);
  assert.deepEqual(s8[2], [{ cardId: 6064, count: 4 }, { cardId: 6068, count: 4 }]);
});

test("cardQualityFromItemQuality mascara byte baixo e mapeia ItemQuality 1..5", () => {
  assert.equal(cardQualityFromItemQuality(1), "normal");
  assert.equal(cardQualityFromItemQuality(260), "gold"); // 260 & 0xff === 4
  assert.equal(cardQualityFromItemQuality(285235713), "normal"); // & 0xff === 1
  assert.equal(cardQualityFromItemQuality(218126850), "blue"); // & 0xff === 2
  assert.equal(cardQualityFromItemQuality(3), "purple");
  assert.equal(cardQualityFromItemQuality(4), "gold");
  assert.equal(cardQualityFromItemQuality(5), "red");
  assert.equal(cardQualityFromItemQuality(0), undefined);
  assert.equal(cardQualityFromItemQuality(6), undefined);
});

test("neededCardsTotal soma requisitos pendentes ate StarLevelMAX e calcula sobras seguras", () => {
  const g1: CardGroupState = {
    groupId: 1,
    name: "Beginning",
    currentStar: 2,
    maxStar: 2,
    actionNum: 1,
    sets: [
      {
        setId: 1001,
        groupId: 1,
        status: COMB_STATUS.Activated,
        active: true,
        canActive: false,
        starRequirements: {
          0: [{ cardId: 6013, count: 1 }],
          1: [{ cardId: 6013, count: 1 }],
          2: [{ cardId: 6013, count: 1 }],
        },
      },
      {
        setId: 1002,
        groupId: 1,
        status: COMB_STATUS.NoCanActive,
        active: false,
        canActive: false,
        starRequirements: {
          2: [{ cardId: 6017, count: 1 }],
        },
      },
    ],
  };
  const g4: CardGroupState = {
    groupId: 4,
    name: "Hell",
    currentStar: 0,
    maxStar: 2,
    actionNum: 1,
    sets: [
      {
        setId: 4001,
        groupId: 4,
        status: COMB_STATUS.Activated,
        active: true,
        canActive: false,
        // 4001 ja ativado em 0*: falta 1* (2) + 2* (4) = 6 de 6073!
        starRequirements: {
          0: [{ cardId: 6073, count: 1 }],
          1: [{ cardId: 6073, count: 2 }],
          2: [{ cardId: 6073, count: 4 }],
        },
      },
    ],
  };

  const needed = neededCardsTotal([g1, g4]);
  assert.equal(needed.get(6013) ?? 0, 0); // grupo 1 em 2* MAX e 1001 ja ativo
  assert.equal(needed.get(6017), 1); // falta no 1002 em 2*
  assert.equal(needed.get(6073), 6); // falta 2 + 4 pras proximas estrelas

  const s = snap({
    groups: [g1, g4],
    ownedCounts: new Map([
      [6013, 3], // blue, precisa 0 -> sobra 3
      [6017, 4], // normal, precisa 1 -> sobra 3
      [6073, 6], // blue, precisa 6 -> sobra 0 (NAO quebra!)
      [6004, 5], // gold, precisa 0 -> filtrada fora por allowedQualities
    ]),
  });

  const surplus = computeCardSurplus(s, { allowedQualities: ["normal", "blue"] });
  assert.deepEqual(
    surplus.map((x) => [x.cardId, x.surplus]),
    [[6013, 3], [6017, 3]],
  );

  // targetGroupId=1 filtra a acao pro grupo 1 mas soma necessidade global (inclui g4).
  const g1Only = computeCardSurplus(s, { allowedQualities: ["normal", "blue"], targetGroupId: 1 });
  assert.deepEqual(g1Only.map((x) => x.cardId), [6013, 6017]);
});

test("fail-closed: sem tablesLoaded nao calcula sobras nem quebra cartas", () => {
  const s = snap({
    tablesLoaded: false,
    ownedCounts: new Map([[6013, 10]]),
  });
  assert.deepEqual(computeCardSurplus(s, DEFAULT_CARDALBUM_CONFIG), []);
  const step = nextCardAlbumStep(s, { ...DEFAULT_CARDALBUM_CONFIG, breakDuplicates: true }, new Set());
  assert.equal(step.kind, "fail");
});

test("ordem de execucao: ativar combinacao, depois subir estrela, depois quebrar excedentes", () => {
  const g: CardGroupState = {
    groupId: 1,
    name: "Beginning",
    currentStar: 1,
    maxStar: 2,
    actionNum: 0,
    breakLevels: [40, 50],
    sets: [
      {
        setId: 1001,
        groupId: 1,
        status: COMB_STATUS.CanActive,
        active: false,
        canActive: true,
        starRequirements: { 1: [{ cardId: 6013, count: 1 }], 2: [{ cardId: 6013, count: 1 }] },
      },
    ],
  };
  const cfg: CardAlbumConfig = { ...DEFAULT_CARDALBUM_CONFIG, breakDuplicates: true };

  // 1) Set pronto -> ativa antes de subir estrela ou quebrar (mesmo em combate).
  const step1 = nextCardAlbumStep(
    snap({ inCombat: true, groups: [g], ownedCounts: new Map([[6013, 5]]) }),
    cfg,
    new Set(),
  );
  assert.equal(step1.kind, "act");
  if (step1.kind === "act") {
    assert.equal(step1.op, "activate");
    assert.equal(step1.body, reqActiveBody(1001));
  }

  // 2) Todos sets ativos e ActionNum completo -> sobe estrela (Select + ReqUpStar).
  const gReadyUp: CardGroupState = {
    ...g,
    actionNum: 1,
    sets: [{ ...g.sets[0], status: COMB_STATUS.Activated, active: true, canActive: false }],
  };
  assert.equal(canUpgradeGroupStar(gReadyUp, 45), false); // BreakLevel[1] = 50
  assert.equal(canUpgradeGroupStar(gReadyUp, 50), true);
  const step2 = nextCardAlbumStep(snap({ level: 50, groups: [gReadyUp], ownedCounts: new Map([[6013, 4]]) }), cfg, new Set());
  assert.equal(step2.kind, "act");
  if (step2.kind === "act") {
    assert.equal(step2.op, "upgrade");
    assert.equal(step2.preBody, selectGroupBody(1));
    assert.equal(step2.body, reqUpStarBody());
  }

  // 3) Grupo ja em 2* MAX e tudo ativo -> quebra apenas as 4 sobras (precisa 0).
  const gMax: CardGroupState = { ...gReadyUp, currentStar: 2, maxStar: 2 };
  const step3 = nextCardAlbumStep(snap({ groups: [gMax], ownedCounts: new Map([[6013, 4]]) }), cfg, new Set());
  assert.equal(step3.kind, "act");
  if (step3.kind === "act") {
    assert.equal(step3.op, "break");
    assert.equal(step3.body, reqBreakBody(6013, 4));
  }

  // 4) Com tried contendo break -> conclui.
  const tried = new Set<string>(step3.kind === "act" ? [step3.key] : []);
  const step4 = nextCardAlbumStep(snap({ groups: [gMax], ownedCounts: new Map([[6013, 4]]) }), cfg, tried);
  assert.equal(step4.kind, "done");
});

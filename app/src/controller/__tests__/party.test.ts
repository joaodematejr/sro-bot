import assert from "node:assert";
import { test } from "node:test";

import {
  afterPartyStep,
  CREATE_RETRY_MS,
  findInviteCandidates,
  FOLLOW_LOST_WAIT_MS,
  FOLLOW_RETRY_MS,
  FOLLOW_TOGGLE_BODY,
  followLost,
  INVITE_EVERY_MS,
  inviteAllowed,
  inviteBody,
  newPartyMemory,
  nextPartyStep,
  type PartyState,
  parseNames,
  partyWanted,
  readParty,
} from "../party";
import { shouldLeaveTeam, type TeamConfig } from "../team";

const base: TeamConfig = { join: false, sameMapOnly: false };

test("corpo das operacoes de time: ReqTeamOp com 7 args e roleid de 64 bits", () => {
  assert.equal(FOLLOW_TOGGLE_BODY, "callx XTeamDocument ReqTeamOp 7 -- i:28 q:0 n i:1 s: i:0 u:0");
  assert.equal(inviteBody("4294967301"), "callx XTeamDocument ReqTeamOp 7 -- i:12 q:4294967301 n i:1 s: i:0 u:0");
  assert.throws(() => inviteBody("0"));
  assert.throws(() => inviteBody("12 i:1"));
});

test("nomes: virgula, ponto e virgula ou linha; sem repetir", () => {
  assert.deepEqual(parseNames(" Ana, bob;ana\nCarlos ,, "), ["Ana", "bob", "Carlos"]);
  assert.deepEqual(parseNames(""), []);
});

test("convite: so de quem a config aceita", () => {
  const inv = (from: string, relation: number) => ({ id: 7, from, relation });
  assert.equal(inviteAllowed(inv("Ana", 4), { ...base, acceptFrom: ["ana"] }), true);
  assert.equal(inviteAllowed(inv("Estranho", 4), { ...base, acceptFrom: ["ana"], acceptFriendsGuild: true }), false);
  assert.equal(inviteAllowed(inv("Colega", 2), { ...base, acceptFriendsGuild: true }), true);
  assert.equal(inviteAllowed(inv("Amigo", 1), { ...base, acceptFriendsGuild: true }), true);
  assert.equal(inviteAllowed(inv("Colega", 2), base), false);
  assert.equal(partyWanted(base), false);
  assert.equal(partyWanted({ ...base, follow: true }), true);
  assert.equal(partyWanted(undefined), false);
});

test("sem time: aceita o convite uma vez; senao cria (lider) com intervalo", () => {
  const cfg = { ...base, lead: true, acceptFrom: ["Ana"] };
  const st: PartyState = { inTeam: false, leader: false, invite: { id: 9, from: "Ana", relation: 4 } };
  let m = newPartyMemory();
  const a = nextPartyStep(st, cfg, m, 0);
  assert.equal(a.kind, "accept");
  m = afterPartyStep(m, a, 0);
  // Mesmo convite ainda na janela: nao aceita de novo, cria.
  const c = nextPartyStep(st, cfg, m, 0);
  assert.equal(c.kind, "create");
  m = afterPartyStep(m, c, 0);
  assert.equal(nextPartyStep({ inTeam: false, leader: false }, cfg, m, CREATE_RETRY_MS - 1).kind, "none");
  assert.equal(nextPartyStep({ inTeam: false, leader: false }, cfg, m, CREATE_RETRY_MS).kind, "create");
  // Sem lider na config: so espera.
  assert.equal(nextPartyStep({ inTeam: false, leader: false }, base, newPartyMemory(), 0).kind, "none");
});

test("lider com vaga: entrada automatica, pedidos e convites; cheio nao faz nada", () => {
  const cfg = { ...base, lead: true, openAutoJoin: true, acceptRequests: true, invite: ["Bob"] };
  const st: PartyState = { inTeam: true, leader: true, members: 2, total: 6, autoJoin: false, requests: 0 };
  let m = newPartyMemory();
  const T = 1_000_000;
  assert.equal(nextPartyStep(st, cfg, m, T + 0).kind, "autoJoin");
  m = afterPartyStep(m, { kind: "autoJoin" }, T + 0);
  const on = { ...st, autoJoin: true };
  assert.equal(nextPartyStep(on, cfg, m, T + 0).kind, "fetch");
  m = afterPartyStep(m, { kind: "fetch" }, T + 0);
  assert.deepEqual(nextPartyStep({ ...on, requests: 2 }, cfg, m, T + 1000), { kind: "acceptRequests", count: 2 });
  const inv = nextPartyStep(on, cfg, m, T + 1000);
  assert.deepEqual(inv, { kind: "invite", names: ["Bob"] });
  m = afterPartyStep(m, inv, T + 1000);
  assert.equal(nextPartyStep(on, cfg, m, T + 2000).kind, "none");
  assert.equal(nextPartyStep(on, cfg, m, T + 1000 + INVITE_EVERY_MS).kind, "fetch");
  assert.equal(nextPartyStep({ ...st, members: 6 }, cfg, newPartyMemory(), 0).kind, "none");
  // Lider sem a opcao (time de outro que caiu nele): nao mexe.
  assert.equal(nextPartyStep(st, base, newPartyMemory(), 0).kind, "none");
});

test("membro: segue o lider, espera a resposta e, depois de o jogo parar, espera mais", () => {
  const cfg = { ...base, follow: true };
  const st: PartyState = { inTeam: true, leader: false, members: 3, following: false };
  let m = newPartyMemory();
  const f = nextPartyStep(st, cfg, m, 0);
  assert.equal(f.kind, "follow");
  m = afterPartyStep(m, f, 0);
  assert.equal(nextPartyStep(st, cfg, m, FOLLOW_RETRY_MS - 1).kind, "none");
  assert.equal(nextPartyStep(st, cfg, m, FOLLOW_RETRY_MS).kind, "follow");
  assert.equal(nextPartyStep({ ...st, following: true }, cfg, m, FOLLOW_RETRY_MS).kind, "none");
  m = { ...m, followLostAt: 100000 };
  assert.equal(nextPartyStep(st, cfg, m, 100000 + FOLLOW_LOST_WAIT_MS - 1).kind, "none");
  assert.equal(nextPartyStep(st, cfg, m, 100000 + FOLLOW_LOST_WAIT_MS).kind, "follow");
  assert.equal(followLost(true, false), true);
  assert.equal(followLost(false, false), false);
  assert.equal(followLost(true, undefined), false);
});

test("lider sozinho no time nao sai (o sair-sozinho e do modo entrar)", () => {
  assert.equal(shouldLeaveTeam(1, { ...base, join: true }), true);
  assert.equal(shouldLeaveTeam(1, { ...base, join: true, lead: true }), false);
});

// Jogo falso pelos GETP que o readParty e o findInviteCandidates usam.
function fakeGame(v: Record<string, Record<string, unknown>>) {
  const sent: string[] = [];
  const q = async (tag: string, body: string): Promise<Record<string, unknown>> => {
    if (tag === "SKIL") {
      sent.push(body);
      return { ok: true };
    }
    return v[body] ?? { ok: false, erro: "campo nulo" };
  };
  return { q, sent };
}

test("le o convite aberto sem time; le o seguir como membro", async () => {
  const P = "TeamNotifyModalDlg m_CurrentInviteData";
  const g = fakeGame({
    "XTeamDocument get_bInTeam": { ok: true, bool: false },
    [`${P} inviteID`]: { ok: true, int: 77 },
    [`${P} invitorName`]: { ok: true, str: "Ana" },
    [`${P} invitorRelation m_Relation`]: { ok: true, int: 2 },
  });
  assert.deepEqual((await readParty(g.q, { ...base, acceptFriendsGuild: true })).invite, { id: 77, from: "Ana", relation: 2 });
  assert.equal((await readParty(g.q, base)).invite, null); // sem aceitar convite nao le
  const m = fakeGame({
    "XTeamDocument get_bInTeam": { ok: true, bool: true },
    "XTeamDocument get_bIsLeader": { ok: true, bool: false },
    "XTeamDocument _MyTeam members get_Count": { ok: true, int: 4 },
    "XTeamFightMgr get_IsFollowing": { ok: true, bool: true },
  });
  assert.deepEqual(await readParty(m.q, { ...base, follow: true }), { inTeam: true, leader: false, members: 4, following: true });
});

test("convidar: acha o nome nas listas do jogo e monta o roleid", async () => {
  const L = "XTeamInviteDocument m_InviteList";
  const g = fakeGame({
    [`${L} get_Count`]: { ok: true, int: 2 },
    [`${L} get_Item:0 name`]: { ok: true, str: "Outro" },
    [`${L} get_Item:1 name`]: { ok: true, str: "Bob" },
    [`${L} get_Item:1 uid`]: { ok: true, int: 5 },
    [`${L} get_Item:1 uid+4`]: { ok: true, int: 1 },
  });
  const r = await findInviteCandidates(g.q, ["bob"], async () => {});
  assert.deepEqual(r, [{ name: "Bob", roleId: "4294967301" }]);
  assert.equal(g.sent.length, 1); // achou na primeira lista (amigos), nao pede as outras
});

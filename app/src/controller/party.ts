// Party alem de entrar em time aberto: criar o time e manter cheio (lider),
// aceitar convite e seguir o lider (membro). Tudo pelos metodos do proprio jogo
// (ver engine/DISCOVERY.md, "Time (party)"). Logica pura; o Treino le o estado e
// manda os passos.
//
//   ReqTeamOp(op, param, o, memberType, account, refuseType, fromServerId):
//     1 CREATE (com o ajuste padrao do jogo pra cacar), 12 INVITE (param = roleid),
//     28 MEMBERS_FOLLOW_LEADER (liga/desliga: o servidor inverte o estado),
//     36 SET_AUTO_JOIN (liga/desliga), 38 JOIN_REQ_FETCH_LIST, 40 ACCEPT_ALL.
//   Convite recebido: TeamNotifyModalDlg m_CurrentInviteData (inviteID,
//     invitorName, invitorRelation m_Relation: 1 amigo, 2 guilda, 4 outro);
//     aceitar = _OnInviteAgreeBtnClick, o mesmo do botao (fecha a janela). Sem
//     resposta a janela recusa sozinha no fim do tempo.
//   Seguir: o "Follow" do jogo (XTeamFightMgr). Seguindo, o jogo troca a IA pela
//     AutoFight_Team: anda atras do lider (ate de mapa) e caca em volta dele. Quando
//     o seguir acaba (o lider entrou numa dungeon, trocou o lider, saiu do time) o
//     jogo desliga a IA: a caca precisa ser religada na hora.

import type { TeamConfig } from "./team";

type Query = (tag: string, body: string) => Promise<Record<string, unknown>>;

const teamOp = (op: number, param = "0") => `callx XTeamDocument ReqTeamOp 7 -- i:${op} q:${param} n i:1 s: i:0 u:0`;

export const CREATE_TEAM_BODY = teamOp(1);
export const FOLLOW_TOGGLE_BODY = teamOp(28);
export const AUTO_JOIN_TOGGLE_BODY = teamOp(36, "1");
export const FETCH_REQUESTS_BODY = teamOp(38);
export const ACCEPT_REQUESTS_BODY = teamOp(40);
export const ACCEPT_INVITE_BODY = "callp TeamNotifyModalDlg _OnInviteAgreeBtnClick 1";
export const CLOSE_TEAM_VIEW_BODY = "calls XTeamView SetVisible 2 0 1";

export function inviteBody(roleId: string): string {
  if (!/^[1-9]\d*$/.test(roleId)) throw new Error("roleid invalido");
  return teamOp(12, roleId);
}

// Lista de quem da pra convidar (o jogo so guarda quem esta livre): 3 amigos,
// 2 guilda, 1 mesmo mapa.
export const INVITE_LIST_TYPES = [3, 2, 1] as const;
export const inviteListBody = (type: number) => `callx XTeamInviteDocument ReqInviteList 1 -- i:${type}`;

export const RELATION_FRIEND = 1;
export const RELATION_GUILD = 2;

export interface PartyInvite {
  id: number;
  from: string;
  relation: number; // 1 amigo, 2 guilda, 4 outro
}

export interface PartyState {
  inTeam: boolean;
  leader: boolean;
  members?: number;
  total?: number;
  autoJoin?: boolean;
  requests?: number;
  following?: boolean;
  invite?: PartyInvite | null;
}

export interface PartyMemory {
  createAt: number;
  autoJoinAt: number;
  fetchAt: number;
  acceptReqAt: number;
  inviteAt: number;
  followAt: number;
  followLostAt: number;
  acceptedInvite: number; // id do ultimo convite aceito (nao repete)
}

export function newPartyMemory(): PartyMemory {
  const never = -Infinity;
  return { createAt: never, autoJoinAt: never, fetchAt: never, acceptReqAt: never, inviteAt: never, followAt: never, followLostAt: never, acceptedInvite: 0 };
}

export const CREATE_RETRY_MS = 60 * 1000;
export const AUTO_JOIN_RETRY_MS = 60 * 1000;
export const FETCH_EVERY_MS = 60 * 1000;
export const ACCEPT_REQ_RETRY_MS = 10 * 1000;
export const INVITE_EVERY_MS = 3 * 60 * 1000;
// O pedido de seguir e um liga/desliga: espera a resposta antes de pedir de novo.
export const FOLLOW_RETRY_MS = 30 * 1000;
// O jogo parou de seguir (lider numa dungeon, por exemplo): pedir de novo na hora
// so faria ligar e desligar.
export const FOLLOW_LOST_WAIT_MS = 2 * 60 * 1000;

export type PartyStep =
  | { kind: "none" }
  | { kind: "accept"; invite: PartyInvite }
  | { kind: "create" }
  | { kind: "autoJoin" }
  | { kind: "fetch" }
  | { kind: "acceptRequests"; count: number }
  | { kind: "invite"; names: string[] }
  | { kind: "follow" };

const norm = (s: string) => s.trim().toLowerCase();

export function parseNames(raw: string): string[] {
  const out: string[] = [];
  for (const n of raw.split(/[,;\n]/)) {
    const t = n.trim();
    if (t && !out.some((x) => norm(x) === norm(t))) out.push(t);
  }
  return out.slice(0, 20);
}

// Convite de quem a config aceita: nome da lista, ou amigo/guilda com a opcao ligada.
export function inviteAllowed(inv: PartyInvite, cfg: TeamConfig): boolean {
  if ((cfg.acceptFrom ?? []).some((n) => norm(n) === norm(inv.from))) return true;
  return !!cfg.acceptFriendsGuild && (inv.relation === RELATION_FRIEND || inv.relation === RELATION_GUILD);
}

export function partyWanted(cfg: TeamConfig | undefined): boolean {
  return !!cfg && (!!cfg.lead || !!cfg.follow || !!cfg.acceptFriendsGuild || (cfg.acceptFrom ?? []).length > 0);
}

export function nextPartyStep(st: PartyState, cfg: TeamConfig, m: PartyMemory, now: number): PartyStep {
  if (!st.inTeam) {
    if (st.invite && st.invite.id !== m.acceptedInvite && inviteAllowed(st.invite, cfg)) return { kind: "accept", invite: st.invite };
    if (cfg.lead && now - m.createAt >= CREATE_RETRY_MS) return { kind: "create" };
    return { kind: "none" };
  }
  if (st.leader) {
    if (!cfg.lead) return { kind: "none" };
    const free = st.members !== undefined && st.total !== undefined && st.members < st.total;
    if (!free) return { kind: "none" };
    if (cfg.openAutoJoin && st.autoJoin === false && now - m.autoJoinAt >= AUTO_JOIN_RETRY_MS) return { kind: "autoJoin" };
    if (cfg.acceptRequests) {
      if ((st.requests ?? 0) > 0 && now - m.acceptReqAt >= ACCEPT_REQ_RETRY_MS) return { kind: "acceptRequests", count: st.requests ?? 0 };
      if (now - m.fetchAt >= FETCH_EVERY_MS) return { kind: "fetch" };
    }
    if ((cfg.invite ?? []).length && now - m.inviteAt >= INVITE_EVERY_MS) return { kind: "invite", names: cfg.invite ?? [] };
    return { kind: "none" };
  }
  if (cfg.follow && st.following === false && now - m.followAt >= FOLLOW_RETRY_MS && now - m.followLostAt >= FOLLOW_LOST_WAIT_MS)
    return { kind: "follow" };
  return { kind: "none" };
}

export function afterPartyStep(m: PartyMemory, step: PartyStep, now: number): PartyMemory {
  switch (step.kind) {
    case "accept": return { ...m, acceptedInvite: step.invite.id };
    case "create": return { ...m, createAt: now };
    case "autoJoin": return { ...m, autoJoinAt: now };
    case "fetch": return { ...m, fetchAt: now };
    case "acceptRequests": return { ...m, acceptReqAt: now, fetchAt: now };
    case "invite": return { ...m, inviteAt: now };
    case "follow": return { ...m, followAt: now };
    default: return m;
  }
}

// Seguindo antes e agora nao: o jogo desligou a IA junto (StopFollow). Quem chama
// religa a caca e espera FOLLOW_LOST_WAIT_MS pra pedir de novo.
export function followLost(was: boolean | undefined, now: boolean | undefined): boolean {
  return was === true && now === false;
}

const num = (r: Record<string, unknown>) => (typeof r.int === "number" ? r.int : undefined);

// Le so o que a config usa. `following` so com seguir ligado (e membro).
export async function readParty(q: Query, cfg: TeamConfig): Promise<PartyState> {
  const inTeam = (await q("GETP", "XTeamDocument get_bInTeam")).bool === true;
  if (!inTeam) {
    let invite: PartyInvite | null = null;
    if (cfg.acceptFriendsGuild || (cfg.acceptFrom ?? []).length) {
      const P = "TeamNotifyModalDlg m_CurrentInviteData";
      const id = num(await q("GETP", `${P} inviteID`));
      if (id !== undefined && id !== 0) {
        const from = await q("GETP", `${P} invitorName`);
        invite = {
          id: id >>> 0,
          from: typeof from.str === "string" ? from.str : "",
          relation: num(await q("GETP", `${P} invitorRelation m_Relation`)) ?? 0,
        };
      }
    }
    return { inTeam, leader: false, invite };
  }
  const leader = (await q("GETP", "XTeamDocument get_bIsLeader")).bool === true;
  const members = num(await q("GETP", "XTeamDocument _MyTeam members get_Count"));
  if (leader) {
    if (!cfg.lead) return { inTeam, leader, members };
    const B = "XTeamDocument _MyTeam teamBrief";
    return {
      inTeam, leader, members,
      total: num(await q("GETP", `${B} totalMemberCount`)),
      autoJoin: cfg.openAutoJoin ? (await q("GETP", `${B} IsAutoJoin`)).bool === true : undefined,
      requests: cfg.acceptRequests ? num(await q("GETP", "XTeamDocument _joinList get_Count")) : undefined,
    };
  }
  const following = cfg.follow ? (await q("GETP", "XTeamFightMgr get_IsFollowing")).bool === true : undefined;
  return { inTeam, leader, members, following };
}

export interface InviteCandidate {
  name: string;
  roleId: string;
}

// Acha os nomes nas listas de convite do jogo (amigos, guilda, mapa). O jogo so
// poe na lista quem esta livre (sem time, fora de dungeon).
export async function findInviteCandidates(q: Query, names: string[], wait: (ms: number) => Promise<unknown>, max = 60): Promise<InviteCandidate[]> {
  const want = new Set(names.map(norm));
  const found = new Map<string, InviteCandidate>();
  for (const type of INVITE_LIST_TYPES) {
    if (found.size === want.size) break;
    await q("SKIL", inviteListBody(type));
    await wait(2500);
    const L = "XTeamInviteDocument m_InviteList";
    const n = Math.min(max, num(await q("GETP", `${L} get_Count`)) ?? 0);
    for (let i = 0; i < n; i++) {
      const it = `${L} get_Item:${i}`;
      const nr = await q("GETP", `${it} name`);
      const name = typeof nr.str === "string" ? nr.str : "";
      if (!want.has(norm(name)) || found.has(norm(name))) continue;
      const lo = num(await q("GETP", `${it} uid`)) ?? 0;
      const hi = num(await q("GETP", `${it} uid+4`)) ?? 0;
      const roleId = ((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)).toString();
      if (roleId !== "0") found.set(norm(name), { name, roleId });
    }
  }
  return [...found.values()];
}

export function partyStepText(step: PartyStep): string {
  switch (step.kind) {
    case "accept": return `aceitando o convite de time de ${step.invite.from || "?"}`;
    case "create": return "sem time: criando um (lider)";
    case "autoJoin": return "time com vaga: ligando a entrada automatica";
    case "fetch": return "";
    case "acceptRequests": return `aceitando ${step.count} pedido(s) de entrada no time`;
    case "invite": return "";
    case "follow": return "seguindo o lider (Follow do jogo; a caca segue ligada)";
    default: return "";
  }
}

// 离线问题包的指纹识别与字段级合并逻辑（纯函数，便于测试与复用）

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type EventKind = 'created' | 'status' | 'note' | 'merge' | 'import';

export interface AuditIssue {
  id: string;
  fingerprint: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  evidence: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  retestInvalid: boolean;
  updatedAt: string;
}
export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  kind: EventKind;
  status?: IssueStatus;
  fingerprint?: string;
  message: string;
}
export interface ConflictRecord {
  id: string;
  at: string;
  issueId: string;
  fingerprint: string;
  packageId: string;
  localStatus: IssueStatus;
  incomingStatus: IssueStatus;
  resolvedStatus: IssueStatus;
}
export interface ImportRecord {
  at: string;
  issues: Record<string, { at: string; result: 'created' | 'merged' }>;
}
export interface WorkbenchState {
  issues: AuditIssue[];
  events: AuditEvent[];
  conflicts: ConflictRecord[];
  imports: Record<string, ImportRecord>;
}

export interface PackagedIssue {
  fingerprint: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  evidence: string;
  severity: Severity;
  status: IssueStatus;
  fixNote: string;
  retestNote: string;
  retestInvalid: boolean;
  updatedAt: string;
}
export interface IssuePackage {
  packageId: string;
  exportedAt: string;
  source: string;
  issues: PackagedIssue[];
  events: AuditEvent[];
}
export interface ImportResult {
  packageId: string;
  at: string;
  created: number;
  merged: number;
  conflicts: number;
  skipped: number;
  errors: string[];
}

export const SEV_RANK: Record<Severity, number> = { minor: 0, moderate: 1, serious: 2, critical: 3 };

// 合法状态流转：较新的有效流转才会决定合并后的当前状态
export const FLOW: Record<IssueStatus, IssueStatus[]> = {
  open: ['triaged', 'fixing', 'verifying', 'closed', 'reopened'],
  triaged: ['fixing', 'verifying', 'closed', 'reopened'],
  fixing: ['verifying', 'closed', 'reopened'],
  verifying: ['closed', 'reopened'],
  closed: ['reopened', 'triaged', 'fixing', 'verifying'],
  reopened: ['triaged', 'fixing', 'verifying', 'closed']
};

// 稳定的问题指纹：标题 + 业务流程归一化后取哈希
export function fingerprintOf(title: string, flow: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return 'fp:' + cyrb53(norm(title) + '|' + norm(flow));
}
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// 行级并集：保留两边各自新增的复现步骤 / 证据，不整条覆盖
export function unionLines(a: string, b: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...a.split('\n'), ...(b ?? '').split('\n')]) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join('\n');
}
// 人群并集：两边新增的影响人群都保留
export function unionGroups(a: string, b: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...a.split(/[、,，;；]/), ...(b ?? '').split(/[、,，;；]/)]) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join('、');
}

const rid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export interface StatusResolution {
  status: IssueStatus;
  conflict?: { localStatus: IssueStatus; incomingStatus: IssueStatus; resolvedStatus: IssueStatus };
}

// 按操作时间线解析合并后的状态：较新的有效流转决定当前状态，较早的写入作为冲突记录
export function resolveMergedStatus(state: WorkbenchState, local: AuditIssue, incoming: PackagedIssue): StatusResolution {
  const all = [
    ...state.events.filter((e) => e.issueId === local.id && e.kind === 'status' && e.status).map((e) => ({ at: e.at, status: e.status! })),
    ...state.events.filter((e) => e.fingerprint === incoming.fingerprint && e.kind === 'status' && e.status).map((e) => ({ at: e.at, status: e.status! }))
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (all.length === 0) return { status: local.status };
  let cur: IssueStatus = 'open';
  for (const tr of all) {
    if (tr.status === cur) continue;
    if (FLOW[cur].includes(tr.status)) cur = tr.status;
  }
  const conflict = local.status !== incoming.status
    ? { localStatus: local.status, incomingStatus: incoming.status, resolvedStatus: cur }
    : undefined;
  return { status: cur, conflict };
}

// 导入问题包：按指纹认出同一处缺陷，字段级合并，失败可重试且不重复建记录。
// 返回新的工作台状态与导入结果；纯函数，不修改入参。
export function mergePackage(prev: WorkbenchState, pkg: IssuePackage): { state: WorkbenchState; result: ImportResult } {
  const state: WorkbenchState = structuredClone(prev);
  const result: ImportResult = { packageId: pkg.packageId, at: new Date().toISOString(), created: 0, merged: 0, conflicts: 0, skipped: 0, errors: [] };
  const seen = state.imports[pkg.packageId];
  const applied: Record<string, { at: string; result: 'created' | 'merged' }> = { ...(seen?.issues ?? {}) };

  // 先并入包内事件（按 id 去重），供状态时间线裁决使用
  const existingEventIds = new Set(state.events.map((e) => e.id));
  for (const e of pkg.events ?? []) {
    if (!existingEventIds.has(e.id)) state.events.push(e);
  }

  for (const incoming of pkg.issues) {
    try {
      // 幂等：同一包同一指纹已处理过则跳过，重试只补没合进去的部分
      if (applied[incoming.fingerprint]) { result.skipped++; continue; }
      const local = state.issues.find((i) => i.fingerprint === incoming.fingerprint);
      if (!local) {
        const id = rid();
        const issue: AuditIssue = {
          id,
          fingerprint: incoming.fingerprint,
          title: incoming.title,
          flow: incoming.flow,
          steps: incoming.steps,
          impactGroup: incoming.impactGroup,
          evidence: incoming.evidence ?? '',
          severity: incoming.severity,
          status: incoming.status,
          fixNote: incoming.fixNote ?? '',
          retestNote: incoming.retestNote ?? '',
          retestInvalid: incoming.retestInvalid ?? false,
          updatedAt: incoming.updatedAt ?? new Date().toISOString()
        };
        state.issues.unshift(issue);
        state.events.unshift({ id: rid(), at: result.at, issueId: id, kind: 'import', fingerprint: incoming.fingerprint, message: `离线包导入：新建问题（包 ${pkg.packageId.slice(0, 8)}）` });
        applied[incoming.fingerprint] = { at: result.at, result: 'created' };
        result.created++;
      } else {
        const patch: Partial<AuditIssue> = {};
        // 字段级合并：两边新增的复现步骤、影响人群、证据都保留，不整条覆盖
        patch.steps = unionLines(local.steps, incoming.steps);
        patch.impactGroup = unionGroups(local.impactGroup, incoming.impactGroup);
        patch.evidence = unionLines(local.evidence ?? '', incoming.evidence ?? '');
        patch.fixNote = unionLines(local.fixNote, incoming.fixNote ?? '');
        patch.severity = SEV_RANK[incoming.severity] > SEV_RANK[local.severity] ? incoming.severity : local.severity;

        const { status, conflict } = resolveMergedStatus(state, local, incoming);
        patch.status = status;

        // 复测结论：关闭后重新打开，旧结论立即失效
        const wasClosed = local.status === 'closed';
        if (status === 'closed') {
          patch.retestInvalid = false;
          const note = incoming.status === 'closed' ? incoming.retestNote : local.retestNote;
          if (note) patch.retestNote = note;
        } else if (status === 'reopened') {
          const note = incoming.status === 'reopened' ? (incoming.retestNote ?? '') : local.retestNote;
          if (note) { patch.retestNote = note; patch.retestInvalid = false; }
          else { patch.retestInvalid = true; }
          if (wasClosed) state.events.unshift({ id: rid(), at: result.at, issueId: local.id, kind: 'note', message: `原复测通过结论已失效：${local.retestNote || '（无记录）'}` });
        }

        Object.assign(local, patch, { updatedAt: result.at });

        if (conflict) {
          state.conflicts.unshift({
            id: rid(),
            at: result.at,
            issueId: local.id,
            fingerprint: local.fingerprint,
            packageId: pkg.packageId,
            localStatus: conflict.localStatus,
            incomingStatus: conflict.incomingStatus,
            resolvedStatus: conflict.resolvedStatus
          });
          state.events.unshift({ id: rid(), at: result.at, issueId: local.id, kind: 'merge', fingerprint: local.fingerprint, message: `状态冲突已裁决：本地「${conflict.localStatus}」vs 离线包「${conflict.incomingStatus}」，采用「${conflict.resolvedStatus}」` });
          result.conflicts++;
        } else {
          state.events.unshift({ id: rid(), at: result.at, issueId: local.id, kind: 'merge', fingerprint: local.fingerprint, message: `离线包字段已合并（包 ${pkg.packageId.slice(0, 8)}）` });
        }
        applied[incoming.fingerprint] = { at: result.at, result: 'merged' };
        result.merged++;
      }
    } catch (e) {
      result.errors.push(`${incoming.fingerprint}: ${(e as Error).message}`);
    }
  }
  state.imports[pkg.packageId] = { at: result.at, issues: applied };
  return { state, result };
}

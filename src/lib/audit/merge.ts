import { fingerprintOf, normalizeText } from './fingerprint';
import type {
  AuditEvent,
  AuditIssue,
  ConflictRecord,
  Contribution,
  ImportReport,
  IssuePackage,
  IssueStatus,
  RetestRecord,
  StatusTransition,
  WorkbenchState
} from './types';

/** 允许的状态流转边；对着已分叉的旧状态写入会被判为无效流转 */
const ALLOWED_EDGES: Record<IssueStatus, IssueStatus[]> = {
  open: ['triaged', 'fixing', 'verifying', 'closed'],
  triaged: ['fixing', 'verifying', 'closed', 'reopened'],
  fixing: ['verifying', 'triaged', 'closed', 'reopened'],
  verifying: ['closed', 'reopened', 'fixing', 'triaged'],
  closed: ['reopened'],
  reopened: ['triaged', 'fixing', 'verifying', 'closed']
};

export function isValidTransition(from: IssueStatus, to: IssueStatus): boolean {
  return ALLOWED_EDGES[from]?.includes(to) ?? false;
}

let uidCounter = 0;
export function uid(prefix = 'id'): string {
  uidCounter += 1;
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}-${uidCounter.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 一次重新打开之后，该时间点及之前的复测结论全部失效 */
export function latestReopenAt(issue: AuditIssue, onlyApplied = false): string | null {
  const candidates = issue.transitions
    .filter((t) => t.to === 'reopened' && (!onlyApplied || t.applied !== false))
    .map((t) => Date.parse(t.at))
    .filter((n) => !Number.isNaN(n));
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates)).toISOString();
}

export function evaluateRetests(issue: AuditIssue): { retests: RetestRecord[]; invalidated: number } {
  const reopenAt = latestReopenAt(issue, true);
  let invalidated = 0;
  const retests = issue.retests.map((record) => {
    const shouldBeValid = reopenAt === null || Date.parse(record.at) > Date.parse(reopenAt);
    if (record.valid && !shouldBeValid) invalidated += 1;
    return { ...record, valid: shouldBeValid };
  });
  return { retests, invalidated };
}

/**
 * 从双方流转时间线重放当前状态。
 * 两机同源时，分叉前的流转 ID 相同（共享前缀），重放从分叉点开始；
 * 只承认有效流转，两侧写入不同状态时按操作时间排出先后，较新的有效流转决定当前状态。
 */
export function replayStatus(
  fallbackBase: IssueStatus,
  local: StatusTransition[],
  incoming: StatusTransition[]
): { status: IssueStatus; applied: Map<string, boolean>; divergences: Array<[StatusTransition, StatusTransition, string]> } {
  const applied = new Map<string, boolean>();
  const byId = new Map<string, StatusTransition>();
  for (const transition of [...local, ...incoming]) byId.set(transition.id, transition);
  const sharedIds = new Set(local.filter((t) => incoming.some((r) => r.id === t.id)).map((t) => t.id));

  type Marked = StatusTransition & { side: 'local' | 'incoming' };
  const mark = (transition: StatusTransition): Marked => ({
    ...transition,
    side: local.some((l) => l.id === transition.id) ? 'local' : 'incoming'
  });

  // 创建问题的初始流转不参与冲突，直接视为已应用
  const isCreation = (transition: StatusTransition) => transition.from === null && transition.to === 'open';
  for (const transition of byId.values()) {
    if (isCreation(transition)) applied.set(transition.id, true);
  }

  const shared = [...sharedIds].map((id) => byId.get(id)!).filter((t) => !isCreation(t))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  shared.forEach((transition) => applied.set(transition.id, true));

  // 分叉点：最后一条共享流转的目标状态；两侧无共同历史时回退到最早流转的起点
  let running: IssueStatus = shared.at(-1)?.to ?? fallbackBase;
  if (shared.length === 0) {
    const earliest = [...local, ...incoming].filter((t) => !isCreation(t))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    running = earliest?.from ?? fallbackBase;
  }

  const divergences: Array<[StatusTransition, StatusTransition, string]> = [];
  const pending: Partial<Record<Marked['side'], Marked>> = {};

  const merged = [...local, ...incoming]
    .filter((t, index, all) => all.findIndex((candidate) => candidate.id === t.id) === index)
    .filter((t) => !sharedIds.has(t.id) && !isCreation(t))
    .map(mark)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));

  for (const transition of merged) {
    const otherSide = transition.side === 'local' ? 'incoming' : 'local';
    const anchor = pending[otherSide];

    // 两边都写入了相同状态：幂等空操作，不产生冲突
    if (transition.to === running) {
      applied.set(transition.id, true);
      pending[transition.side] = transition;
      continue;
    }
    if (isValidTransition(running, transition.to)) {
      if (anchor && anchor.to !== transition.to) {
        // 两边写入不同状态：较新的有效流转决定当前状态，较早的一条留档可见
        const [older, newer] = Date.parse(anchor.at) <= Date.parse(transition.at) ? [anchor, transition] : [transition, anchor];
        divergences.push([older, newer, `两边写入不同状态，较新的「${statusLabel(newer.to)}」生效，较早的「${statusLabel(older.to)}」留档为冲突记录`]);
        applied.set(older.id, true);
        pending[transition.side] = undefined;
        pending[otherSide] = undefined;
      } else {
        pending[transition.side] = transition;
      }
      running = transition.to;
      applied.set(transition.id, true);
    } else {
      // 基于已分叉旧状态的写入：不是有效流转，不能决定当前状态
      applied.set(transition.id, false);
      if (anchor) {
        divergences.push([
          transition,
          anchor,
          `该流转基于已分叉的旧状态 ${statusLabel(transition.from ?? running)}，不是有效流转，未改变当前状态「${statusLabel(running)}」`
        ]);
        pending[transition.side] = undefined;
        pending[otherSide] = undefined;
      }
    }
  }
  return { status: running, applied, divergences };
}

export function statusLabel(status: IssueStatus): string {
  const labels: Record<IssueStatus, string> = {
    open: '待分诊',
    triaged: '已确认',
    fixing: '修复中',
    verifying: '待复测',
    closed: '已关闭',
    reopened: '重新打开'
  };
  return labels[status];
}

function dedupContributions(existing: Contribution[], additions: Contribution[]): Contribution[] {
  // 按贡献条 ID 去重：ID 相同才是同一条；两台机器各自新增的内容即使文本/来源相同也都要保留
  const map = new Map<string, Contribution>();
  for (const item of [...existing, ...additions]) {
    if (!item || typeof item.text !== 'string' || normalizeText(item.text) === '') continue;
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
}

function dedupRetests(existing: RetestRecord[], additions: RetestRecord[]): RetestRecord[] {
  const map = new Map<string, RetestRecord>();
  for (const item of [...existing, ...additions]) {
    const held = map.get(item.id);
    if (!held || (!held.valid && item.valid)) map.set(item.id, item);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function dedupTransitions(existing: StatusTransition[], additions: StatusTransition[], applied: Map<string, boolean>): StatusTransition[] {
  const map = new Map<string, StatusTransition>();
  for (const item of [...existing, ...additions]) {
    const merged = { ...item };
    if (applied.has(item.id)) merged.applied = applied.get(item.id);
    if (!map.has(item.id)) map.set(item.id, merged);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('::');
}

function makeConflict(issue: AuditIssue, older: StatusTransition, newer: StatusTransition, resolution: string, packageId: string): ConflictRecord {
  return {
    id: uid('conflict'),
    issueId: issue.id,
    issueTitle: issue.title,
    fingerprint: issue.fingerprint,
    pairKey: pairKey(older.id, newer.id),
    at: new Date().toISOString(),
    newer: { transitionId: newer.id, to: newer.to, at: newer.at, origin: newer.origin, note: newer.note },
    older: { transitionId: older.id, to: older.to, at: older.at, origin: older.origin, note: older.note },
    resolution,
    packageId
  };
}

function addEvent(events: AuditEvent[], issueId: string, message: string): AuditEvent[] {
  return [{ id: uid('event'), at: nowIso(), issueId, message }, ...events];
}

function mergeIssue(existing: AuditIssue, incoming: AuditIssue, state: WorkbenchState, pack: IssuePackage): {
  issue: AuditIssue;
  newConflicts: ConflictRecord[];
  events: AuditEvent[];
  invalidatedRetests: number;
  changed: boolean;
} {
  const existingIds = {
    steps: new Set(existing.steps.map((c) => c.id)),
    impact: new Set(existing.impactGroups.map((c) => c.id)),
    evidence: new Set(existing.evidence.map((c) => c.id)),
    transitions: new Set(existing.transitions.map((t) => t.id)),
    retests: new Set(existing.retests.map((r) => r.id))
  };
  const changed = incoming.transitions.some((t) => !existingIds.transitions.has(t.id))
    || incoming.steps.some((c) => !existingIds.steps.has(c.id))
    || incoming.impactGroups.some((c) => !existingIds.impact.has(c.id))
    || incoming.evidence.some((c) => !existingIds.evidence.has(c.id))
    || incoming.retests.some((r) => !existingIds.retests.has(r.id));

  // 字段级合并：两边各自新增的复现步骤、影响人群、证据全部保留，不用整条覆盖
  const combined: AuditIssue = {
    ...existing,
    steps: dedupContributions(existing.steps, incoming.steps),
    impactGroups: dedupContributions(existing.impactGroups, incoming.impactGroups),
    evidence: dedupContributions(existing.evidence, incoming.evidence),
    retests: dedupRetests(existing.retests, incoming.retests),
    transitions: [...existing.transitions, ...incoming.transitions].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    sources: Array.from(new Set([...existing.sources, ...incoming.sources])),
    canonicalId: existing.canonicalId ?? incoming.canonicalId,
    title: existing.title,
    flow: existing.flow,
    severity: existing.severity
  };

  // 状态按双方操作时间线仲裁
  const replay = replayStatus(existing.status, existing.transitions, incoming.transitions);
  combined.transitions = dedupTransitions(existing.transitions, incoming.transitions, replay.applied);
  combined.status = replay.status;

  // 再次打开后旧复测结论立即失效
  const evaluated = evaluateRetests(combined);
  combined.retests = evaluated.retests;

  const knownPairKeys = new Set(state.conflicts.map((conflict) => conflict.pairKey));
  const newConflicts: ConflictRecord[] = [];
  for (const [older, newer, resolution] of replay.divergences) {
    if (knownPairKeys.has(pairKey(older.id, newer.id))) continue;
    const conflict = makeConflict(combined, older, newer, resolution, pack.packageId);
    knownPairKeys.add(conflict.pairKey);
    newConflicts.push(conflict);
  }

  const lastActivity = combined.transitions.at(-1)?.at
    ?? [...combined.steps, ...combined.impactGroups, ...combined.evidence].at(-1)?.addedAt
    ?? combined.updatedAt;
  combined.updatedAt = [existing.updatedAt, incoming.updatedAt, lastActivity]
    .filter(Boolean)
    .sort()
    .at(-1) as string;

  let events = state.events;
  if (changed) {
    events = addEvent(events, existing.id, `已合并来自「${pack.origin}」的现场更新：新增复现步骤、影响人群、证据或状态流转均按字段保留`);
  }
  for (const conflict of newConflicts) {
    events = addEvent(events, existing.id, `状态冲突：${conflict.resolution}`);
  }
  if (evaluated.invalidated > 0) {
    events = addEvent(events, existing.id, `问题重新打开，${evaluated.invalidated} 条旧复测结论已失效`);
  }
  return { issue: combined, newConflicts, events, invalidatedRetests: evaluated.invalidated, changed };
}

export function validatePack(raw: unknown): IssuePackage {
  if (!raw || typeof raw !== 'object') throw new Error('问题包格式不正确：不是有效的 JSON 文件');
  const pack = raw as Partial<IssuePackage>;
  if (pack.format !== 'a11y-audit-pack' || pack.version !== 1) {
    throw new Error('问题包格式不正确：缺少 a11y-audit-pack/v1 标识');
  }
  if (!pack.packageId || typeof pack.packageId !== 'string') throw new Error('问题包缺少 packageId');
  if (!pack.origin || typeof pack.origin !== 'string') throw new Error('问题包缺少现场来源标识');
  if (!Array.isArray(pack.issues)) throw new Error('问题包不包含问题列表');
  return pack as IssuePackage;
}

/**
 * 导入并合并一个现场问题包。
 * - 指纹相同即同一处缺陷，做字段级合并，绝不整条覆盖
 * - 两边状态冲突按时间线仲裁，旧流转进入冲突记录
 * - 重新打开使旧复测结论失效
 * - 已完整导入的包直接跳过；重试时只处理检查点之外、尚未合入的问题
 */
export function applyPackage(state: WorkbenchState, rawPack: IssuePackage): { state: WorkbenchState; report: ImportReport } {
  const pack = validatePack(rawPack);
  const known = state.importedPackages.find((meta) => meta.packageId === pack.packageId);
  if (known && known.appliedIssueIds.length >= pack.issues.length) {
    return {
      state,
      report: { skipped: true, added: 0, merged: 0, conflicts: 0, invalidatedRetests: 0, packageId: pack.packageId, origin: pack.origin }
    };
  }

  const checkpoint = new Set(known?.appliedIssueIds ?? []);
  let issues = [...state.issues];
  let events = state.events;
  let conflicts = [...state.conflicts];
  let added = 0;
  let merged = 0;
  let conflictCount = 0;
  let invalidatedRetests = 0;
  const appliedIssueIds = [...checkpoint];

  for (const incoming of pack.issues) {
    if (checkpoint.has(incoming.id)) continue; // 重试：跳过已经合入的问题，只补缺口

    // 同 ID（同源机器的快照）优先；否则按问题指纹认出同一处缺陷
    const matchIndex = issues.findIndex((candidate) => candidate.id === incoming.id);
    const fingerprintIndex = matchIndex >= 0 ? -1 : issues.findIndex((candidate) => candidate.fingerprint === incoming.fingerprint);
    const targetIndex = matchIndex >= 0 ? matchIndex : fingerprintIndex;

    if (targetIndex >= 0) {
      const result = mergeIssue(issues[targetIndex], incoming, { ...state, issues, events, conflicts }, pack);
      issues = issues.map((issue, index) => (index === targetIndex ? result.issue : issue));
      events = result.events;
      conflicts = [...conflicts, ...result.newConflicts];
      conflictCount += result.newConflicts.length;
      invalidatedRetests += result.invalidatedRetests;
      if (result.changed) merged += 1;
    } else {
      const evaluated = evaluateRetests(incoming);
      const fresh: AuditIssue = {
        ...incoming,
        retests: evaluated.retests,
        sources: Array.from(new Set([...incoming.sources, pack.origin])),
        // 包内新问题的当前状态由其最后一条流转决定
        status: incoming.transitions.at(-1)?.to ?? incoming.status
      };
      issues = [fresh, ...issues];
      events = addEvent(events, fresh.id, `从「${pack.origin}」现场包导入新问题（指纹 ${fresh.fingerprint}）`);
      invalidatedRetests += evaluated.invalidated;
      added += 1;
    }
    appliedIssueIds.push(incoming.id);
  }

  const meta = known
    ? { ...known, appliedIssueIds, issueCount: pack.issues.length, importedAt: nowIso() }
    : {
        packageId: pack.packageId,
        origin: pack.origin,
        exportedAt: pack.exportedAt,
        importedAt: nowIso(),
        issueCount: pack.issues.length,
        appliedIssueIds
      };
  const importedPackages = [meta, ...state.importedPackages.filter((item) => item.packageId !== pack.packageId)];

  return {
    state: { ...state, issues, events, conflicts, importedPackages },
    report: { skipped: false, added, merged, conflicts: conflictCount, invalidatedRetests, packageId: pack.packageId, origin: pack.origin }
  };
}

/** 现场断网时导出问题包：只含本机问题的快照，可离线拷走 */
export function buildPackage(state: WorkbenchState, origin: string, exportedAt = nowIso()): IssuePackage {
  return {
    format: 'a11y-audit-pack',
    version: 1,
    packageId: uid('pack'),
    origin,
    exportedAt,
    issues: state.issues.map((issue) => structuredClone(issue))
  };
}

export function recomputeIssueStatus(issue: AuditIssue): AuditIssue {
  const appliedTransitions = issue.transitions.filter((t) => t.applied !== false);
  const last = appliedTransitions.at(-1);
  const status = last?.to ?? issue.status;
  const evaluated = evaluateRetests({ ...issue, status });
  return { ...issue, status, retests: evaluated.retests };
}

export { fingerprintOf };

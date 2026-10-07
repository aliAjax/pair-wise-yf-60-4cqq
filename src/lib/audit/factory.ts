import { fingerprintOf } from './fingerprint';
import { nowIso, recomputeIssueStatus, uid } from './merge';
import type {
  AuditEvent,
  AuditIssue,
  Contribution,
  IssueStatus,
  RetestRecord,
  Severity,
  StatusTransition,
  WorkbenchState
} from './types';

export function contribution(text: string, origin: string, addedAt = nowIso()): Contribution {
  return { id: uid('contrib'), text, addedAt, origin };
}

export function transition(to: IssueStatus, origin: string, note: string, options: { from?: IssueStatus | null; at?: string } = {}): StatusTransition {
  return { id: uid('trans'), at: options.at ?? nowIso(), from: options.from ?? null, to, note, origin };
}

export function retest(passed: boolean, note: string, origin: string, at = nowIso()): RetestRecord {
  return { id: uid('retest'), at, passed, note, origin, valid: true };
}

export function createIssue(input: {
  title: string;
  flow: string;
  stepsText: string;
  impactGroup: string;
  severity: Severity;
  evidenceText?: string;
}, origin: string, at = nowIso()): AuditIssue {
  const steps = [contribution(input.stepsText, origin, at)];
  const impactGroups = [contribution(input.impactGroup, origin, at)];
  const evidence = input.evidenceText ? [contribution(input.evidenceText, origin, at)] : [];
  const issue: AuditIssue = {
    id: uid('issue'),
    fingerprint: fingerprintOf({ title: input.title, flow: input.flow, stepsText: input.stepsText }),
    title: input.title,
    flow: input.flow,
    severity: input.severity,
    steps,
    impactGroups,
    evidence,
    transitions: [{ id: uid('trans'), at, from: null, to: 'open', note: '审计员创建问题并保存证据', origin, applied: true }],
    retests: [],
    sources: [origin],
    status: 'open',
    createdAt: at,
    updatedAt: at
  };
  return issue;
}

function seedIssue(
  id: string,
  title: string,
  flow: string,
  stepsText: string,
  impactGroup: string,
  severity: Severity,
  status: IssueStatus,
  origin: string,
  minutesAgo: number,
  extra?: { transitionNote: string; retest?: RetestRecord }
): AuditIssue {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const creationAt = new Date(Date.now() - (minutesAgo + 120) * 60_000).toISOString();
  const issue: AuditIssue = {
    id,
    fingerprint: fingerprintOf({ title, flow, stepsText }),
    title,
    flow,
    severity,
    steps: [{ id: `${id}-step-1`, text: stepsText, addedAt: creationAt, origin }],
    impactGroups: [{ id: `${id}-impact-1`, text: impactGroup, addedAt: creationAt, origin }],
    evidence: [],
    transitions: [
      { id: `${id}-t0`, at: creationAt, from: null, to: 'open', note: '审计员创建问题', origin, applied: true },
      { id: `${id}-t1`, at, from: 'open', to: status, note: extra?.transitionNote ?? '状态流转', origin, applied: true }
    ],
    retests: extra?.retest ? [extra.retest] : [],
    sources: [origin],
    status,
    createdAt: creationAt,
    updatedAt: at
  };
  return recomputeIssueStatus(issue);
}

export const STORAGE_KEY = 'a11y-audit-v2';
const LEGACY_KEY = 'a11y-audit-v1';
export const DEFAULT_ORIGIN = '办公室工作台';

export function seedState(): WorkbenchState {
  const origin = DEFAULT_ORIGIN;
  const issues = [
    seedIssue(
      'issue-1',
      '结算弹窗关闭后焦点丢失',
      '订单结算',
      '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
      '键盘与读屏用户',
      'serious',
      'triaged',
      origin,
      60,
      { transitionNote: '审核员确认问题有效并进入修复中' }
    ),
    seedIssue(
      'issue-2',
      '错误提示未与输入框关联',
      '账户设置',
      '输入无效手机号后使用读屏读取输入框',
      '读屏用户',
      'moderate',
      'fixing',
      origin,
      120,
      { transitionNote: '开发人员提交焦点管理修复' }
    )
  ];
  const events: AuditEvent[] = [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
  ];
  return { version: 2, origin, issues, events, conflicts: [], importedPackages: [] };
}

/** v1（旧版单条文本字段）工作台数据迁移为 v2 字段级结构 */
function migrateV1(raw: unknown): WorkbenchState | null {
  if (!raw || typeof raw !== 'object') return null;
  const legacy = raw as { issues?: Array<Record<string, unknown>>; events?: AuditEvent[] };
  if (!Array.isArray(legacy.issues)) return null;
  const origin = DEFAULT_ORIGIN;
  const issues = legacy.issues.map((row, index): AuditIssue => {
    const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : nowIso();
    const status = (row.status as IssueStatus) ?? 'open';
    const base = createIssue({
      title: String(row.title ?? `迁移问题 ${index + 1}`),
      flow: String(row.flow ?? '未填写流程'),
      stepsText: String(row.steps ?? '（旧数据未记录复现步骤）'),
      impactGroup: String(row.impactGroup ?? '未标注影响人群'),
      severity: (row.severity as Severity) ?? 'moderate'
    }, origin, updatedAt);
    return {
      ...base,
      id: String(row.id ?? base.id),
      status,
      updatedAt,
      transitions: [
        ...base.transitions,
        { id: `migrated-${index}`, at: updatedAt, from: 'open', to: status, note: '从旧版本数据迁移的状态', origin, applied: true }
      ],
      retests: typeof row.retestNote === 'string' && row.retestNote
        ? [{ id: `migrated-retest-${index}`, at: updatedAt, passed: status === 'closed', note: row.retestNote, origin, valid: status === 'closed' }]
        : [],
      canonicalId: typeof row.canonicalId === 'string' ? row.canonicalId : undefined
    };
  }).map(recomputeIssueStatus);
  return { version: 2, origin, issues, events: Array.isArray(legacy.events) ? legacy.events : [], conflicts: [], importedPackages: [] };
}

export function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seedState();
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as WorkbenchState;
      if (parsed && parsed.version === 2 && Array.isArray(parsed.issues)) {
        return { ...parsed, conflicts: parsed.conflicts ?? [], importedPackages: parsed.importedPackages ?? [], events: parsed.events ?? [] };
      }
    }
    const rawV1 = localStorage.getItem(LEGACY_KEY);
    if (rawV1) {
      const migrated = migrateV1(JSON.parse(rawV1));
      if (migrated) return migrated;
    }
  } catch {
    // 存储损坏时回退到种子数据，不影响合并功能
  }
  return seedState();
}

export function saveState(state: WorkbenchState): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

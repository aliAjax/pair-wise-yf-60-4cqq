export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

/** 一条带来源的内容贡献：复现步骤 / 影响人群 / 证据 都用它保存 */
export interface Contribution {
  id: string;
  text: string;
  addedAt: string;
  /** 来源标识，例如办公室工作台、现场审计员姓名 */
  origin: string;
}

export interface StatusTransition {
  id: string;
  at: string;
  /** 操作时所基于的状态；分叉合并时用它识别“对着旧状态写入”的冲突 */
  from: IssueStatus | null;
  to: IssueStatus;
  note: string;
  origin: string;
  /** 合并重放后该流转是否为有效流转；基于已分叉旧状态的写入为 false */
  applied?: boolean;
}

export interface RetestRecord {
  id: string;
  at: string;
  passed: boolean;
  note: string;
  origin: string;
  /** 问题在该结论之后被重新打开时，旧结论立即失效 */
  valid: boolean;
}

export interface AuditIssue {
  id: string;
  /** 问题指纹：同一处缺陷无论来自哪台机器都相同 */
  fingerprint: string;
  title: string;
  flow: string;
  severity: Severity;
  steps: Contribution[];
  impactGroups: Contribution[];
  evidence: Contribution[];
  transitions: StatusTransition[];
  retests: RetestRecord[];
  /** 被手工判定为重复项时指向主问题 */
  canonicalId?: string;
  sources: string[];
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
}

/** 状态分叉冲突：较新的有效流转决定当前状态，较早的一条留档可见 */
export interface ConflictRecord {
  id: string;
  issueId: string;
  issueTitle: string;
  fingerprint: string;
  /** 冲突所涉两条流转的稳定键，重复导入不会生成重复冲突 */
  pairKey: string;
  at: string;
  newer: { transitionId: string; to: IssueStatus; at: string; origin: string; note: string };
  older: { transitionId: string; to: IssueStatus; at: string; origin: string; note: string };
  resolution: string;
  packageId?: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
}

export interface ImportedPackageMeta {
  packageId: string;
  origin: string;
  exportedAt: string;
  importedAt: string;
  issueCount: number;
  /** 已成功合入的包内问题 ID，合并失败重试时只补缺口 */
  appliedIssueIds: string[];
}

export interface WorkbenchState {
  version: 2;
  origin: string;
  issues: AuditIssue[];
  events: AuditEvent[];
  conflicts: ConflictRecord[];
  importedPackages: ImportedPackageMeta[];
}

/** 现场断网时保存、回办公室后导入的问题包 */
export interface IssuePackage {
  format: 'a11y-audit-pack';
  version: 1;
  packageId: string;
  origin: string;
  exportedAt: string;
  issues: AuditIssue[];
}

export interface ImportReport {
  skipped: boolean;
  added: number;
  merged: number;
  conflicts: number;
  invalidatedRetests: number;
  packageId: string;
  origin: string;
}

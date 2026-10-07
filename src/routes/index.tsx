import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  fingerprintOf,
  mergePackage,
  type AuditEvent,
  type AuditIssue,
  type ImportResult,
  type IssuePackage,
  type IssueStatus,
  type Severity,
  type WorkbenchState
} from '~/lib/merge';

const seed: WorkbenchState = {
  issues: [
    { id: 'issue-1', fingerprint: fingerprintOf('结算弹窗关闭后焦点丢失', '订单结算'), title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', evidence: '录屏 00:12 处焦点回到 body', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', retestInvalid: false, updatedAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: 'issue-2', fingerprint: fingerprintOf('错误提示未与输入框关联', '账户设置'), title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', evidence: 'NVDA 未播报错误提示', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', retestInvalid: false, updatedAt: new Date(Date.now() - 7200_000).toISOString() }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', kind: 'status', status: 'triaged', fingerprint: fingerprintOf('结算弹窗关闭后焦点丢失', '订单结算'), message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', kind: 'status', status: 'fixing', fingerprint: fingerprintOf('错误提示未与输入框关联', '账户设置'), message: '开发人员提交焦点管理修复' }
  ],
  conflicts: [],
  imports: {}
};

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  evidence: z.string().optional(),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({
    title: '无障碍人工审计协作工作台',
    subtitle: '问题、修复与复测协作',
    issues: '审计问题',
    merge: '重复合并',
    events: '操作时间线',
    offline: '离线问题包',
    conflicts: '冲突记录',
    exportPackage: '保存问题包',
    importPackage: '导入问题包',
    fingerprint: '问题指纹',
    evidence: '证据',
    retestInvalid: '原复测结论已失效',
    importResult: '导入结果',
    created: '新建',
    merged: '合并',
    conflictCount: '冲突',
    skipped: '跳过（已导入）',
    noConflicts: '暂无状态冲突。',
    conflictHint: '两边对同一问题写入不同状态时，按操作时间线采用较新的有效流转，较早的写入记录在此可见。'
  }),
  en: flatten({
    title: 'Accessibility Audit Workbench',
    subtitle: 'Issues, fixes and retesting',
    issues: 'Audit issues',
    merge: 'Duplicate merge',
    events: 'Activity timeline',
    offline: 'Offline package',
    conflicts: 'Conflicts',
    exportPackage: 'Save package',
    importPackage: 'Import package',
    fingerprint: 'Fingerprint',
    evidence: 'Evidence',
    retestInvalid: 'Previous retest conclusion invalidated',
    importResult: 'Import result',
    created: 'created',
    merged: 'merged',
    conflictCount: 'conflicts',
    skipped: 'skipped (already imported)',
    noConflicts: 'No status conflicts.',
    conflictHint: 'When both sides write different statuses for the same issue, the newer valid transition wins and the earlier write stays visible here.'
  })
};

function loadState(): WorkbenchState {
  let raw: any = null;
  if (typeof localStorage !== 'undefined') {
    try { raw = JSON.parse(localStorage.getItem('a11y-audit-v1') ?? 'null'); } catch { raw = null; }
  }
  if (!raw) return seed;
  raw.issues = (raw.issues ?? []).map((i: any) => ({
    ...i,
    fingerprint: i.fingerprint ?? fingerprintOf(i.title, i.flow),
    evidence: i.evidence ?? '',
    retestInvalid: i.retestInvalid ?? false
  }));
  raw.events = (raw.events ?? []).map((e: any) => ({ ...e, kind: e.kind ?? 'note' }));
  raw.conflicts = raw.conflicts ?? [];
  raw.imports = raw.imports ?? {};
  return raw as WorkbenchState;
}

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');
  const [lastImport, setLastImport] = createSignal<ImportResult | null>(null);
  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length, state.conflicts.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', evidence: '', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('a11y-audit-v1', JSON.stringify(state));
  });

  const addEvent = (issueId: string, message: string, kind: AuditEvent['kind'] = 'note', status?: IssueStatus, fingerprint?: string) =>
    setState('events', (events) => [{ id: crypto.randomUUID(), at: new Date().toISOString(), issueId, kind, status, fingerprint, message }, ...events]);

  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string) => {
    setState('issues', (issue) => issue.id === id, produce((issue) => Object.assign(issue, patch, { updatedAt: new Date().toISOString() })));
    addEvent(id, message);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  // 状态流转：关闭后重新打开会让旧复测结论立即失效
  const transitionTo = (issueId: string, status: IssueStatus, patch: Partial<AuditIssue>, message: string) => {
    const issue = state.issues.find((i) => i.id === issueId);
    if (!issue) return;
    const prev = issue.status;
    const next: Partial<AuditIssue> = { ...patch };
    if (status === 'reopened' && prev === 'closed') {
      if (!patch.retestNote) next.retestInvalid = true;
      addEvent(issueId, `原复测通过结论已失效：${issue.retestNote || '（无记录）'}`, 'note');
    }
    if (status === 'closed') next.retestInvalid = false;
    setState('issues', (i) => i.id === issueId, produce((draft) => {
      Object.assign(draft, next, { status, updatedAt: new Date().toISOString() });
    }));
    addEvent(issueId, message, 'status', status, issue.fingerprint);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const id = crypto.randomUUID();
    const issue: AuditIssue = {
      id,
      fingerprint: fingerprintOf(values.title, values.flow),
      title: values.title,
      flow: values.flow,
      steps: values.steps,
      impactGroup: values.impactGroup,
      evidence: values.evidence ?? '',
      severity: values.severity,
      status: 'open',
      fixNote: '',
      retestNote: '',
      retestInvalid: false,
      updatedAt: new Date().toISOString()
    };
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据', 'created', 'open', issue.fingerprint);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    updateIssue(duplicate.id, { canonicalId: canonical.id }, `重复问题已合并到 ${canonical.title}`);
    setSelectedId(canonical.id);
  };

  // 导入问题包：按指纹认出同一处缺陷，字段级合并，失败可重试且不重复建记录
  const onMergePackage = (pkg: IssuePackage) => {
    const { state: next, result } = mergePackage(state, pkg);
    setState(next);
    setLastImport(result);
  };

  const exportPackage = () => {
    const pkg: IssuePackage = {
      packageId: crypto.randomUUID(),
      exportedAt: new Date().toISOString(),
      source: 'a11y-audit-workbench',
      issues: state.issues.map((i) => ({
        fingerprint: i.fingerprint,
        title: i.title,
        flow: i.flow,
        steps: i.steps,
        impactGroup: i.impactGroup,
        evidence: i.evidence ?? '',
        severity: i.severity,
        status: i.status,
        fixNote: i.fixNote,
        retestNote: i.retestNote,
        retestInvalid: i.retestInvalid ?? false,
        updatedAt: i.updatedAt
      })),
      events: state.events.map((e) => ({ ...e }))
    };
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-package-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as IssuePackage;
      if (!pkg || !Array.isArray(pkg.issues)) throw new Error('无效的问题包：缺少 issues 数组');
      onMergePackage(pkg);
    } catch (err) {
      setLastImport({ packageId: '', at: new Date().toISOString(), created: 0, merged: 0, conflicts: 0, skipped: 0, errors: [(err as Error).message] });
    }
    input.value = '';
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <section class="card" aria-labelledby="offline-title" style="margin-bottom:18px">
          <h2 id="offline-title">{t()('offline')}</h2>
          <p style="color:#5d7780;margin:6px 0 12px">现场断网时先保存问题包，回到办公室再导入同一工作台；按问题指纹合并，新增步骤、人群与证据两边都保留。</p>
          <div role="group" aria-label="离线问题包操作" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button onClick={exportPackage}>{t()('exportPackage')}</button>
            <label class="secondary" style="display:inline-grid;gap:0;cursor:pointer">
              <span style="padding:9px 13px">{t()('importPackage')}</span>
              <input type="file" accept="application/json,.json" onChange={onImportFile} style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)" />
            </label>
            <Show when={lastImport()}>{(r) => (
              <span role="status" class="badge" style="background:#eefaf8;color:#0d6664;padding:6px 12px">
                {t()('importResult')}：{t()('created')} {r().created} · {t()('merged')} {r().merged} · {t()('conflictCount')} {r().conflicts} · {t()('skipped')} {r().skipped}
                <Show when={r().errors.length > 0}> · <span class="error">{r().errors.join('；')}</span></Show>
              </span>
            )}</Show>
          </div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta"><span class="badge">{issue.status}</span><span class="badge">{issue.severity}</span><span>{issue.flow}</span><span>{issue.impactGroup}</span><Show when={issue.canonicalId}><span class="badge">重复项</span></Show><Show when={issue.retestInvalid}><span class="badge" style="background:#fdecea;color:#b42318">{t()('retestInvalid')}</span></Show></div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <h3>{issue.title}</h3>
                <p class="meta"><span class="badge">{t()('fingerprint')} {issue.fingerprint}</span></p>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>影响人群：</strong>{issue.impactGroup}</p>
                <p><strong>{t()('evidence')}：</strong>{issue.evidence || '尚未填写'}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>
                  <Show when={issue.retestInvalid} fallback={issue.retestNote || '尚未填写'}>
                    <span style="color:#b42318;text-decoration:line-through">{issue.retestNote || '（无记录）'}</span>
                    <span class="badge" style="background:#fdecea;color:#b42318;margin-left:6px">{t()('retestInvalid')}</span>
                  </Show>
                </p>
                <div role="group" aria-label="问题状态操作">
                  <button onClick={() => transitionTo(issue.id, 'triaged', {}, '审核员完成分诊')}>确认问题</button>{' '}
                  <button onClick={() => transitionTo(issue.id, 'fixing', { fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>开始修复</button>{' '}
                  <button onClick={() => transitionTo(issue.id, 'verifying', {}, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                  <button onClick={() => transitionTo(issue.id, 'closed', { retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>复测通过</button>{' '}
                  <button class="danger" onClick={() => transitionTo(issue.id, 'reopened', { retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>复测失败</button>{' '}
                  <Show when={issue.status === 'closed'}>
                    <button class="danger" onClick={() => transitionTo(issue.id, 'reopened', {}, '问题重新打开，旧复测结论失效')}>重新打开（旧复测结论失效）</button>
                  </Show>
                </div>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value ?? ''} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value ?? ''} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4}>{field.value ?? ''}</textarea></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props} value={field.value ?? ''}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="evidence">{ (field, props) => <label>{t()('evidence')}<textarea {...props} rows={3} placeholder="录屏、截图或读屏播报记录">{field.value ?? ''}</textarea></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props} value={field.value ?? ''}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="conflicts">{t()('conflicts')} ({state.conflicts.length})</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="conflicts">
                <p style="color:#5d7780">{t()('conflictHint')}</p>
                <Show when={state.conflicts.length > 0} fallback={<p role="status">{t()('noConflicts')}</p>}>
                  <For each={state.conflicts}>{(c) => (
                    <div class="issue" style="border-bottom:1px solid #e4ecee;padding:12px 4px">
                      <div class="meta"><span class="badge">{c.fingerprint}</span><span>{new Date(c.at).toLocaleString()}</span></div>
                      <div style="margin-top:6px">本地「{c.localStatus}」↔ 离线包「{c.incomingStatus}」→ 采用「{c.resolvedStatus}」</div>
                    </div>
                  )}</For>
                </Show>
              </Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}

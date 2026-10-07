import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery } from '@tanstack/solid-query';
import { createForm, setValue, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  buildPackage,
  applyPackage,
  nowIso,
  recomputeIssueStatus,
  statusLabel,
  uid,
  validatePack
} from '../lib/audit/merge';
import {
  STORAGE_KEY,
  contribution,
  createIssue,
  loadState,
  retest,
  saveState,
  seedState,
  transition
} from '../lib/audit/factory';
import type { AuditIssue, ImportReport, IssuePackage, IssueStatus, Severity, WorkbenchState } from '../lib/audit/types';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
  evidence: z.string().optional()
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '离线问题包 · 指纹合并 · 冲突仲裁', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Offline packs · fingerprint merge · conflicts', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

type ContributionKind = 'steps' | 'impactGroups' | 'evidence';

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [importMessage, setImportMessage] = createSignal<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [contribKind, setContribKind] = createSignal<ContributionKind>('steps');
  const [contribText, setContribText] = createSignal('');

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length, state.conflicts.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 80))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious', evidence: '' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);

  // 合并结果与冲突全部持久化：重开浏览器仍可见
  createEffect(() => saveState(state));

  const addEvent = (issueId: string, message: string) => {
    setState('events', (events) => [{ id: uid('event'), at: nowIso(), issueId, message }, ...events]);
  };

  const mutateIssue = (id: string, updater: (draft: AuditIssue) => void, message?: string) => {
    setState('issues', (issue) => issue.id === id, produce((draft) => {
      updater(draft);
      draft.updatedAt = nowIso();
      const recomputed = recomputeIssueStatus(draft as AuditIssue);
      draft.status = recomputed.status;
      draft.retests = recomputed.retests;
    }));
    if (message) addEvent(id, message);
  };

  const createNewIssue = (values: IssueForm) => {
    const issue = createIssue({
      title: values.title,
      flow: values.flow,
      stepsText: values.steps,
      impactGroup: values.impactGroup,
      severity: values.severity,
      evidenceText: values.evidence?.trim() || undefined
    }, state.origin);
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(issue.id, '审计员创建问题并保存证据');
  };

  const changeStatus = (issue: AuditIssue, to: IssueStatus, note: string) => {
    mutateIssue(issue.id, (draft) => {
      draft.transitions.push(transition(to, state.origin, note, { from: draft.status }));
      if (to === 'closed') {
        draft.retests.push(retest(true, '键盘、读屏和错误提示均已通过', state.origin));
      }
    }, `${state.origin}：${note}`);
  };

  const reopenIssue = (issue: AuditIssue) => {
    mutateIssue(issue.id, (draft) => {
      draft.transitions.push(transition('reopened', state.origin, '复测失败，问题重新打开', { from: draft.status }));
      draft.retests.push(retest(false, '焦点顺序仍不正确，旧复测结论失效', state.origin));
    }, '问题重新打开，该问题此前的复测结论立即失效');
  };

  const appendContribution = (issue: AuditIssue) => {
    const text = contribText().trim();
    if (text.length < 2) return;
    const kind = contribKind();
    mutateIssue(issue.id, (draft) => {
      draft[kind].push(contribution(text, state.origin));
    }, `${state.origin}补充了${kind === 'steps' ? '复现步骤' : kind === 'impactGroups' ? '影响人群' : '证据'}`);
    setContribText('');
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    mutateIssue(duplicate.id, (draft) => { draft.canonicalId = canonical.id; }, `重复问题已合并到 ${canonical.title}`);
    setSelectedId(canonical.id);
    setMergeInto('');
  };

  /** 断网现场使用：导出本机全部问题为离线问题包 */
  const exportPack = () => {
    const pack = buildPackage(state, state.origin);
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `audit-pack-${pack.packageId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    addEvent('system', `已导出离线问题包（${pack.issues.length} 个问题），可在断网现场使用`);
  };

  /**
   * 生成一个“断网返回”演示包：现场在 issue-1 上补充了步骤/人群/证据并把状态推进到待复测，
   * 同时办公室在离线期间把同一问题推进到修复中 —— 导入时即产生一次真实的状态冲突仲裁。
   * 固定 packageId：重复导入同一个包必须被检查点挡住，不能多出记录。
   */
  const DEMO_PACK_ID = 'pack-demo-offline';
  const buildDemoPack = (): IssuePackage => {
    const current = structuredClone(state);
    const target = current.issues.find((issue) => issue.id === 'issue-1') ?? current.issues[0];
    const exportedAt = new Date(Date.now() - 25 * 60_000).toISOString();
    const pack = buildPackage({ ...current, issues: [target] }, '现场审计员·小王', exportedAt);
    pack.packageId = DEMO_PACK_ID;
    const packedIssue = pack.issues[0];
    packedIssue.steps.push(contribution('4. 现场补充：弱网环境下读屏会先朗读遮罩层，顺序错乱', pack.origin, new Date(Date.now() - 15 * 60_000).toISOString()));
    packedIssue.impactGroups.push(contribution('低视力用户（高对比度模式下遮罩透明度异常）', pack.origin, new Date(Date.now() - 14 * 60_000).toISOString()));
    packedIssue.evidence.push(contribution('现场录屏 evidence-field-01.mp4：NVDA 焦点行停留在关闭按钮上', pack.origin, new Date(Date.now() - 13 * 60_000).toISOString()));
    packedIssue.transitions.push(transition('verifying', pack.origin, '现场确认修复包已部署，提交复测', { from: 'triaged', at: new Date(Date.now() - 8 * 60_000).toISOString() }));
    packedIssue.updatedAt = new Date(Date.now() - 8 * 60_000).toISOString();
    // 现场还新建了一个办公室尚不知道的问题
    const fieldIssue = createIssue({
      title: '现场新发现：验证码图片无文字替代',
      flow: '登录注册',
      stepsText: '1. 进入登录页\n2. 定位图形验证码\n3. 读屏无法获取任何说明',
      impactGroup: '读屏用户',
      severity: 'serious',
      evidenceText: '照片 evidence-field-02.jpg'
    }, pack.origin, new Date(Date.now() - 10 * 60_000).toISOString());
    pack.issues.push(fieldIssue);

    // 模拟办公室在审计员离线期间也对同一问题写入了不同状态
    const officeTarget = state.issues.find((issue) => issue.id === 'issue-1');
    if (officeTarget) {
      mutateIssue(officeTarget.id, (draft) => {
        draft.transitions.push(transition('fixing', state.origin, '离线期间开发开始修复', { from: 'triaged', at: new Date(Date.now() - 12 * 60_000).toISOString() }));
      }, '离线期间办公室将问题推进到修复中');
    }
    return pack;
  };

  const importPackObject = (pack: IssuePackage): ImportReport => {
    const result = applyPackage(state, pack);
    setState(result.state);
    return result.report;
  };

  const describeReport = (record: ImportReport): string => (record.skipped
    ? `问题包 ${record.packageId} 已完整导入过，本次跳过：没有新增任何记录`
    : `导入完成：新增问题 ${record.added} 个，指纹匹配合并 ${record.merged} 个，状态冲突 ${record.conflicts} 条，失效旧复测结论 ${record.invalidatedRetests} 条`);

  const onImportFile = async (file: File) => {
    try {
      const pack = validatePack(JSON.parse(await file.text()));
      const report = importPackObject(pack);
      setImportMessage({ tone: 'ok', text: describeReport(report) });
    } catch (error) {
      setImportMessage({ tone: 'error', text: error instanceof Error ? error.message : '导入失败' });
    }
  };

  const importDemoPack = () => {
    const already = state.importedPackages.find((meta) => meta.packageId === DEMO_PACK_ID);
    if (already && already.appliedIssueIds.length >= 2) {
      setImportMessage({ tone: 'ok', text: describeReport({ skipped: true, added: 0, merged: 0, conflicts: 0, invalidatedRetests: 0, packageId: DEMO_PACK_ID, origin: '现场审计员·小王' }) });
      return;
    }
    const pack = buildDemoPack();
    const report = importPackObject(pack);
    setImportMessage({ tone: 'ok', text: describeReport(report) });
  };

  /** 模拟“导入到一半失败后重试”：只登记检查点的前半部分，再次导入只补未合入的问题 */
  const simulateFailedRetry = () => {
    const pack = buildDemoPack();
    const firstIssueId = pack.issues[0].id;
    const partial = applyPackage(state, { ...pack, issues: [pack.issues[0]] });
    setState(partial.state);
    const retry = applyPackage(partial.state, pack);
    setState(retry.state);
    setImportMessage({
      tone: 'ok',
      text: `模拟失败重试：首个问题 ${firstIssueId} 已在检查点中，重试只补入剩余 ${pack.issues.length - 1} 个问题；当前问题总数 ${state.issues.length}（无重复）`
    });
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (event.key.toLowerCase() === 'n' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
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
          <div>
            <span class="badge">WCAG 人工审计协作 · 离线合并</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 本机标识：{state.origin} · 快捷键 N 聚焦新建问题</p>
          </div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待处理</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>冲突记录</span><strong>{state.conflicts.length}</strong></div>
        </section>

        <section class="card pack-panel" aria-labelledby="pack-title">
          <h2 id="pack-title">离线问题包（现场断网 → 回办公室合并）</h2>
          <div class="pack-actions">
            <button onClick={exportPack}>① 导出问题包</button>
            <label class="file-button">② 导入问题包并合并
              <input type="file" accept="application/json,.json" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void onImportFile(file); (event.currentTarget as HTMLInputElement).value = ''; }} />
            </label>
            <button class="secondary" onClick={importDemoPack}>生成「断网返回」演示包并合并</button>
            <button class="secondary" onClick={simulateFailedRetry}>模拟合并失败后重试</button>
            <button class="danger" onClick={() => { if (window.confirm('重置为种子数据？')) { const fresh = seedState(); setState(fresh); localStorage.removeItem(STORAGE_KEY); setSelectedId(fresh.issues[0]?.id ?? ''); } }}>重置演示数据</button>
          </div>
          <Show when={importMessage()} keyed>
            {(message) => <p class={message.tone === 'ok' ? 'import-ok' : 'error'} role="status">{message.text}</p>}
          </Show>
          <Show when={state.importedPackages.length > 0}>
            <ul class="pack-list">
              <For each={state.importedPackages}>{(meta) => (
                <li>包 {meta.packageId} · 来源「{meta.origin}」· 导出 {new Date(meta.exportedAt).toLocaleString()} · 检查点 {meta.appliedIssueIds.length}/{meta.issueCount} · 导入于 {new Date(meta.importedAt).toLocaleString()}</li>
              )}</For>
            </ul>
          </Show>
        </section>

        <Show when={state.conflicts.length > 0}>
          <section class="card conflicts" aria-labelledby="conflicts-title">
            <h2 id="conflicts-title">状态冲突记录（较新有效流转决定当前状态，较早流转留档可见）</h2>
            <For each={state.conflicts}>{(conflict) => (
              <article class="conflict">
                <h3><button class="secondary" onClick={() => setSelectedId(conflict.issueId)}>{conflict.issueTitle}</button></h3>
                <div class="conflict-grid">
                  <div class="conflict-side older">
                    <span class="badge">较早 · 未决定当前状态</span>
                    <p><strong>{statusLabel(conflict.older.to)}</strong> · {conflict.older.origin} · {new Date(conflict.older.at).toLocaleString()}</p>
                    <p>{conflict.older.note}</p>
                  </div>
                  <div class="conflict-side newer">
                    <span class="badge">较新 · 当前生效</span>
                    <p><strong>{statusLabel(conflict.newer.to)}</strong> · {conflict.newer.origin} · {new Date(conflict.newer.at).toLocaleString()}</p>
                    <p>{conflict.newer.note}</p>
                  </div>
                </div>
                <p class="resolution">仲裁：{conflict.resolution}（记录于 {new Date(conflict.at).toLocaleString()}）</p>
              </article>
            )}</For>
          </section>
        </Show>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '本地已保存' : '加载中'}</small></h2>
            <For each={state.issues}>{(issue) => (
              <article class="issue">
                <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                <div class="meta">
                  <span class="badge">{statusLabel(issue.status)}</span>
                  <span class="badge">{issue.severity}</span>
                  <span>{issue.flow}</span>
                  <span class="badge">指纹 {issue.fingerprint}</span>
                  <span>来源：{issue.sources.join('、')}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <h3>{issue.title}</h3>
                <p class="meta"><span class="badge">当前状态：{statusLabel(issue.status)}</span><span>指纹 {issue.fingerprint}</span></p>

                <h4>复现步骤（双方新增均保留）</h4>
                <ul class="contrib-list">
                  <For each={issue.steps}>{(item) => <li><span class="badge">{item.origin} · {new Date(item.addedAt).toLocaleString()}</span><div>{item.text}</div></li>}</For>
                </ul>

                <h4>影响人群</h4>
                <ul class="contrib-list">
                  <For each={issue.impactGroups}>{(item) => <li><span class="badge">{item.origin}</span><div>{item.text}</div></li>}</For>
                </ul>

                <h4>证据</h4>
                <Show when={issue.evidence.length > 0} fallback={<p>尚无证据。</p>}>
                  <ul class="contrib-list"><For each={issue.evidence}>{(item) => <li><span class="badge">{item.origin}</span><div>{item.text}</div></li>}</For></ul>
                </Show>

                <h4>复测结论</h4>
                <Show when={issue.retests.length > 0} fallback={<p>尚未复测。</p>}>
                  <ul class="contrib-list">
                    <For each={issue.retests}>{(record) => (
                      <li class={record.valid ? '' : 'invalidated'}>
                        <span class="badge">{record.valid ? (record.passed ? '有效 · 通过' : '有效 · 未通过') : '已失效（问题被重新打开）'}</span>
                        <div>{record.note} · {record.origin} · {new Date(record.at).toLocaleString()}</div>
                      </li>
                    )}</For>
                  </ul>
                </Show>

                <div class="field-add">
                  <label>追加内容类型
                    <select value={contribKind()} onChange={(event) => setContribKind(event.currentTarget.value as ContributionKind)}>
                      <option value="steps">复现步骤</option>
                      <option value="impactGroups">影响人群</option>
                      <option value="evidence">证据</option>
                    </select>
                  </label>
                  <label>现场/办公室新增内容
                    <textarea rows={2} value={contribText()} onInput={(event) => setContribText(event.currentTarget.value)} />
                  </label>
                  <button disabled={contribText().trim().length < 2} onClick={() => appendContribution(issue)}>追加（字段级保留，不覆盖原值）</button>
                </div>

                <div role="group" aria-label="问题状态操作" class="status-actions">
                  <button onClick={() => changeStatus(issue, 'triaged', '审核员完成分诊')}>确认问题</button>
                  <button onClick={() => changeStatus(issue, 'fixing', '开发人员开始修复')}>开始修复</button>
                  <button onClick={() => changeStatus(issue, 'verifying', '开发人员提交修复，进入复测')}>提交复测</button>
                  <button onClick={() => changeStatus(issue, 'closed', '复测通过并关闭问题')}>复测通过</button>
                  <button class="danger" onClick={() => reopenIssue(issue)}>复测失败 / 重新打开</button>
                </div>

                <h4>操作时间线（含有效性判定）</h4>
                <ul class="timeline-list">
                  <For each={[...issue.transitions].reverse()}>{(tr) => (
                    <li class={tr.applied === false ? 'invalidated' : ''}>
                      <strong>{new Date(tr.at).toLocaleString()}</strong> {statusLabel(tr.from ?? 'open')} → {statusLabel(tr.to)} · {tr.origin}
                      <div>{tr.note}{tr.applied === false ? '（基于已分叉旧状态的无效流转）' : ''}</div>
                    </li>
                  )}</For>
                </ul>

                <hr />
                <label>合并到主问题
                  <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                    <option value="">选择问题</option>
                    <For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                  </select>
                </label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createNewIssue} style="margin-top:12px">
              <AuditField name="title">{(field, props) => <label>问题标题<input id="issue-title" {...{ ...props, value: field.value, onInput: (event: InputEvent) => setValue(form, 'title', (event.currentTarget as HTMLInputElement).value) }} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label>}</AuditField>
              <AuditField name="flow">{(field, props) => <label>业务流程<input {...{ ...props, value: field.value, onInput: (event: InputEvent) => setValue(form, 'flow', (event.currentTarget as HTMLInputElement).value) }} /></label>}</AuditField>
              <AuditField name="steps">{(field, props) => <label>复现步骤<textarea rows={4} {...{ ...props, value: field.value, onInput: (event: InputEvent) => setValue(form, 'steps', (event.currentTarget as HTMLTextAreaElement).value) }} /></label>}</AuditField>
              <AuditField name="impactGroup">{(field) => <label>影响人群<select value={field.value} onChange={(event) => setValue(form, 'impactGroup', event.currentTarget.value)}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>}</AuditField>
              <AuditField name="severity">{(field) => <label>严重程度<select value={field.value} onChange={(event) => setValue(form, 'severity', event.currentTarget.value as Severity)}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>}</AuditField>
              <AuditField name="evidence">{(field, props) => <label>证据（可选）<input {...{ ...props, value: field.value ?? '', onInput: (event: InputEvent) => setValue(form, 'evidence', (event.currentTarget as HTMLInputElement).value) }} /></label>}</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 14)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>冲突与导入结果使用 <code>role="status"</code> 通告，并持久化到本地</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}

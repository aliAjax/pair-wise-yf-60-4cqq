/**
 * 离线问题包合并引擎测试：
 * npx tsx scripts/merge.test.ts
 */
import assert from 'node:assert/strict';
import { applyPackage, buildPackage, replayStatus, validatePack } from '../src/lib/audit/merge';
import { fingerprintOf } from '../src/lib/audit/fingerprint';
import { contribution, createIssue, loadStateSeed, retest, transition } from './test-helpers';
import type { AuditIssue, IssuePackage, WorkbenchState } from '../src/lib/audit/types';

let passed = 0;
async function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

const clone = <T>(value: T): T => structuredClone(value);

console.log('1. 问题指纹：同一处缺陷即使文本有空格/标点差异也能认出');
test('指纹对空白、全角空格和标点不敏感', () => {
  const a = fingerprintOf({ title: '结算弹窗 关闭后焦点丢失', flow: '订单结算', stepsText: '1. 按Esc关闭\n2.按Tab检查' });
  const b = fingerprintOf({ title: '结算弹窗关闭后焦点丢失！', flow: '订单结算 ', stepsText: '1.按 Esc 关闭 2.按 Tab 检查' });
  assert.equal(a, b, '同一缺陷的两种文本写法指纹必须一致');
  const c = fingerprintOf({ title: '另一个完全不同的问题', flow: '订单结算', stepsText: '1. 按Esc关闭' });
  assert.notEqual(a, c);
});

console.log('2. 指纹匹配：包内问题按指纹并入，不同问题作为新增，绝不整条覆盖');
test('现场新增问题进列表；同指纹问题只做字段合并', () => {
  const { state, pack } = loadStateSeed();
  const before = state.issues.length;
  const result = applyPackage(clone(state), clone(pack));
  const matched = result.state.issues.find((issue) => issue.fingerprint === pack.issues[0].fingerprint)!;
  assert.equal(result.state.issues.length, before + 1, '只应新增 1 个问题（现场新发现），同指纹问题不得复制成新记录');
  assert.equal(result.report.added, 1);
  assert.equal(result.report.merged, 1);
  assert.ok(matched.steps.some((s) => s.origin === '办公室工作台'), '办公室原有复现步骤必须保留');
  assert.ok(matched.steps.some((s) => s.text.includes('现场补充')), '现场新增复现步骤必须保留');
  assert.ok(matched.impactGroups.length >= 2, '两边的影响人群都要保留');
  assert.ok(matched.evidence.some((e) => e.text.includes('field-01')), '现场证据必须保留');
  assert.ok(matched.sources.includes('办公室工作台') && matched.sources.includes('现场审计员·小王'), '来源链都要保留');
});

console.log('3. 状态冲突：两边写入不同状态，较新的有效流转决定当前状态，较早的留档');
test('现场 verifying(较新) 胜出，办公室 fixing(较早) 进入冲突记录', () => {
  const { state, pack, matchedId } = loadStateSeed();
  // 离线期间办公室把 triaged 推进到 fixing（较早）
  const office = mutateOffice(state, matchedId, (issue) => {
    issue.transitions.push(transition('fixing', '办公室工作台', '离线期间开发开始修复', { from: 'triaged', at: new Date(Date.now() - 12 * 60_000).toISOString() }));
    issue.status = 'fixing';
  });
  // 现场包：triaged → verifying（较新）
  const field = clone(pack);
  field.issues[0].transitions.push(transition('verifying', '现场审计员·小王', '现场提交复测', { from: 'triaged', at: new Date(Date.now() - 8 * 60_000).toISOString() }));

  const result = applyPackage(office, field);
  const matched = result.state.issues.find((issue) => issue.id === matchedId)!;
  assert.equal(matched.status, 'verifying', '较新的有效流转必须决定当前状态');
  assert.equal(result.state.conflicts.length, 1);
  const conflict = result.state.conflicts[0];
  assert.equal(conflict.newer.to, 'verifying');
  assert.equal(conflict.older.to, 'fixing');
  assert.ok(conflict.resolution.includes('较新'));
});

test('反过来：若办公室流转更晚，则办公室状态胜出，现场流转留档', () => {
  const { state, pack, matchedId } = loadStateSeed();
  const office = mutateOffice(state, matchedId, (issue) => {
    issue.transitions.push(transition('fixing', '办公室工作台', '晚些时候开发开始修复', { from: 'triaged', at: new Date(Date.now() - 2 * 60_000).toISOString() }));
    issue.status = 'fixing';
  });
  const field = clone(pack);
  field.issues[0].transitions.push(transition('verifying', '现场审计员·小王', '较早提交复测', { from: 'triaged', at: new Date(Date.now() - 8 * 60_000).toISOString() }));

  const result = applyPackage(office, field);
  const matched = result.state.issues.find((issue) => issue.id === matchedId)!;
  assert.equal(matched.status, 'fixing');
  assert.equal(result.state.conflicts[0].older.to, 'verifying');
  assert.equal(result.state.conflicts[0].newer.to, 'fixing');
});

console.log('4. 对着已分叉旧状态的写入不是有效流转，不能决定当前状态');
test('现场在办公室已关闭后仍提交复测 → 标记无效，不改变已关闭状态，且可见冲突', () => {
  const { state, pack, matchedId } = loadStateSeed();
  const office = mutateOffice(state, matchedId, (issue) => {
    issue.transitions.push(transition('closed', '办公室工作台', '复测通过并关闭', { from: 'triaged', at: new Date(Date.now() - 9 * 60_000).toISOString() }));
    issue.status = 'closed';
  });
  const field = clone(pack);
  const stale = transition('verifying', '现场审计员·小王', '不知道已关闭，仍提交复测', { from: 'triaged', at: new Date(Date.now() - 3 * 60_000).toISOString() });
  field.issues[0].transitions.push(stale);

  const result = applyPackage(office, field);
  const matched = result.state.issues.find((issue) => issue.id === matchedId)!;
  assert.equal(matched.status, 'closed', '无效流转不能改变当前状态');
  const stored = matched.transitions.find((t) => t.id === stale.id)!;
  assert.equal(stored.applied, false, '较早/无效的流转必须在时间线上可见且标记为无效');
  assert.equal(result.state.conflicts.length, 1);
  assert.ok(result.state.conflicts[0].resolution.includes('不是有效流转'));
});

console.log('5. 已关闭问题再次打开后，旧复测结论立即失效');
test('closed + 有效复测结论 → reopen 后旧结论 valid=false', () => {
  const { state, pack, matchedId } = loadStateSeed();
  const office = mutateOffice(state, matchedId, (issue) => {
    issue.transitions.push(transition('closed', '办公室工作台', '复测通过并关闭', { from: 'triaged', at: new Date(Date.now() - 30 * 60_000).toISOString() }));
    issue.retests.push(retest(true, '键盘、读屏均通过', '复测员', new Date(Date.now() - 30 * 60_000).toISOString()));
    issue.status = 'closed';
  });
  const field = clone(pack);
  field.issues[0].transitions.push(transition('reopened', '现场审计员·小王', '复测失败，问题重新打开', { from: 'closed', at: new Date(Date.now() - 5 * 60_000).toISOString() }));

  const result = applyPackage(office, field);
  const matched = result.state.issues.find((issue) => issue.id === matchedId)!;
  assert.equal(matched.status, 'reopened');
  const oldConclusion = matched.retests.find((r) => r.note.includes('均通过'))!;
  assert.equal(oldConclusion.valid, false, '重新打开前的复测结论必须立即失效');
  assert.ok(result.report.invalidatedRetests >= 1);
});

console.log('6. 两边写入相同状态不产生冲突；冲突记录在重复导入时不重复');
test('两边都 closed：无冲突；重复导入同一包零新增、零重复冲突', () => {
  const { state, pack, matchedId } = loadStateSeed();
  const office = mutateOffice(state, matchedId, (issue) => {
    issue.transitions.push(transition('closed', '办公室工作台', '关闭', { from: 'triaged', at: new Date(Date.now() - 9 * 60_000).toISOString() }));
    issue.status = 'closed';
  });
  const field = clone(pack);
  field.issues[0].transitions.push(transition('closed', '现场审计员·小王', '同样判定关闭', { from: 'triaged', at: new Date(Date.now() - 4 * 60_000).toISOString() }));

  const once = applyPackage(office, clone(field));
  assert.equal(once.state.conflicts.length, 0, '相同状态不是冲突');
  const issueCount = once.state.issues.length;

  const twice = applyPackage(clone(once.state), clone(field));
  assert.equal(twice.report.skipped, true, '整包已导入过必须直接跳过');
  assert.equal(twice.state.issues.length, issueCount, '重复导入不能多出问题记录');
  assert.equal(twice.state.conflicts.length, 0);
});

console.log('7. 合并失败重试：只补检查点之外没合进去的部分');
test('先只合入包内第 1 个问题（模拟中断），再重试完整包 → 仅补入第 2 个，无重复', () => {
  const { state, pack } = loadStateSeed();
  const partialPack: IssuePackage = { ...clone(pack), issues: [clone(pack.issues[0])] };
  const partial = applyPackage(clone(state), partialPack);
  const afterPartial = partial.state.issues.length;
  assert.ok(afterPartial === state.issues.length, '第一批只有同指纹合并，没有新增问题');

  const retry = applyPackage(clone(partial.state), clone(pack));
  assert.equal(retry.state.issues.length, afterPartial + 1, '重试只能补入现场新问题 1 个');
  // 已合入的同指纹问题，其现场步骤不应因重试被重复追加
  const matched = retry.state.issues.find((issue) => issue.fingerprint === pack.issues[0].fingerprint)!;
  const fieldSteps = matched.steps.filter((s) => s.text.includes('现场补充'));
  assert.equal(fieldSteps.length, 1, '重试不得重复追加已合入的字段');
  assert.equal(retry.state.importedPackages[0].appliedIssueIds.length, pack.issues.length);
});

console.log('8. 重放原语：分叉点共享前缀之后开始仲裁');
test('共享流转作为共同前缀，不从初始 open 误判现场流转无效', () => {
  const shared = transition('triaged', '办公室工作台', '确认问题', { from: 'open', at: new Date(Date.now() - 60 * 60_000).toISOString() });
  const local = [shared, transition('fixing', '办公室工作台', '开始修复', { from: 'triaged', at: new Date(Date.now() - 6 * 60_000).toISOString() })];
  const incoming = [clone(shared), transition('verifying', '现场', '提交复测', { from: 'triaged', at: new Date(Date.now() - 3 * 60_000).toISOString() })];
  const replay = replayStatus('open', local, incoming);
  assert.equal(replay.status, 'verifying', '较新的有效流转必须胜出');
  assert.equal(replay.divergences.length, 1);
});

console.log('9. 无共同历史但同指纹的问题（两端各自离线创建）：较早流转无效，较新流转决定状态');
test('两端独立创建、仅指纹相同：时间线仍按先后仲裁且不崩溃', () => {
  const officeIssue = createIssue({ title: '现场也会记录的同一处缺陷', flow: '结账', stepsText: '步骤A' }, '办公室');
  officeIssue.transitions.push(transition('fixing', '办公室工作台', '修复中', { from: 'open', at: new Date(Date.now() - 5 * 60_000).toISOString() }));
  officeIssue.status = 'fixing';
  const state: WorkbenchState = { version: 2, origin: '办公室工作台', issues: [officeIssue], events: [], conflicts: [], importedPackages: [] };

  const fieldIssue = createIssue({ title: '现场也会记录的同一处缺陷', flow: '结账', stepsText: '步骤A' }, '现场');
  fieldIssue.transitions.push(transition('closed', '现场审计员', '现场先行关闭', { from: 'open', at: new Date(Date.now() - 2 * 60_000).toISOString() }));
  fieldIssue.status = 'closed';
  const pack: IssuePackage = { format: 'a11y-audit-pack', version: 1, packageId: 'pack-x', origin: '现场', exportedAt: new Date().toISOString(), issues: [fieldIssue] };

  const result = applyPackage(state, pack);
  const matched = result.state.issues.find((issue) => issue.fingerprint === officeIssue.fingerprint)!;
  assert.equal(matched.status, 'closed', '较晚写入的 closed 决定当前状态');
  assert.ok(result.state.issues.length === 1, '指纹相同绝不新增记录');
});

function mutateOffice(state: WorkbenchState, matchedId: string, mutate: (issue: AuditIssue) => void): WorkbenchState {
  const next = clone(state);
  const issue = next.issues.find((item) => item.id === matchedId)!;
  mutate(issue);
  return next;
}

console.log('10. 畸形问题包必须被拒绝，不能污染工作台');
test('缺少格式标识 / 问题列表时抛出可读错误', () => {
  assert.throws(() => validatePack({}), /a11y-audit-pack/);
  assert.throws(() => validatePack({ format: 'a11y-audit-pack', version: 1, packageId: 'p', origin: 'x' }), /问题列表/);
  const { state, pack } = loadStateSeed();
  const beforeCount = state.issues.length;
  assert.throws(() => applyPackage(state, { ...pack, issues: null as unknown as AuditIssue[] }));
  assert.equal(state.issues.length, beforeCount, '校验失败时原状态不变');
});

void buildPackage;
void contribution;
void loadStateSeed;

console.log(`\n${process.exitCode ? '存在失败用例' : `全部通过：${passed} 个用例`}`);

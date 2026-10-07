/** merge.test.ts 的构造辅助，不进应用构建产物 */
import { fingerprintOf } from '../src/lib/audit/fingerprint';
import { buildPackage } from '../src/lib/audit/merge';
import { contribution, createIssue, seedState } from '../src/lib/audit/factory';
import type { IssuePackage, WorkbenchState } from '../src/lib/audit/types';

export { contribution, createIssue, retest, transition } from '../src/lib/audit/factory';

/**
 * 构造“办公室 + 现场包”基线：
 * - 办公室有 issue-1（triaged）和 issue-2
 * - 现场包导出了 issue-1 的快照，并在其上补充了步骤/人群/证据（不含状态流转，由各用例自行添加）
 * - 现场包还带一个办公室没有的新问题（指纹不同）
 */
export function loadStateSeed(): { state: WorkbenchState; pack: IssuePackage; matchedId: string } {
  const state = seedState();
  const target = structuredClone(state.issues[0]);
  if (target.id !== 'issue-1') throw new Error('种子数据缺少 issue-1');

  const pack = buildPackage({ ...state, issues: [target] }, '现场审计员·小王', new Date(Date.now() - 25 * 60_000).toISOString());
  const packedIssue = pack.issues[0];
  packedIssue.sources = Array.from(new Set([...packedIssue.sources, pack.origin]));
  packedIssue.steps.push(contribution('4. 现场补充：弱网环境下读屏会先朗读遮罩层，顺序错乱', pack.origin, new Date(Date.now() - 15 * 60_000).toISOString()));
  packedIssue.impactGroups.push(contribution('低视力用户（高对比度模式下遮罩透明度异常）', pack.origin, new Date(Date.now() - 14 * 60_000).toISOString()));
  packedIssue.evidence.push(contribution('现场录屏 evidence-field-01.mp4：NVDA 焦点行停留在关闭按钮上', pack.origin, new Date(Date.now() - 13 * 60_000).toISOString()));

  const fieldIssue = createIssue({
    title: '现场新发现：验证码图片无文字替代',
    flow: '登录注册',
    stepsText: '1. 进入登录页\n2. 定位图形验证码\n3. 读屏无法获取任何说明',
    impactGroup: '读屏用户',
    severity: 'serious',
    evidenceText: '照片 evidence-field-02.jpg'
  }, pack.origin, new Date(Date.now() - 10 * 60_000).toISOString());
  pack.issues.push(fieldIssue);

  return { state, pack, matchedId: 'issue-1' };
}

export function expectFingerprintEqual(a: string, b: string): boolean {
  return fingerprintOf({ title: a, flow: '', stepsText: '' }) === fingerprintOf({ title: b, flow: '', stepsText: '' });
}

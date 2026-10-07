/**
 * 问题指纹：对标题、业务流程、复现步骤的规范化文本做稳定哈希。
 * 现场包与工作台用同一套规则计算，同一处缺陷指纹一致，互不依赖机器生成的 UUID。
 */

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

function fnv1a32(input: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[\s　]+/g, '')
    .replace(/[，。；：、！？,.!?;:（）()\[\]【】"'`~@#$%^&*_\-+=<>/\\|]+/g, '');
}

export function fingerprintOf(parts: { title: string; flow: string; stepsText: string }): string {
  const canonical = [parts.title, parts.flow, parts.stepsText].map(normalizeText).join('|');
  return `fp-${fnv1a32(canonical)}`;
}

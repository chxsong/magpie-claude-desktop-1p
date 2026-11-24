import { targetModel } from './models.mjs';

// Desktop's Code process reports its entry point in User-Agent.
export function isDesktop(headers) {
  return /^claude-cli\/\S+ \([^)]*\bclaude-desktop\b/.test(String(headers['user-agent'] || ''));
}

export function resolveModel(requested, models) {
  if (typeof requested !== 'string' || !requested.startsWith('magpie/')) return { reason: 'native-model' };
  const target = targetModel(requested, models);
  return target
    ? { target, reason: 'desktop-picker' }
    : { status: 404, reason: 'missing-magpie-model', error: '该 Magpie 模型已不在目录中，请在 Desktop 重新选择模型' };
}

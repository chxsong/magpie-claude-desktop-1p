// Capability subtrees can contain display hints too; never copy those hints.
function capability(value) {
  if (Array.isArray(value)) return value.map(capability);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:notice|badge|tooltip|description|marketing|promotion|banner|warning|hint)/i.test(key)).map(([key, v]) => [key, capability(v)]));
}
export const modelID = id => 'magpie/' + id;
export function modelList(env) {
  const raw = JSON.parse(env.MAGPIE_1P_MODELS || '[]');
  if (!Array.isArray(raw) || raw.length > 2000) throw new Error('Invalid Magpie model catalog');
  const seen = new Set();
  return raw.filter(m => m && typeof m.id === 'string' && m.id.length <= 512 && !seen.has(m.id) && seen.add(m.id));
}
export function targetModel(id, models) {
  const base = String(id).replace(/@(low|medium|high|xhigh|max|ultra|minimal|none)$/, '');
  return models.find(m => modelID(m.id) === base)?.id;
}
export function injectModels(json, models, status = {}) {
  // Only known Code-backed surfaces; chat, voice and unknown surfaces are untouched.
  const surfaces = json?.model_selector_config;
  if (!Array.isArray(surfaces)) return 0;
  let count = 0;
  for (const surface of surfaces) {
    if (!['code', 'ccd', 'ccr'].includes(surface.id) || !Array.isArray(surface.models)) continue;
    const template = surface.models.find(m => m.id?.startsWith('claude-') && !Object.hasOwn(m, 'minimum_tier') && !m.disabled && m.section === 'main');
    if (!template) { status.injection = 'no-eligible-template'; continue; }
    const ids = new Set(surface.models.map(m => m.id));
    for (const model of models) {
      const id = modelID(model.id);
      if (ids.has(id)) continue;
      // Copy only structural/capability fields, never marketing or eligibility hints.
      const entry = Object.fromEntries(['section', 'thinking', 'supports_vision', 'supports_tools', 'supports_thinking', 'capabilities', 'effort_options', 'max_output_tokens'].filter(k => Object.hasOwn(template, k)).map(k => [k, capability(template[k])]));
      entry.id = id; entry.name = 'Magpie · ' + (model.name || model.id); entry.disabled = false;
      entry.section = 'main';
      if (Number.isFinite(model.context) && model.context > 0) entry.context_window = model.context;
      if (entry.thinking?.effort_options && Array.isArray(model.efforts)) {
        entry.thinking.effort_options = entry.thinking.effort_options.filter(option => model.efforts.includes(typeof option === 'string' ? option : option.value ?? option.id));
      }
      surface.models.push(entry); ids.add(id); count++;
    }
  }
  if (count) status.injection = 'injected';
  return count;
}

import { VideoError } from './provider.mjs';

export const VIDEO_LANGUAGES = [{ id: 'zh', name: '中文' }, { id: 'en', name: '英语' }, { id: 'ms', name: '马来语' }];
export function targetLanguage(value = 'zh') {
  if (!VIDEO_LANGUAGES.some(item => item.id === value)) throw new VideoError('请选择中文、英语或马来语。', 400, 'VIDEO_LANGUAGE_INVALID');
  return value;
}
export function normalizeLanguage(value) {
  const code = String(value || '').toLowerCase().split(/[-_]/)[0];
  return ({ eng: 'en', english: 'en', msa: 'ms', may: 'ms', malay: 'ms', zho: 'zh', chi: 'zh', cmn: 'zh', chinese: 'zh' })[code]
    || (/^[a-z]{2,3}$/.test(code) && !['und', 'unk'].includes(code) ? code : null);
}
export function languageRoute(speech, selected) {
  const target = targetLanguage(selected), source = normalizeLanguage(speech?.language);
  // Chinese explicitly retains the original workflow, even for foreign sources.
  if (target === 'zh') return { source, target, translate: false, reason: 'chinese-original' };
  if (!source || !speech?.text?.trim() || speech.languageMethod !== 'scribe+transcript-classification'
    && Number.isFinite(speech.languageConfidence) && speech.languageConfidence < .8) {
    throw new VideoError('原视频语言未能可靠识别，请换用语言清晰的单人口播视频；尚未启动翻译配音或对口型。', 422, 'VIDEO_LANGUAGE_UNCERTAIN');
  }
  return { source, target, translate: source !== target, reason: source === target ? 'same-language' : 'different-language' };
}

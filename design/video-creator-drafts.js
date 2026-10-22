export function draftSnapshot(state) {
  return {
    id: state.draftId, conversationId: state.session?.id || null,
    skill: state.skill, settings: { ...state.settings }, input: state.input,
    prompt: state.prompt, stage: state.stage, scriptId: state.scriptId,
    referenceImageIds: state.referenceImageIds, selectedTask: state.selectedTask,
    title: (state.input || state.prompt || '').replace(/[#*@\n]/g, ' ').trim().slice(0, 28) || '未命名草稿',
  };
}

export function remapMaterialReferences(text, before, after, replacements = {}) {
  const oldImages = before.filter(a => a.type === 'image'), images = after.filter(a => a.type === 'image');
  const oldSounds = before.filter(a => a.type === 'audio'), sounds = after.filter(a => a.type === 'audio');
  return String(text || '').replace(/\[已移除(?:图片|声音)\d+\]|@?(图片|image|声音|音频)(\d+)(?!\d)/gi, (token, kind, number) => {
    if (!kind) return token;
    const image = /图片|image/i.test(kind), old = (image ? oldImages : oldSounds)[Number(number) - 1];
    if (!old) return token;
    const id = replacements[old.id] || old.id;
    const index = (image ? images : sounds).findIndex(a => a.id === id);
    return index < 0 ? `[已移除${image ? '图片' : '声音'}${number}]` : `@${image ? '图片' : '声音'}${index + 1}`;
  });
}

export const hasMissingReferences = text => /\[已移除(?:图片|声音)\d+\]/.test(text || '');

const studioState = {
  mix: { activeId: null },
};

function selectedMedia(mode, ctx) {
  const kind = mode === 'mix' ? 'video' : 'image';
  return ctx.configs[mode].files
    .map(id => ctx.assets.find(asset => asset.id === id))
    .filter(asset => asset && asset.type === kind);
}

function selectOptions(values, value, esc) {
  return values.map(item => `<option value="${esc(item)}" ${item === value ? 'selected' : ''}>${esc(item)}</option>`).join('');
}

function studioHeader(mode, ctx) {
  const { icon, button, esc, storeInfo } = ctx;
  return `<header class="studio-header">
    <div class="studio-heading"><span class="studio-mode-icon">${icon(mode)}</span><div><h1>${mode === 'mix' ? 'AI 混剪' : '数字人口播'}</h1><p>${mode === 'mix' ? '把门店、产品与生产实拍，剪成一条宣传片' : '用你的形象，讲清产品、服务与合作'}</p></div></div>
    <div class="studio-header-actions">${button('store', icon('store') + `<span>${esc(storeInfo.name || '商家资料')}</span>`, 'studio-text-button')}${button('prompts', icon('list') + '<span>我的草稿</span>', 'studio-quiet-button','aria-label="我的草稿"')}${button('saveprompt', icon('save') + '<span>保存草稿</span>', 'studio-quiet-button','aria-label="保存草稿"')}</div>
  </header>`;
}

function mixMaterials(media, ctx) {
  const { icon, button, esc } = ctx;
  const activeId = studioState.mix.activeId;
  return `<section class="studio-materials" aria-labelledby="mix-material-title">
    <div class="studio-section-head"><h2 id="mix-material-title">实拍素材 <span>${media.length}</span></h2>${button('upload', icon('plus'), 'studio-square-button', 'aria-label="添加实拍视频" title="添加视频"')}</div>
    <div class="studio-section-tab"><span class="active">视频素材</span><small>最多 30 段</small></div>
    ${button('upload', icon('plus') + '添加本地视频', 'studio-add-material')}
    ${media.length ? `<div class="studio-media-list">${media.map((asset, index) => `<button class="studio-media-item ${asset.id === activeId ? 'selected' : ''}" data-action="studio-select-clip" data-id="${esc(asset.id)}" aria-pressed="${asset.id === activeId}">
      <span class="studio-media-thumb"><video src="${esc(asset.url)}" muted preload="metadata" tabindex="-1" aria-hidden="true"></video><b>${String(index + 1).padStart(2, '0')}</b></span><span class="studio-media-title"><strong>${esc(asset.name)}</strong><small data-duration-id="${esc(asset.id)}">视频素材</small></span>${icon('chevron')}
    </button>`).join('')}</div>` : `<div class="studio-material-empty"><p>这些镜头都能派上用场</p><ol><li><span>01</span><div><strong>门店 / 车间环境</strong><small>让客户看见真实经营场所</small></div></li><li><span>02</span><div><strong>产品 / 工艺细节</strong><small>拍清产品特色与加工能力</small></div></li><li><span>03</span><div><strong>服务 / 生产过程</strong><small>用真实过程说明你能做什么</small></div></li></ol></div>`}
    <div class="studio-material-footer">${icon('folder')}<span>选中片段即可预览与调整顺序</span></div>
  </section>`;
}

function mixPreview(media, ctx) {
  const { button, icon, esc, configs } = ctx;
  const c = configs.mix;
  const active = media.find(asset => asset.id === studioState.mix.activeId);
  return `<section class="studio-preview mix-preview" aria-labelledby="mix-preview-title">
    <div class="studio-preview-heading"><h2 id="mix-preview-title">${active ? '素材预览' : '视频预览'}</h2>${button('settings', `${esc(c.ratio)} ${icon('chevron')}`, 'studio-ratio-button', 'aria-label="调整视频比例与分辨率"')}</div>
    <div class="mix-screen ${active ? 'has-video' : ''}">${active ? `<video id="studio-video-preview" src="${esc(active.url)}" controls playsinline preload="metadata" aria-label="${esc(active.name)}"></video>` : `<div class="mix-screen-empty"><span class="studio-film-mark">${icon('video')}</span><h3>让随手拍的片段，连成故事</h3><p>添加产品、服务或生产实拍，从一条宣传片开始</p>${button('upload', icon('plus') + '添加视频', 'studio-screen-button')}</div>`}</div>
    <div class="studio-preview-caption"><span>${active ? `${icon('video')} ${esc(active.name)}` : '先准备素材，再决定怎么讲'}</span><small>${active ? '原始视频' : `${esc(c.quality)} · ${esc(c.ratio)}`}</small></div>
  </section>`;
}

function mixInspector(ctx) {
  const { configs, button, icon, esc, modules } = ctx;
  const c = configs.mix;
  const media = selectedMedia('mix', ctx);
  return `<aside class="studio-inspector" aria-labelledby="mix-setting-title">
    <div class="studio-section-head"><h2 id="mix-setting-title">剪辑设置</h2>${button('settings', icon('settings'), 'studio-square-button', 'aria-label="更多视频设置" title="更多视频设置"')}</div>
    <div class="studio-inspector-body">
      ${ctx.renderBusinessEntry?.('mix') || ''}<label class="studio-field">宣传主题<select data-studio-field="skill">${selectOptions(modules.mix.names.map(item => item[0]), c.skill, esc)}</select></label>
      <label class="studio-field studio-script-field">剪辑要求<textarea id="studio-prompt" maxlength="2000" placeholder="例如：先展示门店或车间，再拍产品细节与服务或生产过程，最后说明到店方式或询价所需资料。">${esc(c.prompt)}</textarea><span class="studio-char-count" id="studio-char-count">${c.prompt.length} / 2000</span></label>
      <div class="studio-dual-fields"><label class="studio-field">目标时长<select data-studio-field="duration">${selectOptions(Array.from({length: 11}, (_, index) => String(10 + index * 5)), c.duration, esc)}</select><span class="studio-select-unit">秒</span></label><label class="studio-field">成片数量<select data-studio-field="count">${selectOptions(['1', '3', '5'], c.count, esc)}</select><span class="studio-select-unit">条</span></label></div>
      <div class="studio-setting-divider"></div>
      <label class="studio-switch-row"><span><strong>自动字幕</strong><small>让静音观看也能看懂</small></span><input type="checkbox" data-studio-field="subtitles" ${c.subtitles ? 'checked' : ''}><i aria-hidden="true"></i></label>
      <label class="studio-switch-row"><span><strong>背景音乐</strong><small>按宣传主题匹配节奏</small></span><input type="checkbox" data-studio-field="music" ${c.music ? 'checked' : ''}><i aria-hidden="true"></i></label>
      ${button('settings', `<span>成片规格</span><strong>${esc(c.ratio)} · ${esc(c.quality)}</strong>${icon('chevron')}`, 'studio-setting-link')}
    </div>
    <footer class="studio-inspector-footer">${button('studio-generate', icon('star') + '开始智能混剪', 'studio-primary', media.length ? '' : 'disabled title="请先添加实拍视频"')}<span>${media.length ? `${media.length} 段素材已就绪` : '添加视频后即可开始'}</span></footer>
  </aside>`;
}

function mixTimeline(media, ctx) {
  const { button, icon, esc } = ctx;
  const activeIndex = media.findIndex(asset => asset.id === studioState.mix.activeId);
  const current = media[activeIndex];
  return `<section class="studio-timeline" aria-labelledby="mix-timeline-title"><div class="studio-timeline-toolbar"><div><h2 id="mix-timeline-title">素材编排</h2><span>${media.length ? `${media.length} 个片段` : '按叙事顺序排列素材'}</span></div><div class="studio-reorder">${button('studio-move-before', icon('back'), 'studio-square-button', `aria-label="选中片段向前移动" title="向前移动" ${activeIndex <= 0 ? 'disabled' : ''}`)}${button('studio-move-after', icon('arrow'), 'studio-square-button', `aria-label="选中片段向后移动" title="向后移动" ${activeIndex < 0 || activeIndex === media.length - 1 ? 'disabled' : ''}`)}<span></span>${button('studio-remove-clip', icon('trash'), 'studio-square-button', `aria-label="移除选中片段" title="移除片段" ${current ? '' : 'disabled'}`)}</div></div>
    <div class="studio-timeline-track"><div class="studio-track-label">${icon('video')}<span>视频</span></div><div class="studio-clip-strip">${media.length ? media.map((asset, index) => `<button class="studio-timeline-clip ${asset.id === studioState.mix.activeId ? 'selected' : ''}" data-action="studio-select-clip" data-id="${esc(asset.id)}" aria-label="第 ${index + 1} 段：${esc(asset.name)}" aria-pressed="${asset.id === studioState.mix.activeId}"><span class="studio-clip-order">${String(index + 1).padStart(2, '0')}</span><video src="${esc(asset.url)}" muted preload="metadata" tabindex="-1" aria-hidden="true"></video><span class="studio-clip-name">${esc(asset.name)}</span></button>`).join('') + button('upload', icon('plus'), 'studio-track-add', 'aria-label="添加更多视频片段"') : button('upload', icon('plus') + '添加实拍视频，开始编排', 'studio-empty-track')}</div></div>
    <div class="studio-track-note">${current ? `正在查看：${esc(current.name)}` : '选择片段后，可用上方箭头调整前后顺序'}</div>
  </section>`;
}

function avatarMaterials(media, ctx) {
  const { button, icon, esc, configs } = ctx;
  const c = configs.avatar;
  const current = media[0];
  return `<section class="studio-materials avatar-materials" aria-labelledby="avatar-material-title"><div class="studio-section-head"><h2 id="avatar-material-title">出镜形象</h2>${button('person', icon('settings'), 'studio-square-button', 'aria-label="设置形象与背景" title="形象设置"')}</div>
    <div class="studio-section-tab"><span class="active">我的形象</span><small>${media.length} 个</small></div>
    ${current ? `<button class="studio-person-card selected" data-action="upload" aria-label="更换出镜照片"><img src="${esc(current.url)}" alt="${esc(current.name)}"><span class="studio-person-check">${icon('check')}</span><span class="studio-person-label"><strong>${esc(c.person)}</strong><small>点击更换照片</small></span></button>` : button('upload', `<span class="studio-person-add">${icon('plus')}</span><strong>上传本人照片</strong><small>用真实形象，介绍自己的生意</small>`, 'studio-add-person')}
    <label class="studio-field studio-person-role">出镜身份<select data-studio-field="person">${selectOptions(['老板本人', '店员形象', '授权主持人'], c.person, esc)}</select></label>
    <div class="studio-photo-guide"><h3>一张好照片，就能开始</h3><div><span>01</span><p>正面看向镜头，五官清晰</p></div><div><span>02</span><p>光线均匀，避免遮挡面部</p></div><div><span>03</span><p>建议使用半身照片</p></div></div>
    <div class="studio-material-footer">${icon('avatar')}<span>请使用本人或已获授权的形象</span></div>
  </section>`;
}

function avatarPreview(media, ctx) {
  const { configs, esc, button, icon, storeInfo } = ctx;
  const c = configs.avatar;
  const image = media[0];
  const reference = ctx.media?.owner || ctx.studioImages?.avatar || '/media/owner-reference.png';
  return `<section class="studio-preview avatar-preview" aria-labelledby="avatar-preview-title"><div class="studio-preview-heading"><h2 id="avatar-preview-title">形象预览</h2>${button('settings', `${esc(c.ratio)} ${icon('chevron')}`, 'studio-ratio-button', 'aria-label="调整口播视频规格"')}</div>
    <div class="studio-portrait-wrap"><div class="studio-portrait ${image || reference ? 'has-portrait' : ''}">
      ${image || reference ? `<img src="${esc(image?.url || reference)}" alt="${image ? esc(image.name) : '虚构门店老板的形象参考'}"><span class="studio-preview-label">${image ? '照片预览' : '示例形象'}</span>${image && c.subtitles && c.prompt.trim() ? `<span class="studio-avatar-caption" id="studio-avatar-caption">${esc(c.prompt.trim().slice(0, 45))}</span>` : ''}` : `<div class="studio-portrait-empty"><span class="studio-portrait-corner corner-tl"></span><span class="studio-portrait-corner corner-tr"></span><span class="studio-portrait-corner corner-bl"></span><span class="studio-portrait-corner corner-br"></span><div><span class="studio-portrait-kicker">YOUR STORY, YOUR VOICE</span><h3>这次，让老板<br>亲自来说</h3><p>一张照片，一段话<br>开始你的第一条宣传口播</p>${button('upload', icon('plus') + '添加形象照片', 'studio-portrait-upload')}</div></div>`}
    </div></div>
    <div class="studio-portrait-description"><strong>${image ? esc(c.person) : '上传照片，预览你的出镜形象'}</strong><span>${image ? esc(storeInfo.name || image.name) : '正面半身照 · 清晰自然 · 光线均匀'}</span></div>
    <div class="studio-avatar-preview-settings">${button('person', icon('image') + esc(c.background), 'studio-preview-chip')}${button('voice', icon('audio') + esc(c.voice), 'studio-preview-chip')}</div>
  </section>`;
}

function avatarInspector(media, ctx) {
  const { configs, button, icon, esc } = ctx;
  const c = configs.avatar;
  return `<aside class="studio-inspector avatar-inspector" aria-labelledby="avatar-script-title"><div class="studio-section-head"><h2 id="avatar-script-title">口播内容</h2>${button('script', icon('star') + '文案模板', 'studio-text-button')}</div>
    <div class="studio-inspector-body"><div class="studio-script-label"><label for="studio-prompt">你想对客户说什么？</label>${button('store', icon('store'), 'studio-square-button', 'aria-label="补充商家资料" title="商家资料"')}</div><div class="studio-avatar-script"><textarea id="studio-prompt" maxlength="3000" placeholder="大家好，我是这家店的老板。\n\n今天想给大家介绍一下我们的招牌项目……">${esc(c.prompt)}</textarea><div><span id="studio-speech-length">${c.prompt.trim() ? `预计口播 ${Math.max(1, Math.round(c.prompt.replace(/\s/g, '').length / 4))} 秒` : '建议 30–60 秒，讲清一个主题'}</span><small id="studio-char-count">${c.prompt.length} / 3000</small></div></div>
      <div class="studio-script-ideas">${[['老板介绍', '认识我的店'], ['招牌讲解', '介绍招牌'], ['活动通知', '活动通知']].map(([value, label]) => button('studio-script-idea', label, '', `data-value="${value}"`)).join('')}</div>
      <div class="studio-setting-divider"></div><label class="studio-field-label">口播声音</label>${button('voice', `<span class="studio-voice-icon">${icon('audio')}</span><span><strong>${esc(c.voice)}</strong><small>中文 · 自然表达</small></span>${icon('chevron')}`, 'studio-voice-select')}
      <label class="studio-field studio-background-field">画面背景<select data-studio-field="background">${selectOptions(['门店实景', '简洁背景', '形象原背景'], c.background, esc)}</select></label>
      <label class="studio-switch-row"><span><strong>添加字幕</strong></span><input type="checkbox" data-studio-field="subtitles" ${c.subtitles ? 'checked' : ''}><i aria-hidden="true"></i></label>
      ${button('settings', `<span>视频规格</span><strong>${esc(c.ratio)} · ${esc(c.quality)}</strong>${icon('chevron')}`, 'studio-setting-link')}
    </div><footer class="studio-inspector-footer">${button('studio-generate', icon('star') + '生成口播视频', 'studio-primary', media.length && c.prompt.trim() ? '' : 'disabled title="请添加形象照片并填写口播文案"')}<span id="studio-generation-hint">${!media.length ? '先添加一张形象照片' : !c.prompt.trim() ? '写几句话，让形象开口表达' : '形象和文案已准备好'}</span></footer>
  </aside>`;
}

export function renderStudio(mode, ctx) {
  if (!['mix', 'avatar'].includes(mode)) return '';
  const media = selectedMedia(mode, ctx);
  if (mode === 'mix' && !media.some(asset => asset.id === studioState.mix.activeId)) studioState.mix.activeId = media[0]?.id || null;
  return studioHeader(mode, ctx) + `<div class="studio-layout">${mode === 'mix'
    ? mixMaterials(media, ctx) + mixPreview(media, ctx) + mixInspector(ctx) + mixTimeline(media, ctx)
    : avatarMaterials(media, ctx) + avatarPreview(media, ctx) + avatarInspector(media, ctx)}</div>`;
}

export function bindStudio(mode, ctx) {
  const root = document.querySelector('.special-workspace');
  if (!root) return;
  const c = ctx.configs[mode];
  root.querySelectorAll('[data-studio-field]').forEach(input => {
    input.addEventListener('change', () => {
      c[input.dataset.studioField] = input.type === 'checkbox' ? input.checked : input.value;
      if (input.dataset.studioField === 'person' || input.dataset.studioField === 'background' || input.dataset.studioField === 'subtitles') ctx.refresh();
    });
  });
  root.querySelector('#studio-prompt')?.addEventListener('input', event => {
    c.prompt = event.target.value;
    root.querySelector('#studio-char-count').textContent = `${c.prompt.length} / ${mode === 'mix' ? 2000 : 3000}`;
    if (mode === 'avatar') {
      const length = root.querySelector('#studio-speech-length');
      length.textContent = c.prompt.trim() ? `预计口播 ${Math.max(1, Math.round(c.prompt.replace(/\s/g, '').length / 4))} 秒` : '建议 30–60 秒，讲清一个主题';
      const hasImage = selectedMedia(mode, ctx).length > 0;
      const generateButton = root.querySelector('[data-action="studio-generate"]');
      generateButton.disabled = !hasImage || !c.prompt.trim();
      generateButton.title = generateButton.disabled ? '请添加形象照片并填写口播文案' : '';
      root.querySelector('#studio-generation-hint').textContent = !hasImage ? '先添加一张形象照片' : !c.prompt.trim() ? '写几句话，让形象开口表达' : '形象和文案已准备好';
      const portrait = root.querySelector('.studio-portrait.has-portrait');
      let caption = root.querySelector('#studio-avatar-caption');
      if (portrait && hasImage && c.subtitles && c.prompt.trim()) {
        if (!caption) {
          caption = document.createElement('span');
          caption.id = 'studio-avatar-caption';
          caption.className = 'studio-avatar-caption';
          portrait.append(caption);
        }
        caption.textContent = c.prompt.trim().slice(0, 45);
      } else caption?.remove();
    }
  });
  root.querySelectorAll('.studio-media-item video').forEach(video => {
    video.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(video.duration)) return;
      const label = video.closest('.studio-media-item').querySelector('[data-duration-id]');
      const seconds = Math.round(video.duration);
      if (label) label.textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')} · 原始片段`;
    });
  });
}

export function handleStudioAction(action, el, ctx) {
  if (!action.startsWith('studio-')) return false;
  const mode = document.querySelector('.avatar-studio') ? 'avatar' : 'mix';
  const c = ctx.configs[mode];
  switch (action) {
    case 'studio-select-clip':
      if (selectedMedia('mix', ctx).some(asset => asset.id === el.dataset.id)) studioState.mix.activeId = el.dataset.id;
      ctx.refresh();
      break;
    case 'studio-move-before':
    case 'studio-move-after': {
      const videos = selectedMedia('mix', ctx);
      const index = videos.findIndex(asset => asset.id === studioState.mix.activeId);
      const next = index + (action === 'studio-move-before' ? -1 : 1);
      if (index >= 0 && next >= 0 && next < videos.length) {
        const from = c.files.indexOf(videos[index].id);
        const to = c.files.indexOf(videos[next].id);
        [c.files[from], c.files[to]] = [c.files[to], c.files[from]];
        ctx.refresh();
      }
      break;
    }
    case 'studio-remove-clip':
      c.files = c.files.filter(id => id !== studioState.mix.activeId);
      studioState.mix.activeId = null;
      ctx.refresh();
      break;
    case 'studio-script-idea': {
      const { name, feature, address } = ctx.storeInfo;
      const skill = el.dataset.value;
      const scripts = {
        '老板介绍': `大家好，我是${name || '【门店名称】'}的老板。\n\n我们最想让你体验的是${feature || '【招牌项目与特色】'}。\n\n门店在${address || '【门店地址】'}，欢迎有空来坐坐。`,
        '招牌讲解': `今天给大家介绍一下${name || '【门店名称】'}的招牌项目。\n\n${feature || '【项目特色，以及值得体验的理由】'}。\n\n欢迎来店里亲自体验。`,
        '活动通知': `${name || '【门店名称】'}的朋友们，我们准备了一场【活动名称】！\n\n【活动时间】到店，可以享受【真实优惠与参与方式】。\n\n门店就在${address || '【门店地址】'}，期待见到你。`,
      };
      if (!Object.hasOwn(scripts, skill)) break;
      if (c.prompt.trim()) {
        ctx.openModal('使用这份口播模板？', '替换当前文案后，可继续补充门店的真实信息。', `<div class="studio-template-preview">${ctx.esc(scripts[skill]).replace(/\n/g, '<br>')}</div><footer class="modal-actions">${ctx.button('cancel', '保留原文', 'secondary')}${ctx.button('studio-use-template', '使用模板', 'primary', `data-value="${ctx.esc(skill)}"`)}</footer>`);
      } else {
        c.skill = skill;
        c.prompt = scripts[skill];
        ctx.refresh();
        ctx.toast('已填入文案模板，请补齐实际信息。');
      }
      break;
    }
    case 'studio-use-template': {
      c.prompt = '';
      document.querySelector('#modal')?.close();
      handleStudioAction('studio-script-idea', el, ctx);
      break;
    }
    case 'studio-generate':
      if (mode === 'mix' && !selectedMedia(mode, ctx).length) ctx.toast('请先添加一段门店实拍视频。');
      else if (mode === 'avatar' && (!selectedMedia(mode, ctx).length || !c.prompt.trim())) ctx.toast('请添加形象照片，并写下口播内容。');
      else ctx.generate();
      break;
    default: return false;
  }
  return true;
}

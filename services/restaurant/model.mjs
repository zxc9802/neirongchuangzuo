import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequestLedger } from '../ai/request-ledger.mjs';
import { RestaurantError, fingerprint, validateAnalysis, validateDirections, validateCopy, validateAudit, validateFoodAppearance, validateFoodRenderReview } from './rules.mjs';
import { ANALYSIS_PROMPT, GALLERY_ANALYSIS_PROMPT, GALLERY_STORYBOARD_PROMPT, RECOMMEND_PROMPT, RECOMMEND_REPAIR_PROMPT, COPY_PROMPT, COPY_REWRITE_PROMPT, AUDIT_PROMPT, FOOD_IDENTITY_PROMPT, FOOD_RENDER_AUDIT_PROMPT } from './prompts.mjs';
import { recommendationQualityIssues } from './recommendation-quality.mjs';
import { createFoodRenderer } from './food-renderer.mjs';

/** Separate durable provider-attempt budget. User package charges live in the store. */
export function createRestaurantModel({ config, storageDir, fetchImpl = fetch, now = Date.now, timeoutMs = 90_000, ledger: injectedLedger,
  sleepImpl = sleep, budgetWaitMaxMs = 120_000, budgetWaitStepMs = 5_000 } = {}) {
  const ledger = injectedLedger ?? createRequestLedger({ storageDir, now, limits: config.limits });
  const ready = ledger.ready;
  let stopping = false;
  const renderFood = createFoodRenderer({ config, ledger, fetchImpl, isStopping: () => stopping, sleepImpl, budgetWaitMaxMs, budgetWaitStepMs });
  async function call(prompt, input, photos = [], { onBudgetWait, temperature = 0.3 } = {}) {
    if (!config.apiKey) throw new RestaurantError('尚未配置内容分析接口，请联系管理员。', 503, 'MODEL_NOT_CONFIGURED');
    const id = randomUUID();
    const model = config.imageTextModel || config.chatModel;
    const body = { model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: photos.length ? [{ type: 'text', text: JSON.stringify(input) }, ...photos.map(photo => ({ type: 'image_url', image_url: { url: photo.dataUrl, detail: 'high' } }))] : JSON.stringify(input) }], response_format: { type: 'json_object' }, temperature };
    let waitedMs = 0;
    async function beforeDispatch(operation) {
      while (true) {
        if (stopping) throw new RestaurantError('服务正在关闭，尚未发送新的模型请求。', 503, 'SERVICE_CLOSING');
        try { return await operation(); }
        catch (cause) {
          if (cause.code !== 'RATE_LIMITED' || waitedMs >= budgetWaitMaxMs) throw cause;
          await onBudgetWait?.({ waitedMs });
          const delayMs = Math.min(5_000, Math.max(1, budgetWaitStepMs), budgetWaitMaxMs - waitedMs);
          await sleepImpl(delayMs); waitedMs += delayMs;
        }
      }
    }
    await beforeDispatch(() => ledger.reserve({ id, kind: 'chat', model, fingerprint: fingerprint(body) }));
    const controller = new AbortController(); let dispatched = false, responseReceived = false, responseOK = false, bodyComplete = false, timer;
    try {
      if (stopping) throw new RestaurantError('服务正在关闭，尚未发送新的模型请求。', 503, 'SERVICE_CLOSING');
      await beforeDispatch(() => ledger.markDispatched(id)); dispatched = true;
      timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      responseReceived = true;
      responseOK = response.ok;
      if (!response.ok) throw Object.assign(new RestaurantError(response.status === 429 || response.status === 402 ? '内容分析服务额度不足或请求过于频繁。' : '内容分析服务暂时不可用，请联系管理员。', 502, 'PROVIDER_ERROR'), { providerStatus: response.status });
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new RestaurantError('模型返回过大，已停止接收。', 502, 'MODEL_INVALID_OUTPUT'); chunks.push(chunk); }
      bodyComplete = true;
      let payload, result;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof payload.choices?.[0]?.message?.content !== 'string' || payload.choices?.[0]?.finish_reason === 'length') throw new Error('truncated');
        const content = payload.choices[0].message.content.trim();
        const fenced = content.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
        result = JSON.parse(fenced ? fenced[1] : content);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('schema');
      } catch { throw new RestaurantError('模型没有返回完整的结构化结果，任务已停止。', 502, 'MODEL_INVALID_OUTPUT'); }
      await ledger.finish(id, { status: 'completed', usage: payload.usage, providerRequestId: payload.id });
      return result;
    } catch (cause) {
      if (cause.code === 'MODEL_INVALID_OUTPUT') cause.providerResponseComplete = bodyComplete;
      const uncertain = dispatched && (!responseReceived || controller.signal.aborted || (responseOK && !bodyComplete && cause.code !== 'MODEL_INVALID_OUTPUT'));
      await ledger.finish(id, { status: uncertain ? 'uncertain' : dispatched ? 'failed' : 'cancelled', code: uncertain ? 'PROVIDER_UNCERTAIN' : cause.code || 'PROVIDER_ERROR' }).catch(() => {});
      if (uncertain) throw new RestaurantError('模型请求结果未确认，上游可能已执行。请管理员核对调用记录后再重新发起，系统不会自动重复请求。', 502, 'PROVIDER_UNCERTAIN');
      throw cause;
    } finally { clearTimeout(timer); }
  }
  return {
    ready,
    enabled: Boolean(config.apiKey),
    renderFood,
    async renderStylePhoto({ photo, reference, context = [], prompt, style, taskId, imageId, recipeId, recipeVersion, attempt = 0, corrections = [] }, options) {
      const instruction = `${prompt}\n\nThe LAST image is the accepted finished version of this SAME original. It is the authoritative STYLE TARGET, not a new scene or a new subject. Keep its palette, exposure balance, light temperature, contrast, photographic texture and overall framing. Small natural detail differences are allowed. Do not reinterpret this as a new aesthetic, change time of day, introduce a different filter, or homogenize the bar and riverside nightscape. Image 1 remains the source of the real subjects and their identities. Any middle images are optional real context. Never add or remove primary subjects or regenerate a visible person's face.\nFixed style: ${JSON.stringify(style)}${corrections.length ? `\nRequired style corrections: ${JSON.stringify(corrections)}` : ''}`;
      return renderFood({ photo, storeReferences: [...context.slice(0, 2), reference], promptOverride: instruction,
        requestNamespace: 'restaurant-style', nativeSize: '960x1280', taskId: `${taskId}-${recipeVersion}-${recipeId}`, imageId, attempt,
        scene: { type: 'approved-style', name: recipeId }, plan: { angle: 'original' } }, options);
    },
    async reviewStylePhoto({ photos, ...input }, options) {
      const result = await call(`你是摄影风格验收员。三张附图顺序为原图、用户已接受的成品风格、新生成成品。以第二张为审美基准，检查第三张是否保留其色调、色温、明暗、氛围、景别和摄影质感；不要按自己的喜好重新设计，不因已接受成品比原图更鲜艳、更亮或天空偏蓝而否定它。允许局部纹理、光斑、轻微构图和非关键细节差异。只有明显换滤镜、换时段、氛围与基准明显不符、主体大改、主要建筑/游船/家具增删、人物身份或动作被改变，或严重AI塑料感才要求重做。正常街景和门头文字不自动认定为营销风险。返回JSON {status:"passed|needs_revision",styleScore:0到100,issues:[具体偏差]}，passed时issues必须为空。`, input, photos, options);
      if (!['passed', 'needs_revision'].includes(result?.status) || !Number.isFinite(result.styleScore) || result.styleScore < 0 || result.styleScore > 100
        || !Array.isArray(result.issues) || result.issues.length > 12 || result.issues.some(issue => typeof issue !== 'string' || issue.length > 500)
        || result.status === 'passed' && result.issues.length || result.status === 'needs_revision' && !result.issues.length) throw new RestaurantError('图片风格检查未返回完整结果。', 502, 'MODEL_INVALID_OUTPUT');
      return { status: result.status, styleScore: result.styleScore, issues: result.issues };
    },
    async identifyFood({ analysis, photos, subjectScope, subjectFocus }, options) { return validateFoodAppearance(await call(FOOD_IDENTITY_PROMPT, { imageId: analysis.imageId,
      ...(subjectScope ? { subjectScope } : {}), ...(subjectFocus ? { subjectFocus } : {}) }, photos, options)); },
    async planGallery({ analysis, profile, outputCount, photos = [] }, options) { return call(GALLERY_STORYBOARD_PROMPT,
      { profile, images: analysis, requestedOutputCount: outputCount, visualImageIds: photos.map(photo => photo.id) }, photos, options); },
    async reviewFoodRender({ photos, ...input }, options) { return validateFoodRenderReview(await call(FOOD_RENDER_AUDIT_PROMPT, input, photos, options)); },
    async analyse(photos, profile, options) { return validateAnalysis(await call(options?.gallery ? GALLERY_ANALYSIS_PROMPT : ANALYSIS_PROMPT, { profile, images: photos.map(photo => ({ imageId: photo.id, width: photo.width, height: photo.height })) }, photos, options), photos.map(photo => photo.id)); },
    async recommend(analysis, profile, options) {
      const input = { profile, images: analysis };
      const draft = await call(RECOMMEND_PROMPT, input, [], options);
      const directions = validateDirections(draft, analysis, profile);
      // An empty, valid result is an explicit lack of reliable themes, not a request to invent one.
      if (!directions.length) return directions;
      const issues = recommendationQualityIssues({ directions, analysis, unusedImages: draft.unusedImages ?? [] });
      if (!issues.length) return directions;
      let repaired, replacement, repairReceived = false;
      try {
        repaired = await call(RECOMMEND_REPAIR_PROMPT, { ...input, draft, recommendationIssues: issues }, [], options);
        repairReceived = true;
        replacement = validateDirections(repaired, analysis, profile);
      } catch (cause) {
        // Only a known completed bad response can fall back to the existing valid draft.
        // Uncertain requests, quotas, shutdown and budget failures retain their normal stopping semantics.
        if (cause.code === 'MODEL_INVALID_OUTPUT' && (repairReceived || cause.providerResponseComplete === true)
          || cause.code === 'PROVIDER_ERROR' && cause.providerStatus && ![402, 429].includes(cause.providerStatus)) return directions;
        throw cause;
      }
      if (!replacement.length) return directions;
      const replacementIssues = recommendationQualityIssues({ directions: replacement, analysis, unusedImages: repaired.unusedImages ?? [] });
      const score = (items, qualityIssues) => [qualityIssues.length,
        -new Set(items.flatMap(item => item.supportingImageIds)).size, -items.length];
      const originalScore = score(directions, issues), replacementScore = score(replacement, replacementIssues);
      for (let index = 0; index < originalScore.length; index++) {
        if (replacementScore[index] < originalScore[index]) return replacement;
        if (replacementScore[index] > originalScore[index]) return directions;
      }
      return replacement;
    },
    async write({ profile, analysis, direction, facts, photos = [], imageMode, draft, qualityIssues = [] }, { onBudgetWait } = {}) {
      const evidenceFields = ['imageId', 'imageType', 'visibleObjects', 'possibleScene', 'privacyRisk', 'textRisk', 'riskReasons'];
      const images = analysis.map(item => Object.fromEntries(evidenceFields.filter(key => item[key] !== undefined).map(key => [key, item[key]])));
      const writingDirection = direction && { id: direction.id, label: direction.label, targetCustomer: direction.targetCustomer, consumptionScene: direction.consumptionScene };
      const input = { profile, images, direction: writingDirection, confirmedFacts: facts, imageMode, outputCount: analysis.length, visualImageIds: photos.map(photo => photo.id), ...(draft ? { draft, qualityIssues } : {}) };
      return validateCopy(await call(draft ? COPY_REWRITE_PROMPT : COPY_PROMPT, input, photos, { onBudgetWait, temperature: 0.6 }), analysis.map(item => item.imageId));
    },
    async audit({ photos = [], ...input }, { onBudgetWait } = {}) { return validateAudit(await call(AUDIT_PROMPT, { ...input, visualImageIds: photos.map(photo => photo.id) }, photos, { onBudgetWait })); },
    usage: () => ledger.summary(),
    stop: () => { stopping = true; },
    close: () => { stopping = true; return injectedLedger ? Promise.resolve() : ledger.close(); },
  };
}

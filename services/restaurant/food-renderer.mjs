import sharp from 'sharp';
import { setTimeout as sleep } from 'node:timers/promises';
import { downloadImage } from '../ai/server.mjs';
import { fingerprint, RestaurantError } from './rules.mjs';
import { foodPhotoPrompt } from './scenes.mjs';

export function createFoodRenderer({ config, ledger, fetchImpl = fetch, downloadImpl = downloadImage, isStopping = () => false,
  timeoutMs = 600_000, sleepImpl = sleep, budgetWaitMaxMs = 120_000, budgetWaitStepMs = 5_000 }) {
  return async function renderFood({ scene, photo, appearance, plan, corrections = [], attempt = 0, taskId, imageId }, { onBudgetWait } = {}) {
    if (!config.apiKey || !config.imageModel) throw new RestaurantError('尚未配置图片生成服务，请联系管理员。', 503, 'MODEL_NOT_CONFIGURED');
    const prompt = foodPhotoPrompt({ scene, appearance, plan, corrections }), id = `restaurant-food-${fingerprint({ taskId, imageId, attempt, version: 3 })}`;
    let waitedMs = 0;
    async function beforeDispatch(operation) {
      for (;;) {
        if (isStopping()) throw new RestaurantError('服务正在关闭，尚未发送新的图片请求。', 503, 'SERVICE_CLOSING');
        try { return await operation(); }
        catch (cause) {
          if (cause.code !== 'RATE_LIMITED' || waitedMs >= budgetWaitMaxMs) throw cause;
          await onBudgetWait?.({ waitedMs });
          const delay = Math.min(5_000, Math.max(1, budgetWaitStepMs), budgetWaitMaxMs - waitedMs);
          await sleepImpl(delay); waitedMs += delay;
        }
      }
    }
    const reservation = await beforeDispatch(() => ledger.reserve({ id, kind: 'image', model: config.imageModel,
      fingerprint: fingerprint({ prompt, sourceHash: fingerprint(photo.bytes.toString('base64')) }) }));
    if (reservation?.created === false) throw new RestaurantError('该菜品摄影已有调用记录，系统不会重复发送，请管理员核对原任务。', 409, 'FOOD_RENDER_ALREADY_SENT');
    const controller = new AbortController(); let dispatched = false, bodyComplete = false, responseOK = false, timer, payload, requestId;
    try {
      const form = new FormData();
      form.set('model', config.imageModel); form.set('prompt', prompt); form.set('n', '1');
      form.set('size', '1024x1536'); form.set('quality', 'high'); form.set('response_format', 'b64_json'); form.set('format', 'png');
      form.append('image', new Blob([photo.bytes], { type: photo.mime || 'image/png' }), photo.mime === 'image/jpeg' ? 'food-reference.jpg' : 'food-reference.png');
      await beforeDispatch(() => ledger.markDispatched(id)); dispatched = true;
      timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
      const response = await fetchImpl(`${config.baseUrl}/images/edits`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.apiKey}` }, body: form, signal: controller.signal });
      responseOK = response.ok; requestId = response.headers?.get('x-request-id') || undefined;
      if (!response.ok) { await response.body?.cancel(); throw new RestaurantError('菜品图片生成服务暂时不可用，请稍后重试。', 502, 'FOOD_RENDER_PROVIDER_ERROR'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 48 * 1024 * 1024) { await response.body?.cancel().catch(() => {}); throw new RestaurantError('菜品图片返回过大，已停止接收。', 502, 'FOOD_RENDER_INVALID_OUTPUT'); }
        chunks.push(chunk);
      }
      bodyComplete = true;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RestaurantError('菜品图片返回不完整。', 502, 'FOOD_RENDER_INVALID_OUTPUT'); }
      if (payload.error || payload.data?.length !== 1) throw new RestaurantError('菜品图片生成失败，未返回单张完整结果。', 502, 'FOOD_RENDER_INVALID_OUTPUT');
      const output = payload.data[0];
      let bytes;
      if (typeof output.b64_json === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(output.b64_json)) bytes = Buffer.from(output.b64_json, 'base64');
      else if (typeof output.url === 'string') bytes = await downloadImpl(output.url);
      if (!bytes?.length || bytes.length > 32 * 1024 * 1024) throw new RestaurantError('菜品图片内容不可用。', 502, 'FOOD_RENDER_INVALID_OUTPUT');
      const decoded = sharp(bytes, { limitInputPixels: 32 * 1024 * 1024, failOn: 'error' });
      const meta = await decoded.metadata();
      if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1 || meta.width < 480 || meta.height < 480) throw new RestaurantError('菜品图片格式不可用。', 502, 'FOOD_RENDER_INVALID_OUTPUT');
      bytes = await decoded.autoOrient().flatten({ background: '#fff4e4' }).resize(1080, 1440, { fit: 'contain', background: '#fff4e4' }).jpeg({ quality: 94 }).toBuffer();
      await ledger.finish(id, { status: 'completed', usage: payload.usage, providerRequestId: requestId || payload.id });
      return { bytes, scene: { type: scene.type, angle: plan.angle, name: scene.name }, plan, requestId: id };
    } catch (cause) {
      const uncertain = dispatched && (controller.signal.aborted || !bodyComplete && (responseOK || !['FOOD_RENDER_PROVIDER_ERROR'].includes(cause.code)));
      await ledger.finish(id, { status: uncertain ? 'uncertain' : dispatched ? 'failed' : 'cancelled', code: uncertain ? 'PROVIDER_UNCERTAIN' : cause.code || 'FOOD_RENDER_INVALID_OUTPUT', usage: payload?.usage, providerRequestId: requestId }).catch(() => {});
      if (uncertain) throw new RestaurantError('菜品摄影生成结果未确认，系统已停止重复请求，请管理员核对调用记录。', 502, 'PROVIDER_UNCERTAIN');
      if (cause instanceof RestaurantError || cause.code) throw cause;
      throw new RestaurantError('菜品摄影图片无法处理，请稍后重试。', 502, 'FOOD_RENDER_INVALID_OUTPUT');
    } finally { clearTimeout(timer); }
  };
}

import { setTimeout as delay } from 'node:timers/promises';
import { readDirectorResponse } from './director-response.mjs';

const fail = (message, code, status = 502) => Object.assign(new Error(message), { code, status });
export function selectPlannerMode(value = 'native') {
  if (!['native', 'penshot'].includes(value)) throw fail('请选择现有编导或 PenShot 编排。', 'PLANNER_MODE_INVALID', 400);
  return value;
}

export function applyPenShotLayout(candidate, board, duration) {
  if (candidate?.kind !== 'script') return candidate;
  const fragments = board.instructions.fragments, shots = candidate.script?.shots;
  if (fragments.length > 15 || !Array.isArray(shots) || shots.length !== fragments.length
    || new Set(fragments.map(f=>f.fragment_id)).size !== fragments.length
    || fragments.some((f,i)=>typeof f.fragment_id !== 'string' || !f.fragment_id || !Number.isFinite(f.duration) || f.duration <= 0 || shots[i]?.penshotFragmentId !== f.fragment_id)) {
    throw Object.assign(fail('分镜未保留 PenShot 的镜头顺序，请重新整理。', 'DIRECTOR_INVALID_OUTPUT'), { outputIssue:'invalid_schema', validationIssue:'shots must preserve every PenShot fragment_id in order as penshotFragmentId' });
  }
  const total = fragments.reduce((sum,f)=>sum+f.duration,0);
  let end = 0;
  // Preserve PenShot's relative rhythm while fitting the user's selected total duration.
  candidate.script.shots = shots.map((shot,i)=>{
    const start = end;
    end = i === shots.length-1 ? duration : Math.round((end + fragments[i].duration / total * duration)*1000)/1000;
    return { ...shot, start, end };
  });
  return candidate;
}

export function createPenShotPlanner({ baseUrl, fetchImpl = fetch, pollIntervalMs = 2000, timeoutMs = 1200000 } = {}) {
  let base;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      base = url.href.replace(/\/$/, '');
    } catch { throw fail('PenShot 服务地址配置无效。', 'PENSHOT_CONFIG_INVALID', 503); }
  }
  return { enabled: Boolean(base), async generate(script, { operationId, signal, onQueued, onProgress } = {}) {
    if (!base) throw fail('PenShot 服务尚未配置，请选择现有编导。', 'PENSHOT_NOT_CONFIGURED', 503);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const request = async (path, body) => {
      const response = await fetchImpl(base + '/api/v1' + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const received = await readDirectorResponse(response);
      if (!response.ok) throw fail(`PenShot 服务返回错误（HTTP ${response.status}），请查看原任务。`, 'PENSHOT_PROVIDER_ERROR');
      return received.payload;
    };
    // A submitted job may already be billable. Never automatically repeat this POST.
    const submitted = await request('/storyboard', { script, language: 'zh', style: 'realistic',
      ...(operationId ? { script_id: operationId } : {}), config: { enable_llm: true } });
    if (typeof submitted.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submitted.task_id)) {
      throw fail('PenShot 提交结果未获确认，请核对原任务后再试。', 'PENSHOT_SUBMISSION_UNCERTAIN');
    }
    const id = submitted.task_id;
    await onQueued?.(id);
    while (true) {
      requestSignal.throwIfAborted();
      const state = await request('/status/' + encodeURIComponent(id));
      const status = state.status;
      if (status === 'success') break;
      if (status === 'timeout') throw fail('PenShot 编排等待超时，请核对原任务后再试。', 'PENSHOT_TIMEOUT');
      if (['failed', 'cancelled'].includes(status)) throw fail('PenShot 编排失败，请查看原任务或选择现有编导。', 'PENSHOT_JOB_FAILED');
      if (!['pending', 'processing', 'queued', 'running'].includes(status)) throw fail('PenShot 返回了无法识别的任务状态，请核对原任务。', 'PENSHOT_INVALID_RESPONSE');
      onProgress?.('PenShot 正在编排镜头');
      await delay(pollIntervalMs, undefined, { signal: requestSignal });
    }
    const result = await request('/result/' + encodeURIComponent(id));
    const data = result.data;
    if (result.success !== true || !Array.isArray(data?.instructions?.fragments) || !data.instructions.fragments.length) {
      throw fail('PenShot 没有返回完整分镜，请核对原任务。', 'PENSHOT_INVALID_RESPONSE');
    }
    return { taskId: id, instructions: data.instructions, fragmentSequence: data.fragment_sequence,
      shotSequence: data.shot_sequence, assetPlan: data.asset_plan, assetManifest: data.asset_manifest };
  } };
}

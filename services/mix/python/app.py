"""Account-scoped browser mixer, called only by the authenticated Node proxy.

Matching, transfer checkpoints, rendering and quality review come from the
verified video-material-match engine. This adapter exposes no NAS/helper APIs.
"""
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from api import clean_error
from browser_materials import attach_browser_materials
from local_materials import MaterialBroker, MaterialsPending, valid_id

OUTPUT_TTL = 72 * 3600
RECORD_TTL = 30 * 86400


def readiness():
    missing = [name for name in ('OPENLUX_API_KEY', 'RERANK_API_KEY') if not os.environ.get(name)]
    indexing = bool(os.environ.get('OPENLUX_API_KEY'))
    if not (os.environ.get('INDEXTTS_302_API_KEY') or os.environ.get('TTS_API_KEY')):
        missing.append('INDEXTTS_302_API_KEY')
    if not os.environ.get('INDEXTTS_SPEAKER_AUDIO_URL'):
        missing.append('INDEXTTS_SPEAKER_AUDIO_URL')
    for binary in ('ffmpeg', 'ffprobe'):
        if not shutil.which(binary):
            missing.append(binary)
            indexing = False
    return {'app': 'browser-material-mixer', 'browser_materials': True,
            'configured': not missing, 'indexing_configured': indexing, 'missing': missing}


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as file:
        for chunk in iter(lambda: file.read(4 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def generate(spec, folder, log):
    """Resume the saved provider/matching checkpoints before doing new work."""
    config = readiness()
    if not config['configured']:
        raise ValueError('服务器混剪配置缺失：' + ', '.join(config['missing']))
    from matcher import create_plan, resume_plan, write_json
    from voice import synthesize_plan
    from finish import deliver
    folder = Path(folder).resolve()
    broker = MaterialBroker(folder.parent.parent)
    broker.device(spec['device_id'], spec['owner'])
    catalog = folder / 'remote-catalog'
    write_json(catalog / 'remote.json', {'root': str(broker.root),
               'device_id': spec['device_id'], 'job_id': folder.name})
    saved = folder / 'plan.json'
    plan = json.loads(saved.read_text(encoding='utf-8')) if saved.exists() else create_plan(
        spec['text'], catalog, folder, log=log)
    if plan['script'] != spec['text']:
        raise ValueError('保存的计划与任务文案不一致，不能复用已付费任务')
    plan['subtitles'] = spec['subtitles']
    resume_plan(plan, catalog, folder, log=log)
    if ((folder / 'narration.wav').is_file() and all(
            scene.get('voice') and Path(scene['voice']).is_file() for scene in plan['scenes'])):
        log('复用已完成配音与时间轴')
    else:
        synthesize_plan(plan, folder, log=log, **spec['voice_config'])
    return deliver(plan, folder, spec['width'], spec['height'], catalog=catalog, log=log)


class Jobs:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / 'jobs.sqlite3'
        self.materials = MaterialBroker(self.root)
        with self.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, request_key TEXT UNIQUE, owner TEXT NOT NULL, spec TEXT,
                state TEXT, created REAL, updated REAL, logs TEXT, result TEXT, error TEXT)''')
            db.execute("UPDATE jobs SET state='interrupted',error=?,updated=? WHERE state='running'",
                       ('服务重启中断任务；保留输出和服务商任务记录，核对后再恢复。', time.time()))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def submit(self, key, spec):
        encoded = json.dumps(spec, sort_keys=True, ensure_ascii=False)
        key = hashlib.sha256((spec['owner'] + ':' + key).encode()).hexdigest()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM jobs WHERE request_key=?', (key,)).fetchone()
            if row:
                if row['spec'] != encoded:
                    raise HTTPException(409, '同一 Idempotency-Key 不能提交不同文案或参数')
                return row['id']
            if db.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0] >= 20:
                raise HTTPException(429, '任务队列已满，请稍后再试')
            job_id, now = uuid.uuid4().hex, time.time()
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (job_id, key, spec['owner'], encoded, 'queued', now, now, '[]', None, None))
            return job_id

    def get(self, job_id, owner=None):
        if not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise HTTPException(404, '任务不存在')
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if not row or owner is not None and row['owner'] != owner:
            raise HTTPException(404, '任务不存在')
        return {key: row[key] for key in ('id', 'state', 'created', 'updated', 'result', 'error')} | {
            'logs': json.loads(row['logs'])}

    def list(self, owner):
        with self.connect() as db:
            ids = [row['id'] for row in db.execute(
                'SELECT id FROM jobs WHERE owner=? ORDER BY created DESC LIMIT 100', (owner,))]
        return [self.get(job_id, owner) for job_id in ids]

    def resume(self, job_id, owner):
        self.get(job_id, owner)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT state FROM jobs WHERE id=? AND owner=?', (job_id, owner)).fetchone()
            if row['state'] not in ('failed', 'interrupted', 'waiting_materials'):
                raise HTTPException(409, '仅失败、中断或等待素材的任务可以继续')
            db.execute("UPDATE jobs SET state='queued',error=NULL,updated=? WHERE id=?", (time.time(), job_id))
        self.log(job_id, '从已保存的匹配、配音和导出状态继续制作')
        return self.get(job_id, owner)

    def log(self, job_id, message):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            logs = json.loads(db.execute('SELECT logs FROM jobs WHERE id=?', (job_id,)).fetchone()[0])
            db.execute('UPDATE jobs SET logs=?,updated=? WHERE id=?',
                       (json.dumps((logs + [clean_error(message)])[-100:], ensure_ascii=False), time.time(), job_id))

    def run_one(self, runner=generate):
        self.materials.cleanup()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
            if not row:
                return False
            db.execute("UPDATE jobs SET state='running',error=NULL,updated=? WHERE id=?", (time.time(), row['id']))
        job_id = row['id']
        folder = self.root / 'outputs' / job_id
        folder.mkdir(parents=True, exist_ok=True)
        try:
            spec = json.loads(row['spec'])
            self.materials.device(spec['device_id'], spec['owner'])
            saved = folder / row['result'] if row['result'] else None
            result = (saved if saved and saved.is_file() and (folder / 'quality-report.json').is_file()
                      else Path(runner(spec, folder, lambda message: self.log(job_id, message)))).resolve()
            if result.parent != folder or not result.is_file():
                raise ValueError('任务输出路径无效')
            report = json.loads((folder / 'quality-report.json').read_text(encoding='utf-8'))
            if not report.get('passed') or report.get('sha256') != file_digest(result):
                raise ValueError('实际成片尚未通过检查或检查报告与成片不一致')
            with self.connect() as db:
                db.execute("UPDATE jobs SET state='done',result=?,error=NULL,updated=? WHERE id=?",
                           (result.name, time.time(), job_id))
        except MaterialsPending as pending:
            with self.connect() as db:
                db.execute("UPDATE jobs SET state='waiting_materials',error=NULL,updated=? WHERE id=?",
                           (time.time(), job_id))
            if self.materials.request_ready(pending.request_id):
                with self.connect() as db:
                    db.execute("UPDATE jobs SET state='queued',updated=? WHERE id=? AND state='waiting_materials'",
                               (time.time(), job_id))
            self.log(job_id, '等待网页连接并上传所需素材，已完成的步骤会保留')
        except Exception as exc:
            error = clean_error(exc)
            self.log(job_id, '失败：' + error)
            with self.connect() as db:
                db.execute("UPDATE jobs SET state='failed',error=?,updated=? WHERE id=?", (error, time.time(), job_id))
        return True

    def cleanup(self):
        now = time.time()
        with self.connect() as db:
            rows = db.execute("SELECT id FROM jobs WHERE state IN ('done','failed','interrupted','expired') AND updated<?",
                              (now - OUTPUT_TTL,)).fetchall()
            for row in rows:
                folder = self.root / 'outputs' / row['id']
                if folder.resolve().parent == (self.root / 'outputs').resolve() and folder.exists():
                    shutil.rmtree(folder)
                db.execute("UPDATE jobs SET state='expired',result=NULL WHERE id=?", (row['id'],))
            db.execute("DELETE FROM jobs WHERE state='expired' AND updated<?", (now - RECORD_TTL,))


def normalize(body, owner):
    fields = {'text', 'device_id', 'ratio', 'quality', 'subtitles', 'music', 'count', 'duration'}
    if set(body) - fields:
        raise HTTPException(400, '任务包含不支持的参数')
    text = body.get('text')
    if not isinstance(text, str) or not text.strip() or len(text) > 6000:
        raise HTTPException(400, '文案须为 1–6000 字符')
    device_id = valid_id(body.get('device_id'), 32)
    ratio, quality = body.get('ratio', '9:16'), body.get('quality', '1080p')
    if ratio not in ('9:16', '16:9', '1:1') or quality not in ('720p', '1080p'):
        raise HTTPException(400, '画幅或清晰度无效')
    subtitles = body.get('subtitles', True)
    if type(subtitles) is not bool or body.get('music', False) is not False:
        raise HTTPException(400, '字幕须为布尔值；首版暂不支持背景音乐')
    if type(body.get('count', 1)) is not int or body.get('count', 1) != 1 or body.get('duration') is not None:
        raise HTTPException(400, '首版每次制作一条；时长由完整文案的实际配音决定')
    short, long = (720, 1280) if quality == '720p' else (1080, 1920)
    width, height = {'9:16': (short, long), '16:9': (long, short), '1:1': (short, short)}[ratio]
    return {'text': text, 'device_id': device_id, 'owner': owner, 'ratio': ratio, 'quality': quality,
            'width': width, 'height': height, 'subtitles': subtitles, 'music': False,
            'count': 1, 'duration': None,
            'voice_config': {'speaker_url': os.environ.get('INDEXTTS_SPEAKER_AUDIO_URL', ''),
                             'emotion_url': os.environ.get('INDEXTTS_EMOTION_AUDIO_URL') or None,
                             'emotion_file': os.environ.get('INDEXTTS_EMOTION_AUDIO_PATH') or None}}


def create_app(root=None, token=None, start_worker=True, runner=generate):
    token = token or os.environ.get('MIXER_API_TOKEN', '')
    if len(token) < 32 or not token.isascii():
        raise ValueError('MIXER_API_TOKEN 必须是至少 32 字符的随机 ASCII 密钥')
    jobs = Jobs(root or os.environ.get('DATA_DIR', 'data/mix'))
    stop = threading.Event()

    def work():
        last_cleanup = 0
        while not stop.is_set():
            try:
                if time.monotonic() - last_cleanup >= 60:
                    app.state.browser_materials.cleanup()
                    jobs.cleanup()
                    last_cleanup = time.monotonic()
                if not jobs.run_one(runner):
                    stop.wait(1)
            except Exception as exc:
                print('混剪工作线程暂不可用：' + clean_error(exc), flush=True)
                stop.wait(5)

    @asynccontextmanager
    async def lifespan(app):
        if start_worker:
            threading.Thread(target=work, name='browser-mixer', daemon=True).start()
        yield
        stop.set()

    app = FastAPI(title='Browser material mixer', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.jobs = jobs
    app.state.materials = jobs.materials
    app.state.runner = runner

    def authorize(request: Request):
        value = request.headers.get('authorization', '')
        if not hmac.compare_digest(value.encode(), ('Bearer ' + token).encode()):
            raise HTTPException(401, '需要有效服务凭据', headers={'WWW-Authenticate': 'Bearer'})
        if request.headers.get('origin'):
            raise HTTPException(403, '仅接受主站服务端请求')

    def owner(request: Request):
        authorize(request)
        value = request.headers.get('x-material-owner', '')
        if not value:
            raise HTTPException(401, '需要账号素材凭据')
        return valid_id(value)

    async def material_body(request, limit=262144):
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > limit:
                raise HTTPException(413, '请求过大')
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            raise HTTPException(415, '需要 application/json')
        try:
            body = json.loads(data)
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except (ValueError, UnicodeError):
            raise HTTPException(400, '请求必须是 JSON 对象') from None

    attach_browser_materials(app, jobs.materials, authorize, material_body)

    def payload(job):
        result = {key: value for key, value in job.items() if key != 'result'}
        if job['state'] == 'done':
            result['video_url'] = '/api/mix/jobs/' + job['id'] + '/video'
        return result

    @app.get('/health', dependencies=[Depends(authorize)])
    def health():
        return readiness()

    @app.post('/v1/mix/jobs', status_code=202)
    async def submit(request: Request, owner_id=Depends(owner)):
        key = request.headers.get('idempotency-key', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key):
            raise HTTPException(400, '需要有效 Idempotency-Key')
        spec = normalize(await material_body(request, 32768), owner_id)
        await run_in_threadpool(app.state.browser_materials.check_device, spec['device_id'], owner_id)
        job_id = await run_in_threadpool(jobs.submit, key, spec)
        return payload(jobs.get(job_id, owner_id))

    @app.get('/v1/mix/jobs')
    def list_jobs(owner_id=Depends(owner)):
        return {'jobs': [payload(job) for job in jobs.list(owner_id)]}

    @app.get('/v1/mix/jobs/{job_id}')
    def get_job(job_id: str, owner_id=Depends(owner)):
        return payload(jobs.get(job_id, owner_id))

    @app.post('/v1/mix/jobs/{job_id}/resume', status_code=202)
    def resume(job_id: str, owner_id=Depends(owner)):
        return payload(jobs.resume(job_id, owner_id))

    def artifact(job_id, owner_id, name):
        job = jobs.get(job_id, owner_id)
        if job['state'] == 'expired':
            raise HTTPException(410, '成片已过期，请新建任务')
        folder = jobs.root / 'outputs' / job_id
        if name == 'video':
            if job['state'] != 'done':
                raise HTTPException(409, '成片尚未通过检查')
            name = job['result']
        path = (folder / name).resolve()
        if path.parent != folder or not path.is_file():
            raise HTTPException(404, '任务文件尚未生成')
        return path

    @app.api_route('/v1/mix/jobs/{job_id}/video', methods=['GET', 'HEAD'])
    def video(job_id: str, owner_id=Depends(owner)):
        return FileResponse(artifact(job_id, owner_id, 'video'), media_type='video/mp4', filename=job_id + '.mp4')

    @app.api_route('/v1/mix/jobs/{job_id}/plan', methods=['GET', 'HEAD'])
    def plan(job_id: str, owner_id=Depends(owner)):
        # Keep server filesystem paths and provider reference URLs private.
        saved = json.loads(artifact(job_id, owner_id, 'plan.json').read_text(encoding='utf-8'))
        scenes = [{key: scene[key] for key in ('text', 'query', 'start', 'end', 'visual_usage', 'visual_note') if key in scene}
                  for scene in saved.get('scenes', [])]
        return JSONResponse({'script': saved.get('script'), 'fps': saved.get('fps'), 'timing': saved.get('timing'), 'scenes': scenes})

    @app.api_route('/v1/mix/jobs/{job_id}/captions', methods=['GET', 'HEAD'])
    def captions(job_id: str, owner_id=Depends(owner)):
        return FileResponse(artifact(job_id, owner_id, 'captions.srt'), media_type='application/x-subrip', filename=job_id + '.srt')

    return app

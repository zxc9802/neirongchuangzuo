"""Browser folder catalog and bounded, temporary whole-file material transfers."""
import base64
import binascii
import hashlib
import json
import math
import os
import secrets
import shutil
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from api import clean_error
import local_materials
from local_materials import MAX_CHUNK, MAX_SOURCE, UPLOAD_TTL, bounded_text, valid_id

MAX_FRAME = 512 * 1024
FRAME_BODY_LIMIT = 7 * 1024 * 1024
ANALYSIS_TTL = 15 * 60
PROCESS_ID = uuid.uuid4().hex


class BrowserMaterials:
    def __init__(self, broker):
        self.broker = broker
        self.folder = broker.folder / 'browser'
        self.folder.mkdir(exist_ok=True)
        self.transfer_lock = threading.RLock()
        for path in self.folder.iterdir():
            if (path.is_dir() and path.name.startswith(('frames-', 'source-')) and
                    path.resolve().parent == self.folder.resolve() and not path.is_symlink() and
                    not path.name.startswith(('frames-' + PROCESS_ID + '-', 'source-' + PROCESS_ID + '-'))):
                shutil.rmtree(path)
        with broker.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS browser_folders (owner TEXT, folder_key TEXT,
                    device_id TEXT UNIQUE, PRIMARY KEY(owner,folder_key));
                CREATE TABLE IF NOT EXISTS browser_analysis (device_id TEXT, clip_id TEXT,
                    lease TEXT, process TEXT, expires REAL, PRIMARY KEY(device_id,clip_id));
                CREATE TABLE IF NOT EXISTS browser_files (id TEXT PRIMARY KEY, device_id TEXT,
                    asset_id TEXT, size INTEGER, path TEXT, offset INTEGER, state TEXT,
                    created REAL, expires REAL, UNIQUE(device_id,asset_id));
            ''')
            # A new NAS process can retry interrupted work, retaining any saved vector.
            interrupted = db.execute('SELECT device_id,clip_id FROM browser_analysis WHERE process!=?',
                                     (PROCESS_ID,)).fetchall()
            for row in interrupted:
                db.execute("UPDATE clips SET state='pending' WHERE device_id=? AND id=? AND state='indexing'",
                           (row['device_id'], row['clip_id']))
            db.execute('DELETE FROM browser_analysis WHERE process!=?', (PROCESS_ID,))
        self.cleanup()

    def connect_folder(self, owner, folder_key, name):
        valid_id(folder_key)
        bounded_text(name, 128, '文件夹名称')
        self.cleanup()
        with self.broker.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT device_id FROM browser_folders WHERE owner=? AND folder_key=?',
                                  (owner, folder_key)).fetchone()
            if previous:
                device = db.execute('SELECT revoked FROM devices WHERE id=?', (previous['device_id'],)).fetchone()
                if device and not device['revoked']:
                    return {'device_id': previous['device_id']}
                db.execute('DELETE FROM browser_folders WHERE owner=? AND folder_key=?', (owner, folder_key))
            if db.execute('SELECT count(*) FROM devices WHERE owner=? AND revoked=0', (owner,)).fetchone()[0] >= 10:
                raise HTTPException(429, '工作区最多连接十个素材文件夹')
            device_id, now = uuid.uuid4().hex, time.time()
            # Equivalent to internal pairing: no helper bearer token leaves the NAS.
            token = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
            db.execute('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,0)',
                       (device_id, owner, name, token, now, now, 'ready', ''))
            db.execute('INSERT INTO browser_folders VALUES(?,?,?)', (owner, folder_key, device_id))
        return {'device_id': device_id}

    def check_device(self, device_id, owner):
        self.broker.device(device_id, owner)
        with self.broker.connect() as db:
            if not db.execute('SELECT 1 FROM browser_folders WHERE device_id=? AND owner=?',
                              (device_id, owner)).fetchone():
                raise HTTPException(404, '浏览器素材文件夹不存在')

    def cleanup(self):
        with self.transfer_lock:
            self.broker.cleanup()
            now = time.time()
            paths = []
            with self.broker.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                # Provider retries may outlast the estimate. A live process keeps its
                # lease until finally; a restarted process clears interrupted leases.
                for row in db.execute('SELECT * FROM browser_analysis WHERE expires<? AND process!=?',
                                      (now, PROCESS_ID)).fetchall():
                    db.execute("UPDATE clips SET state='pending' WHERE device_id=? AND id=? AND state='indexing' AND revoked=0",
                               (row['device_id'], row['clip_id']))
                db.execute('DELETE FROM browser_analysis WHERE expires<? AND process!=?', (now, PROCESS_ID))
                for row in db.execute("SELECT * FROM browser_files WHERE state!='expired'").fetchall():
                    device = db.execute('SELECT revoked FROM devices WHERE id=?', (row['device_id'],)).fetchone()
                    clip = db.execute('SELECT 1 FROM clips WHERE device_id=? AND asset_id=? AND revoked=0',
                                      (row['device_id'], row['asset_id'])).fetchone()
                    active = db.execute("SELECT 1 FROM requests WHERE device_id=? AND asset_id=? AND state IN ('pending','complete') LIMIT 1",
                                        (row['device_id'], row['asset_id'])).fetchone()
                    if row['expires'] < now or not device or device['revoked'] or not clip or not active:
                        paths.append(Path(row['path']))
                        db.execute("UPDATE browser_files SET state='expired' WHERE id=?", (row['id'],))
            for path in paths:
                if path.resolve().is_relative_to(self.folder.resolve()):
                    path.unlink(missing_ok=True)

    @contextmanager
    def frame_video(self, clip, frames):
        count = math.ceil(clip['end'] - clip['start'])
        if not isinstance(frames, list) or len(frames) != count:
            raise HTTPException(400, '需要按每秒一帧提交完整片段，最多九帧')
        import media
        with tempfile.TemporaryDirectory(prefix='frames-' + PROCESS_ID + '-', dir=self.folder) as temporary:
            folder = Path(temporary)
            dimensions = None
            for index, frame in enumerate(frames):
                prefix = 'data:image/jpeg;base64,'
                if not isinstance(frame, str) or not frame.startswith(prefix) or len(frame) > MAX_FRAME * 4 // 3 + 32:
                    raise HTTPException(400, '需要不超过 512 KiB 的 JPEG 抽帧')
                try:
                    content = base64.b64decode(frame[len(prefix):], validate=True)
                except (ValueError, binascii.Error):
                    raise HTTPException(400, 'JPEG 抽帧编码无效') from None
                if not content.startswith(b'\xff\xd8\xff') or len(content) > MAX_FRAME:
                    raise HTTPException(400, 'JPEG 抽帧内容无效')
                path = folder / f'{index:02}.jpg'
                path.write_bytes(content)
                try:
                    info = self.video_info(path)
                    size = (info['width'], info['height'])
                    if info['codec_name'] != 'mjpeg' or min(size) < 1 or max(size) > 640 or dimensions not in (None, size):
                        raise ValueError()
                    dimensions = size
                except (RuntimeError, ValueError, KeyError, IndexError):
                    raise HTTPException(400, 'JPEG 抽帧无法解码或尺寸超过 640 像素') from None
            output = folder / 'analysis.mp4'
            try:
                media.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-y', '-framerate', '1',
                           '-i', str(folder / '%02d.jpg'), '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                           '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', str(output)])
            except RuntimeError:
                raise HTTPException(400, 'JPEG 抽帧无法解码，请重新读取素材') from None
            yield output

    @staticmethod
    def video_info(path):
        import media
        result = json.loads(media.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,width,height', '-of', 'json', str(path)]))
        return result['streams'][0]

    def analyze(self, device_id, clip_id, frames):
        self.cleanup()
        lease = uuid.uuid4().hex
        with self.broker.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            clip = self.broker._clip(db, device_id, clip_id)
            if clip['state'] == 'indexed':
                return {'complete': True}
            if db.execute('SELECT 1 FROM browser_analysis WHERE device_id=? AND clip_id=?',
                          (device_id, clip_id)).fetchone():
                raise HTTPException(409, '片段正在分析，请稍后查询索引状态')
            db.execute('INSERT INTO browser_analysis VALUES(?,?,?,?,?)',
                       (device_id, clip_id, lease, PROCESS_ID, time.time() + ANALYSIS_TTL))
        try:
            with self.frame_video(clip, frames) as path:
                self.broker._analyze(device_id, clip_id, path)
            return {'complete': True}
        except BaseException:
            with self.broker.connect() as db:
                db.execute("UPDATE clips SET state='error' WHERE device_id=? AND id=? AND revoked=0 AND state!='indexed'",
                           (device_id, clip_id))
            raise
        finally:
            with self.broker.connect() as db:
                db.execute('DELETE FROM browser_analysis WHERE device_id=? AND clip_id=? AND lease=?',
                           (device_id, clip_id, lease))

    def _request(self, db, device_id, request_id, kind=None):
        valid_id(request_id, 32)
        request = db.execute('SELECT * FROM requests WHERE id=? AND device_id=?', (request_id, device_id)).fetchone()
        if not request:
            raise HTTPException(404, '素材请求不存在')
        self.broker._clip(db, device_id, request['clip_id'])
        if request['state'] not in ('pending', 'complete') or request['expires'] < time.time():
            raise HTTPException(410, '素材请求已过期或撤销')
        if kind and request['kind'] != kind:
            raise HTTPException(409, '上传内容与素材请求类型不一致')
        return request

    def fulfill(self, device_id, request, path):
        digest = hashlib.sha256()
        with Path(path).open('rb') as file:
            for chunk in iter(lambda: file.read(MAX_CHUNK), b''):
                digest.update(chunk)
        upload = self.broker.begin_upload(device_id, request['clip_id'], request['kind'],
                                         Path(path).stat().st_size, digest.hexdigest(), request['id'])
        with Path(path).open('rb') as file:
            file.seek(upload['offset'])
            offset = upload['offset']
            for chunk in iter(lambda: file.read(MAX_CHUNK), b''):
                offset = self.broker.append_upload(device_id, upload['id'], offset, chunk)['offset']
        return self.broker.complete_upload(device_id, upload['id'])

    def request_frames(self, device_id, request_id, frames):
        self.cleanup()
        with self.transfer_lock:
            with self.broker.connect() as db:
                request = self._request(db, device_id, request_id, 'proxy')
                clip = self.broker._clip(db, device_id, request['clip_id'])
            if request['state'] == 'complete':
                return {'complete': True}
            with self.frame_video(clip, frames) as path:
                return self.fulfill(device_id, request, path)

    def _file(self, db, device_id, upload_id):
        valid_id(upload_id, 32)
        self.broker._device(db, device_id)
        row = db.execute('SELECT * FROM browser_files WHERE id=? AND device_id=?', (upload_id, device_id)).fetchone()
        if not row:
            raise HTTPException(404, '原片上传不存在')
        if row['state'] == 'expired' or row['expires'] < time.time():
            raise HTTPException(410, '原片缓存已过期，请重新上传')
        if not db.execute('SELECT 1 FROM clips WHERE device_id=? AND asset_id=? AND revoked=0',
                          (device_id, row['asset_id'])).fetchone():
            raise HTTPException(410, '素材已删除或版本改变')
        return row

    def begin_file(self, device_id, request_id, size):
        if type(size) is not int or not 0 < size <= MAX_SOURCE:
            raise HTTPException(400, '单个原片必须在 512 MiB 以内')
        self.cleanup()
        with self.transfer_lock, self.broker.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            request = self._request(db, device_id, request_id, 'source')
            previous = db.execute('SELECT * FROM browser_files WHERE device_id=? AND asset_id=?',
                                  (device_id, request['asset_id'])).fetchone()
            if previous and previous['state'] != 'expired':
                if previous['size'] != size:
                    raise HTTPException(409, '原片大小已变化，请重新扫描素材')
                return {'id': previous['id'], 'offset': Path(previous['path']).stat().st_size}
            reserved = db.execute("SELECT coalesce(sum(size * CASE WHEN request_id IS NULL THEN 1 ELSE 2 END),0) FROM uploads WHERE state IN ('uploading','processing') OR (state='complete' AND request_id IS NOT NULL)").fetchone()[0]
            device_reserved = db.execute("SELECT coalesce(sum(size * CASE WHEN request_id IS NULL THEN 1 ELSE 2 END),0) FROM uploads WHERE device_id=? AND (state IN ('uploading','processing') OR (state='complete' AND request_id IS NOT NULL))", (device_id,)).fetchone()[0]
            cached = db.execute("SELECT coalesce(sum(size),0) FROM browser_files WHERE state!='expired'").fetchone()[0]
            device_cached = db.execute("SELECT coalesce(sum(size),0) FROM browser_files WHERE device_id=? AND state!='expired'", (device_id,)).fetchone()[0]
            if reserved + cached + size > local_materials.TOTAL_QUOTA or device_reserved + device_cached + size > local_materials.DEVICE_QUOTA:
                raise HTTPException(429, '任务临时素材缓存已满，请等待旧任务缓存过期')
            if previous:
                db.execute('DELETE FROM browser_files WHERE id=?', (previous['id'],))
            upload_id, now = uuid.uuid4().hex, time.time()
            path = self.folder / (upload_id + '.mp4')
            path.touch(exist_ok=False)
            db.execute('INSERT INTO browser_files VALUES(?,?,?,?,?,0,?,?,?)',
                       (upload_id, device_id, request['asset_id'], size, str(path), 'uploading', now, now + UPLOAD_TTL))
            return {'id': upload_id, 'offset': 0}

    def file_offset(self, device_id, upload_id):
        self.cleanup()
        with self.broker.connect() as db:
            row = self._file(db, device_id, upload_id)
            return Path(row['path']).stat().st_size

    def append_file(self, device_id, upload_id, offset, checksum, content):
        valid_id(checksum)
        if type(offset) is not int or offset < 0:
            raise HTTPException(400, '上传偏移无效')
        if not content or len(content) > MAX_CHUNK:
            raise HTTPException(413, '上传块必须在 1 字节到 4 MiB 之间')
        if hashlib.sha256(content).hexdigest() != checksum:
            raise HTTPException(422, '上传块 SHA256 校验失败，请重试该块')
        self.cleanup()
        with self.transfer_lock, self.broker.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = self._file(db, device_id, upload_id)
            path = Path(row['path'])
            if row['state'] != 'uploading' or path.stat().st_size != offset:
                raise HTTPException(409, '上传偏移冲突，请重新查询 Upload-Offset')
            if offset + len(content) > row['size']:
                raise HTTPException(413, '上传超出声明的原片大小')
            with path.open('ab') as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            db.execute('UPDATE browser_files SET offset=?,expires=? WHERE id=?',
                       (offset + len(content), time.time() + UPLOAD_TTL, upload_id))
        return {'offset': offset + len(content)}

    def fulfill_sources(self, device_id, asset_id, path):
        import media
        with self.broker.connect() as db:
            requests = db.execute("SELECT * FROM requests WHERE device_id=? AND asset_id=? AND kind='source' AND state IN ('pending','complete') ORDER BY created",
                                 (device_id, asset_id)).fetchall()
        try:
            duration = media.duration(path)
            info = self.video_info(path)
            if min(info['width'], info['height']) < 1 or max(info['width'], info['height']) > 16384:
                raise ValueError()
        except (RuntimeError, ValueError, KeyError, IndexError):
            raise HTTPException(422, '原片无法解码为有效视频，请检查本地文件') from None
        if any(request['end'] > duration + .1 for request in requests):
            raise HTTPException(422, '原片时长与素材区间不一致，请重新扫描文件版本')
        color_filter, _ = media.sdr_filter(media.video_color(path))
        scale_filter = ("scale=w='if(gte(iw,ih),min(iw,1920),min(iw,1080))':"
                        "h='if(gte(iw,ih),min(ih,1080),min(ih,1920))':"
                        'force_original_aspect_ratio=decrease:force_divisible_by=2')
        for request in requests:
            if request['state'] != 'pending':
                continue
            with tempfile.TemporaryDirectory(prefix='source-' + PROCESS_ID + '-', dir=self.folder) as temporary:
                segment = Path(temporary) / 'segment.mp4'
                # Re-encode after accurate seek; every extracted clip begins at timestamp zero.
                media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '2', '-ss', str(request['start']),
                           '-i', str(path), '-t', str(request['end'] - request['start']),
                           '-map', '0:v:0', '-an', '-vf', f'setpts=PTS-STARTPTS,fps=25,{scale_filter},{color_filter}', '-c:v', 'libx264',
                           '-threads', '2', '-filter_threads', '1', '-preset', 'fast', '-crf', '0', '-pix_fmt', 'yuv420p',
                           '-map_metadata', '-1', *media.SDR_FLAGS, str(segment)])
                self.fulfill(device_id, request, segment)

    def complete_file(self, device_id, upload_id):
        self.cleanup()
        with self.transfer_lock:
            with self.broker.connect() as db:
                row = self._file(db, device_id, upload_id)
            path = Path(row['path'])
            if path.stat().st_size != row['size']:
                raise HTTPException(409, '原片尚未全部上传')
            try:
                self.fulfill_sources(device_id, row['asset_id'], path)
            except HTTPException as exc:
                if exc.status_code == 422:
                    path.unlink(missing_ok=True)
                    with self.broker.connect() as db:
                        db.execute("UPDATE browser_files SET state='expired' WHERE id=?", (upload_id,))
                raise
            with self.broker.connect() as db:
                self._file(db, device_id, upload_id)
                db.execute("UPDATE browser_files SET state='ready',offset=size WHERE id=?", (upload_id,))
            return {'complete': True}

    def requests(self, device_id):
        self.cleanup()
        with self.transfer_lock:
            with self.broker.connect() as db:
                cached = db.execute("SELECT * FROM browser_files WHERE device_id=? AND state='ready'", (device_id,)).fetchall()
            for row in cached:
                self.fulfill_sources(device_id, row['asset_id'], Path(row['path']))
        return self.broker.requests(device_id)


def attach_browser_materials(app, broker, authorize, material_body):
    adapter = BrowserMaterials(broker)
    app.state.browser_materials = adapter

    def owner(request: Request):
        authorize(request)
        value = request.headers.get('x-material-owner', '')
        if not value:
            raise HTTPException(401, '需要工作区素材凭据')
        return valid_id(value)

    def device(request: Request, owner_id=Depends(owner)):
        device_id = request.path_params['device_id']
        adapter.check_device(device_id, owner_id)
        return device_id

    async def call(method, *args, **kwargs):
        try:
            return await run_in_threadpool(method, *args, **kwargs)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, clean_error(exc)) from None

    @app.post('/v1/browser-materials/connect')
    async def connect(request: Request, owner_id=Depends(owner)):
        body = await material_body(request, 4096)
        return await call(adapter.connect_folder, owner_id, body.get('folder_key'), body.get('name'))

    prefix = '/v1/browser-materials/devices/{device_id}'

    @app.delete(prefix)
    async def disconnect(device_id=Depends(device), owner_id=Depends(owner)):
        result = await call(broker.revoke, device_id, owner_id)
        await call(adapter.cleanup)
        return result

    @app.post(prefix + '/heartbeat')
    async def heartbeat(request: Request, device_id=Depends(device)):
        body = await material_body(request, 8192)
        await call(adapter.cleanup)
        return await call(broker.heartbeat, device_id, body.get('status', 'ready'), body.get('error', ''))

    @app.post(prefix + '/clips')
    async def clips(request: Request, device_id=Depends(device)):
        body = await material_body(request)
        await call(adapter.cleanup)
        return await call(broker.register_clips, device_id, body.get('clips'), restore_revoked=True)

    @app.delete(prefix + '/assets/{asset_id}')
    def remove_asset(asset_id: str, device_id=Depends(device)):
        result = broker.remove_asset(device_id, asset_id)
        adapter.cleanup()
        return result

    @app.post(prefix + '/analyze')
    async def analyze(request: Request, device_id=Depends(device)):
        body = await material_body(request, FRAME_BODY_LIMIT)
        return await call(adapter.analyze, device_id, body.get('clip_id'), body.get('frames'))

    @app.get(prefix + '/requests')
    async def requests(device_id=Depends(device)):
        return await call(adapter.requests, device_id)

    @app.post(prefix + '/requests/{request_id}/frames')
    async def frames(request_id: str, request: Request, device_id=Depends(device)):
        body = await material_body(request, FRAME_BODY_LIMIT)
        return await call(adapter.request_frames, device_id, request_id, body.get('frames'))

    @app.post(prefix + '/requests/{request_id}/file')
    async def file(request_id: str, request: Request, device_id=Depends(device)):
        body = await material_body(request, 4096)
        return await call(adapter.begin_file, device_id, request_id, body.get('size'))

    @app.head(prefix + '/files/{upload_id}')
    def offset(upload_id: str, device_id=Depends(device)):
        return Response(headers={'Upload-Offset': str(adapter.file_offset(device_id, upload_id))})

    @app.patch(prefix + '/files/{upload_id}')
    async def chunk(upload_id: str, request: Request, device_id=Depends(device)):
        value = request.headers.get('upload-offset', '')
        if not value.isascii() or not value.isdecimal() or len(value) > 12:
            raise HTTPException(400, '需要有效 Upload-Offset')
        content = bytearray()
        async for part in request.stream():
            content.extend(part)
            if len(content) > MAX_CHUNK:
                raise HTTPException(413, '单个上传块不得超过 4 MiB')
        return await call(adapter.append_file, device_id, upload_id, int(value),
                          request.headers.get('upload-checksum', ''), content)

    @app.post(prefix + '/files/{upload_id}/complete')
    async def complete(upload_id: str, device_id=Depends(device)):
        return await call(adapter.complete_file, device_id, upload_id)

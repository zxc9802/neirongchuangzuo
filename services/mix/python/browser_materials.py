"""Browser folder catalog and bounded, temporary source material transfers.

A source request reaches the NAS in one of three ways:
- full: the whole file (at most 512 MiB) is appended sequentially and cached;
- sparse: an MP4/MOV of any size is recreated as a sparse file holding only its
  index boxes and the byte ranges of the packets the requested segments decode;
- segment: the browser stream-copies the requested range (ffmpeg.wasm) with the
  original timestamps, for containers the sparse path cannot index.
"""
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
from contextlib import contextmanager, nullcontext
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from api import clean_error
import local_materials
from local_materials import (BROWSER_BYTES, CLEANUP_INTERVAL, MAX_CHUNK, MAX_SOURCE, TERMINAL_TTL,
                             UPLOAD_TTL, add_columns, bounded_text, record_timing, valid_id)

MAX_FRAME = 512 * 1024
FRAME_BODY_LIMIT = 7 * 1024 * 1024
ANALYSIS_TTL = 15 * 60
PROCESS_ID = uuid.uuid4().hex
# Only the declared size of a sparse file; disk use is the uploaded ranges.
MAX_SPARSE_SOURCE = 256 * 1024 ** 3
MAX_INDEX_BYTES = 256 * 1024 * 1024
MAX_RANGES = 4096
# Nearby packets are fetched as one range; a few hundred KiB beats extra round trips.
RANGE_GAP = 256 * 1024
SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
SCALE_FILTER = ("scale=w='if(gte(iw,ih),min(iw,1920),min(iw,1080))':"
                "h='if(gte(iw,ih),min(ih,1080),min(ih,1920))':"
                'force_original_aspect_ratio=decrease:force_divisible_by=2')


def merge_ranges(ranges, gap=0):
    """Sorted, merged [start, end) byte ranges."""
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1] + gap:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged


def missing_ranges(required, written):
    """Parts of the sorted required ranges not yet covered by the sorted written ranges."""
    missing = []
    for start, end in required:
        cursor = start
        for done_start, done_end in written:
            if done_end <= cursor:
                continue
            if done_start >= end:
                break
            if done_start > cursor:
                missing.append([cursor, done_start])
            cursor = max(cursor, done_end)
            if cursor >= end:
                break
        if cursor < end:
            missing.append([cursor, end])
    return missing


def total_bytes(ranges):
    return sum(end - start for start, end in ranges)


def parse_ranges(value, size):
    if not isinstance(value, list) or not 0 < len(value) <= MAX_RANGES:
        raise HTTPException(400, '原片索引区间无效')
    ranges = []
    for item in value:
        if (not isinstance(item, list) or len(item) != 2 or any(type(part) is not int for part in item)
                or not 0 <= item[0] < item[1] <= size):
            raise HTTPException(400, '原片索引区间无效')
        ranges.append(item)
    ranges = merge_ranges(ranges)
    if total_bytes(ranges) > MAX_INDEX_BYTES:
        raise HTTPException(413, '原片索引过大，请改用片段上传')
    return ranges


def jpeg_size(content):
    """Frame dimensions from the JPEG start-of-frame header, without spawning ffprobe."""
    index = 2
    while index + 4 <= len(content):
        if content[index] != 0xFF:
            raise ValueError('JPEG 标记无效')
        marker = content[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        if marker in (0xD9, 0xDA):
            break
        length = int.from_bytes(content[index + 2:index + 4], 'big')
        if length < 2:
            break
        if marker in SOF_MARKERS:
            if length < 7 or index + 9 > len(content):
                break
            height = int.from_bytes(content[index + 5:index + 7], 'big')
            width = int.from_bytes(content[index + 7:index + 9], 'big')
            return width, height
        index += 2 + length
    raise ValueError('JPEG 缺少图像尺寸')


class BrowserMaterials:
    def __init__(self, broker):
        self.broker = broker
        self.folder = broker.folder / 'browser'
        self.folder.mkdir(exist_ok=True)
        # Server-side description queue; the app enables it when its workers run.
        self.defer_descriptions = False
        # Per-folder locks: one folder's multi-GB transfer never stalls another
        # folder, and heartbeats or analysis never wait for transfers at all.
        self._locks, self._locks_guard = {}, threading.Lock()
        self._cleanup_guard = threading.Lock()
        self._last_cleanup = None
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
            add_columns(db, 'browser_files', {'mode': "TEXT DEFAULT 'full'", 'ranges': 'TEXT', 'meta': 'TEXT'})
            # A new NAS process can retry interrupted work, retaining any saved vector.
            interrupted = db.execute('SELECT device_id,clip_id FROM browser_analysis WHERE process!=?',
                                     (PROCESS_ID,)).fetchall()
            for row in interrupted:
                db.execute("UPDATE clips SET state='pending' WHERE device_id=? AND id=? AND state='indexing'",
                           (row['device_id'], row['clip_id']))
            db.execute('DELETE FROM browser_analysis WHERE process!=?', (PROCESS_ID,))
        self.cleanup()

    def device_lock(self, device_id):
        with self._locks_guard:
            return self._locks.setdefault(device_id, threading.RLock())

    def connect_folder(self, owner, folder_key, name):
        valid_id(folder_key)
        bounded_text(name, 128, '文件夹名称')
        self.maybe_cleanup()
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

    def maybe_cleanup(self):
        """Request paths run the scan at most every CLEANUP_INTERVAL and never wait for it."""
        self.broker.maybe_cleanup()
        last = self._last_cleanup
        if last is not None and 0 <= time.time() - last < CLEANUP_INTERVAL:
            return
        if not self._cleanup_guard.acquire(blocking=False):
            return
        try:
            self._cleanup(blocking=False)
        finally:
            self._cleanup_guard.release()

    def cleanup(self):
        self.broker.cleanup()
        with self._cleanup_guard:
            self._cleanup(blocking=True)

    @staticmethod
    def _stale(db, row, now):
        device = db.execute('SELECT revoked FROM devices WHERE id=?', (row['device_id'],)).fetchone()
        clip = db.execute('SELECT 1 FROM clips WHERE device_id=? AND asset_id=? AND revoked=0',
                          (row['device_id'], row['asset_id'])).fetchone()
        active = db.execute("SELECT 1 FROM requests WHERE device_id=? AND asset_id=? "
                            "AND (state='pending' OR (kind='source' AND state='complete')) LIMIT 1",
                            (row['device_id'], row['asset_id'])).fetchone()
        return row['expires'] < now or not device or device['revoked'] or not clip or not active

    def _cleanup(self, blocking):
        now = time.time()
        self._last_cleanup = now
        with self.broker.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            # Provider retries may outlast the estimate. A live process keeps its
            # lease until finally; a restarted process clears interrupted leases.
            for row in db.execute('SELECT * FROM browser_analysis WHERE expires<? AND process!=?',
                                  (now, PROCESS_ID)).fetchall():
                db.execute("UPDATE clips SET state='pending' WHERE device_id=? AND id=? AND state='indexing' AND revoked=0",
                           (row['device_id'], row['clip_id']))
            db.execute('DELETE FROM browser_analysis WHERE expires<? AND process!=?', (now, PROCESS_ID))
            db.execute("DELETE FROM browser_files WHERE state='expired' AND created<?",
                       (now - UPLOAD_TTL - TERMINAL_TTL,))
            devices = {row['device_id'] for row in db.execute("SELECT * FROM browser_files WHERE state!='expired'").fetchall()
                       if self._stale(db, row, now)}
        for device_id in devices:
            # A transfer in progress keeps its file; a forced cleanup waits for it.
            lock = self.device_lock(device_id)
            if not lock.acquire(blocking=blocking):
                continue
            try:
                paths = []
                with self.broker.connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    for row in db.execute("SELECT * FROM browser_files WHERE device_id=? AND state!='expired'",
                                          (device_id,)).fetchall():
                        if self._stale(db, row, now):
                            paths.append(Path(row['path']))
                            db.execute("UPDATE browser_files SET state='expired' WHERE id=?", (row['id'],))
                for path in paths:
                    self._unlink(path)
            finally:
                lock.release()

    def _unlink(self, path):
        if Path(path).resolve().is_relative_to(self.folder.resolve()):
            Path(path).unlink(missing_ok=True)

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
                try:
                    size = jpeg_size(content)
                    if min(size) < 1 or max(size) > 640 or dimensions not in (None, size):
                        raise ValueError()
                    dimensions = size
                except ValueError:
                    raise HTTPException(400, 'JPEG 抽帧无法解码或尺寸超过 640 像素') from None
                (folder / f'{index:02}.jpg').write_bytes(content)
            output = folder / 'analysis.mp4'
            try:
                # The encoder still decodes every frame, so corrupt JPEG data fails here.
                media.run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-y', '-framerate', '1',
                           '-i', str(folder / '%02d.jpg'), '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                           '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p',
                           str(output)], slots=media.LIGHT_SLOTS)
            except RuntimeError:
                raise HTTPException(400, 'JPEG 抽帧无法解码，请重新读取素材') from None
            yield output

    @staticmethod
    def video_info(path):
        import media
        result = json.loads(media.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,width,height', '-of', 'json', str(path)], slots=media.LIGHT_SLOTS))
        return result['streams'][0]

    @staticmethod
    def source_info(path):
        """Duration, start time, size and color of the first video stream in one probe."""
        import media
        result = json.loads(media.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
            'format=duration,start_time:stream=codec_name,width,height,'
            'color_primaries,color_transfer,color_space,color_range', '-of', 'json', str(path)],
            slots=media.LIGHT_SLOTS))
        stream, media_format = result['streams'][0], result['format']
        duration, start = float(media_format['duration']), float(media_format.get('start_time') or 0)
        if (not math.isfinite(duration) or duration <= 0 or not math.isfinite(start) or
                min(stream['width'], stream['height']) < 1 or max(stream['width'], stream['height']) > 16384):
            raise ValueError('原片视频参数无效')
        return {**stream, 'duration': duration, 'start_time': start}

    def analysis_source(self, device_id, clip_id):
        self.maybe_cleanup()
        with self.broker.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            clip = self.broker._clip(db, device_id, clip_id)
            if clip['state'] == 'indexed':
                return {'complete': True}
            row = db.execute("SELECT * FROM requests WHERE device_id=? AND clip_id=? AND kind='analysis' "
                             "AND state IN ('pending','complete') AND expires>? ORDER BY created DESC LIMIT 1",
                             (device_id, clip_id, time.time())).fetchone()
            if row and (row['asset_id'], row['start'], row['end']) != (clip['asset_id'], clip['start'], clip['end']):
                db.execute("UPDATE requests SET state='expired' WHERE id=?", (row['id'],))
                row = None
            if row and row['state'] == 'complete' and not (row['path'] and Path(row['path']).is_file()):
                db.execute("UPDATE requests SET state='expired' WHERE id=?", (row['id'],))
                db.execute("UPDATE uploads SET state='expired' WHERE request_id=?", (row['id'],))
                row = None
            if not row:
                request_id, now = uuid.uuid4().hex, time.time()
                db.execute('INSERT INTO requests(id,device_id,clip_id,asset_id,start,end,kind,job_id,created,expires,state) '
                           "VALUES(?,?,?,?,?,?,'analysis',?,?,?,'pending')",
                           (request_id, device_id, clip_id, clip['asset_id'], clip['start'], clip['end'],
                            request_id, now, now + UPLOAD_TTL))
                row = db.execute('SELECT * FROM requests WHERE id=?', (request_id,)).fetchone()
            return {'request': self.broker._request_payload(row), 'source_ready': row['state'] == 'complete'}

    def analyze(self, device_id, clip_id, frames=None, source_request_id=None):
        self.maybe_cleanup()
        lease = uuid.uuid4().hex
        with self.broker.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            clip = self.broker._clip(db, device_id, clip_id)
            source = None
            if source_request_id is not None:
                if frames is not None:
                    raise HTTPException(400, '抽帧和分析代理只能提交一种')
                request = self._request(db, device_id, source_request_id, 'analysis')
                if request['clip_id'] != clip_id:
                    raise HTTPException(409, '分析代理与素材片段不一致')
                if request['state'] != 'complete':
                    raise HTTPException(409, '分析代理尚未准备完成')
                if not request['path'] or not Path(request['path']).is_file():
                    raise HTTPException(410, '分析代理已过期，请重新准备')
                source = Path(request['path'])
            if clip['state'] == 'indexed':
                return {'complete': True}
            if db.execute('SELECT 1 FROM browser_analysis WHERE device_id=? AND clip_id=?',
                          (device_id, clip_id)).fetchone():
                raise HTTPException(409, '片段正在分析，请稍后查询索引状态')
            db.execute('INSERT INTO browser_analysis VALUES(?,?,?,?,?)',
                       (device_id, clip_id, lease, PROCESS_ID, time.time() + ANALYSIS_TTL))
        try:
            started = time.perf_counter()
            with nullcontext(source) if source else self.frame_video(clip, frames) as path:
                record_timing('frames', time.perf_counter() - started)
                self.broker._analyze(device_id, clip_id, path, defer=self.defer_descriptions)
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
        clip = self.broker._clip(db, device_id, request['clip_id'])
        if (request['asset_id'], request['start'], request['end']) != (clip['asset_id'], clip['start'], clip['end']):
            raise HTTPException(410, '素材请求版本或区间已改变')
        if request['state'] not in ('pending', 'complete') or request['expires'] < time.time():
            raise HTTPException(410, '素材请求已过期或撤销')
        if kind and request['kind'] not in ((kind,) if isinstance(kind, str) else kind):
            raise HTTPException(409, '上传内容与素材请求类型不一致')
        return request

    def fulfill(self, device_id, request, path):
        if request['kind'] in ('analysis', 'proxy'):
            # Callers serialize native completion with the device lock. An interrupted
            # validation can safely retry its immutable payload without paid analysis.
            with self.broker.connect() as db:
                db.execute("UPDATE uploads SET state='uploading' WHERE request_id=? AND state='processing'",
                           (request['id'],))
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
        self.maybe_cleanup()
        with self.device_lock(device_id):
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

    @staticmethod
    def _layout(row):
        meta = json.loads(row['meta'] or '{}')
        return json.loads(row['ranges'] or '[]'), meta.get('written', []), meta

    def _check_quota(self, db, device_id, size, exclude=None):
        reserved = db.execute("SELECT coalesce(sum(size * CASE WHEN request_id IS NULL THEN 1 ELSE 2 END),0) FROM uploads WHERE state IN ('uploading','processing') OR (state='complete' AND request_id IS NOT NULL)").fetchone()[0]
        device_reserved = db.execute("SELECT coalesce(sum(size * CASE WHEN request_id IS NULL THEN 1 ELSE 2 END),0) FROM uploads WHERE device_id=? AND (state IN ('uploading','processing') OR (state='complete' AND request_id IS NOT NULL))", (device_id,)).fetchone()[0]
        cached = db.execute(f"SELECT {BROWSER_BYTES} FROM browser_files WHERE state!='expired' AND id IS NOT ?",
                            (exclude,)).fetchone()[0]
        device_cached = db.execute(f"SELECT {BROWSER_BYTES} FROM browser_files WHERE device_id=? AND state!='expired' AND id IS NOT ?",
                                   (device_id, exclude)).fetchone()[0]
        if reserved + cached + size > local_materials.TOTAL_QUOTA or device_reserved + device_cached + size > local_materials.DEVICE_QUOTA:
            raise HTTPException(429, '任务临时素材缓存已满，请等待旧任务缓存过期')

    def _create_file(self, db, device_id, asset_id, size, mode, ranges=None, meta=None, offset=0, previous=None):
        if previous:
            db.execute('DELETE FROM browser_files WHERE id=?', (previous['id'],))
        upload_id, now = uuid.uuid4().hex, time.time()
        path = self.folder / (upload_id + ('.mkv' if mode == 'segment' else '.mp4'))
        with path.open('xb') as file:
            if mode == 'sparse':
                file.truncate(size)
        db.execute('INSERT INTO browser_files(id,device_id,asset_id,size,path,offset,state,created,expires,mode,ranges,meta) '
                   "VALUES(?,?,?,?,?,?,'uploading',?,?,?,?,?)",
                   (upload_id, device_id, asset_id, size, str(path), offset, now, now + UPLOAD_TTL, mode,
                    json.dumps(ranges) if ranges is not None else None, json.dumps(meta or {})))
        return upload_id

    def begin_file(self, device_id, request_id, size):
        if type(size) is not int or not 0 < size <= MAX_SOURCE:
            raise HTTPException(400, '整文件上传的原片必须在 512 MiB 以内，更大的原片会按需上传片段')
        self.maybe_cleanup()
        with self.device_lock(device_id):
            with self.broker.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                request = self._request(db, device_id, request_id, ('source', 'analysis', 'proxy'))
                previous = db.execute('SELECT * FROM browser_files WHERE device_id=? AND asset_id=?',
                                      (device_id, request['asset_id'])).fetchone()
                if (previous and previous['state'] != 'expired' and previous['mode'] == 'full' and
                        previous['expires'] > time.time() and Path(previous['path']).is_file()):
                    if previous['size'] != size:
                        raise HTTPException(409, '原片大小已变化，请重新扫描素材')
                    return {'id': previous['id'], 'offset': Path(previous['path']).stat().st_size}
                self._check_quota(db, device_id, size, previous and previous['id'])
                upload_id = self._create_file(db, device_id, request['asset_id'], size, 'full', previous=previous)
            if previous:
                self._unlink(previous['path'])
            return {'id': upload_id, 'offset': 0}

    def begin_sparse(self, device_id, request_id, size, ranges):
        """Start (or resume) a sparse MP4/MOV: the browser first sends every index box."""
        if type(size) is not int or not 0 < size <= MAX_SPARSE_SOURCE:
            raise HTTPException(400, '原片大小无效')
        index = parse_ranges(ranges, size)
        self.maybe_cleanup()
        with self.device_lock(device_id):
            with self.broker.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                request = self._request(db, device_id, request_id, ('source', 'analysis', 'proxy'))
                previous = db.execute('SELECT * FROM browser_files WHERE device_id=? AND asset_id=?',
                                      (device_id, request['asset_id'])).fetchone()
                if (request['kind'] != 'source' and previous and previous['state'] != 'expired' and
                        previous['mode'] == 'full' and previous['expires'] > time.time() and Path(previous['path']).is_file()):
                    # The browser's sparse-first proxy path must reuse a full source already
                    # retained for rendering. Its 422 fallback resumes that existing file.
                    raise HTTPException(422, '已有完整原片缓存，请恢复整文件传输')
                if (previous and previous['state'] != 'expired' and previous['mode'] == 'sparse' and
                        previous['expires'] > time.time() and Path(previous['path']).is_file()):
                    if previous['size'] != size:
                        raise HTTPException(409, '原片大小已变化，请重新扫描素材')
                    required, written, _ = self._layout(previous)
                    required = merge_ranges(required + index)
                    self._check_quota(db, device_id, total_bytes(required), previous['id'])
                    db.execute("UPDATE browser_files SET state='uploading',ranges=?,offset=?,expires=? WHERE id=?",
                               (json.dumps(required), total_bytes(required), time.time() + UPLOAD_TTL, previous['id']))
                    return {'id': previous['id'], 'ranges': missing_ranges(required, written)}
                self._check_quota(db, device_id, total_bytes(index), previous and previous['id'])
                upload_id = self._create_file(db, device_id, request['asset_id'], size, 'sparse', index,
                                              {'written': [], 'planned': []}, total_bytes(index), previous)
            if previous:
                self._unlink(previous['path'])
            return {'id': upload_id, 'ranges': index}

    def begin_segment(self, device_id, request_id, size, origin):
        """A browser stream copy around one request that keeps the original timestamps."""
        if type(size) is not int or not 0 < size <= MAX_SOURCE:
            raise HTTPException(400, '原片片段必须在 512 MiB 以内')
        if type(origin) not in (int, float) or not math.isfinite(origin) or abs(origin) > 1e7:
            raise HTTPException(400, '原片起始时间无效')
        self.maybe_cleanup()
        with self.device_lock(device_id):
            with self.broker.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                request = self._request(db, device_id, request_id, ('source', 'analysis', 'proxy'))
                previous = db.execute('SELECT * FROM browser_files WHERE device_id=? AND asset_id=?',
                                      (device_id, request['asset_id'])).fetchone()
                meta = {'request': request_id, 'origin': float(origin)}
                if (request['kind'] != 'source' and previous and previous['state'] != 'expired' and
                        previous['mode'] == 'full' and previous['expires'] > time.time() and Path(previous['path']).is_file()):
                    raise HTTPException(422, '已有完整原片缓存，请恢复整文件传输')
                if (previous and previous['state'] == 'uploading' and previous['mode'] == 'segment' and
                        previous['expires'] > time.time() and Path(previous['path']).is_file() and
                        previous['size'] == size and self._layout(previous)[2] == meta):
                    return {'id': previous['id'], 'offset': Path(previous['path']).stat().st_size}
                self._check_quota(db, device_id, size, previous and previous['id'])
                upload_id = self._create_file(db, device_id, request['asset_id'], size, 'segment',
                                              meta=meta, previous=previous)
            if previous:
                self._unlink(previous['path'])
            return {'id': upload_id, 'offset': 0}

    def file_offset(self, device_id, upload_id):
        self.maybe_cleanup()
        with self.broker.connect() as db:
            row = self._file(db, device_id, upload_id)
        if row['mode'] == 'sparse':
            return total_bytes(self._layout(row)[1])
        return Path(row['path']).stat().st_size

    def append_file(self, device_id, upload_id, offset, checksum, content):
        valid_id(checksum)
        if type(offset) is not int or offset < 0:
            raise HTTPException(400, '上传偏移无效')
        if not content or len(content) > MAX_CHUNK:
            raise HTTPException(413, '上传块必须在 1 字节到 4 MiB 之间')
        if hashlib.sha256(content).hexdigest() != checksum:
            raise HTTPException(422, '上传块 SHA256 校验失败，请重试该块')
        self.maybe_cleanup()
        with self.device_lock(device_id):
            with self.broker.connect() as db:
                row = self._file(db, device_id, upload_id)
            path, end = Path(row['path']), offset + len(content)
            if row['state'] != 'uploading':
                raise HTTPException(409, '上传偏移冲突，请重新查询 Upload-Offset')
            if row['mode'] == 'sparse':
                # Upload-Offset is the absolute file position; rewriting a range is idempotent.
                required, written, meta = self._layout(row)
                if end > row['size'] or missing_ranges([[offset, end]], required):
                    raise HTTPException(409, '上传区间不在所需原片范围内')
                with path.open('r+b') as file:
                    file.seek(offset)
                    file.write(content)
                    file.flush()
                    os.fsync(file.fileno())
                meta['written'] = merge_ranges(written + [[offset, end]])
                with self.broker.connect() as db:
                    db.execute('UPDATE browser_files SET meta=?,expires=? WHERE id=?',
                               (json.dumps(meta), time.time() + UPLOAD_TTL, upload_id))
                return {'offset': end}
            if path.stat().st_size != offset:
                raise HTTPException(409, '上传偏移冲突，请重新查询 Upload-Offset')
            if end > row['size']:
                raise HTTPException(413, '上传超出声明的原片大小')
            with path.open('ab') as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            with self.broker.connect() as db:
                db.execute('UPDATE browser_files SET offset=?,expires=? WHERE id=?',
                           (end, time.time() + UPLOAD_TTL, upload_id))
        return {'offset': end}

    def _expire_file(self, upload_id, path):
        with self.broker.connect() as db:
            db.execute("UPDATE browser_files SET state='expired' WHERE id=?", (upload_id,))
        self._unlink(path)

    @staticmethod
    def _packet_ranges(path, requests, size):
        """Byte ranges of every packet ffmpeg reads to cut the requests from the sparse file.

        ffprobe seeks the same way as the extraction (to the keyframe before each start)
        and reports packet positions from the uploaded index; margins cover B-frame
        reordering and audio/video interleaving. The first second is included because
        stream probing reads it before any seek."""
        import media
        probe = json.loads(media.run(['ffprobe', '-v', 'error', '-show_entries', 'format=start_time',
                                      '-of', 'json', str(path)], slots=media.LIGHT_SLOTS))
        origin = float(probe['format'].get('start_time') or 0)
        if not math.isfinite(origin):
            origin = 0.
        intervals = merge_ranges([[origin, origin + 1]] + [[max(origin, origin + request['start'] - 1),
                                                            origin + request['end'] + 3] for request in requests])
        spec = ','.join(f'{start:.3f}%{end:.3f}' for start, end in intervals)
        ranges = []
        for streams in ('v:0', 'a:0'):
            packets = json.loads(media.run(['ffprobe', '-v', 'error', '-select_streams', streams,
                '-read_intervals', spec, '-show_entries', 'packet=pos,size', '-of', 'json=c=1', str(path)],
                slots=media.LIGHT_SLOTS)).get('packets', [])
            for packet in packets:
                position, length = int(packet.get('pos', -1)), int(packet.get('size', 0))
                if position < 0 or length <= 0:
                    continue
                if position + length > size:
                    raise ValueError('原片索引超出文件大小')
                ranges.append([position, position + length])
            if streams == 'v:0' and not ranges:
                raise ValueError('原片索引中没有视频数据')
        return merge_ranges(ranges, RANGE_GAP)

    def plan_file(self, device_id, upload_id):
        """Once the index boxes are present, list the packet ranges pending requests need."""
        self.maybe_cleanup()
        with self.device_lock(device_id):
            with self.broker.connect() as db:
                row = self._file(db, device_id, upload_id)
                requests = db.execute("SELECT * FROM requests WHERE device_id=? AND asset_id=? AND kind IN ('source','analysis','proxy') "
                                      "AND state='pending' AND expires>? ORDER BY created",
                                      (device_id, row['asset_id'], time.time())).fetchall()
            if row['mode'] != 'sparse' or row['state'] != 'uploading':
                raise HTTPException(409, '该上传不是进行中的按需片段上传')
            required, written, meta = self._layout(row)
            if missing_ranges(required, written):
                raise HTTPException(409, '原片索引尚未上传完整')
            planned = set(meta.get('planned', []))
            todo = [request for request in requests if request['id'] not in planned]
            if todo:
                started = time.perf_counter()
                try:
                    needed = self._packet_ranges(Path(row['path']), todo, row['size'])
                except (RuntimeError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                    self._expire_file(upload_id, row['path'])
                    raise HTTPException(422, '原片索引无法解析，请改用片段上传') from None
                record_timing('sparse_plan', time.perf_counter() - started)
                required = merge_ranges(required + needed)
                meta['planned'] = sorted(planned | {request['id'] for request in todo})
                with self.broker.connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    self._check_quota(db, device_id, total_bytes(required), upload_id)
                    db.execute('UPDATE browser_files SET ranges=?,offset=?,meta=?,expires=? WHERE id=?',
                               (json.dumps(required), total_bytes(required), json.dumps(meta),
                                time.time() + UPLOAD_TTL, upload_id))
            return {'id': upload_id, 'ranges': missing_ranges(required, written)}

    @staticmethod
    def _eligible(mode, meta, request):
        if mode == 'sparse':
            return request['id'] in meta.get('planned', [])
        if mode == 'segment':
            covered = meta.get('covered')
            return bool(covered) and request['start'] >= covered[0] - .05 and request['end'] <= covered[1] + .05
        return True

    def _extract(self, path, request, offset, color_filter, output, strict=False):
        import media
        # Re-encode after accurate seek; every extracted clip begins at timestamp zero.
        seconds = request['end'] - request['start']
        if request['kind'] in ('analysis', 'proxy'):
            media.run(['ffmpeg', '-v', 'error', *(['-xerror'] if strict else []), '-nostdin', '-y', '-threads', '2',
                       '-ss', str(offset), '-i', str(path), '-t', str(seconds), '-map', '0:v:0', '-an',
                       '-vf', "setpts=PTS-STARTPTS,fps=1:round=up,scale=w='min(640,iw)':h='min(640,ih)':"
                       f'force_original_aspect_ratio=decrease:force_divisible_by=2,{color_filter}',
                       '-c:v', 'libx264', '-threads', '2', '-filter_threads', '1', '-preset', 'ultrafast',
                       '-crf', '28', '-pix_fmt', 'yuv420p', '-map_metadata', '-1', *media.SDR_FLAGS, str(output)],
                      slots=media.LIGHT_SLOTS)
            return
        samples = round(seconds * 48000)
        media.run(['ffmpeg', '-v', 'error', *(['-xerror'] if strict else []), '-nostdin', '-y', '-threads', '2',
                   '-ss', str(offset), '-i', str(path), '-t', str(seconds),
                   '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k',
                   '-af', f'atrim=start=0:end={seconds},aresample=48000:async=1:first_pts=0,'
                   f'apad=whole_len={samples},atrim=end_sample={samples},asetpts=N/SR/TB',
                   '-vf', f'setpts=PTS-STARTPTS,fps=25,{SCALE_FILTER},{color_filter}', '-c:v', 'libx264',
                   '-threads', '2', '-filter_threads', '1', '-preset', 'fast', '-crf', '0', '-pix_fmt', 'yuv420p',
                   '-map_metadata', '-1', *media.SDR_FLAGS, str(output)])

    def fulfill_sources(self, device_id, asset_id, path, mode='full', meta=None):
        """Validate a received source and cut every pending request it covers.
        Returns the metadata to keep with the cached file."""
        import media
        path, meta = Path(path), dict(meta or {})
        with self.broker.connect() as db:
            requests = db.execute("SELECT * FROM requests WHERE device_id=? AND asset_id=? AND kind IN ('source','analysis','proxy') "
                                  "AND state IN ('pending','complete') AND expires>? ORDER BY created",
                                  (device_id, asset_id, time.time())).fetchall()
        try:
            info = self.source_info(path)
        except (RuntimeError, ValueError, KeyError, IndexError, TypeError, json.JSONDecodeError):
            raise HTTPException(422, '原片无法解码为有效视频，请检查本地文件') from None
        if mode == 'segment':
            # The stream copy keeps original timestamps: its own start time minus the
            # original file's start time is where it sits on the clip timeline.
            first = info['start_time'] - meta['origin']
            meta['covered'] = [first, first + info['duration']]
            wanted = next((request for request in requests if request['id'] == meta['request']), None)
            if wanted and not self._eligible(mode, meta, wanted):
                raise HTTPException(422, '原片片段未覆盖所需区间，请重新读取素材')
        elif any(request['end'] > info['duration'] + .1 for request in requests):
            raise HTTPException(422, '原片时长与素材区间不一致，请重新扫描文件版本')
        color_filter, _ = media.sdr_filter(info)
        for request in requests:
            if request['state'] != 'pending' or not self._eligible(mode, meta, request):
                continue
            offset = request['start']
            if mode == 'segment':
                offset = round(max(0., meta['origin'] + request['start'] - info['start_time']), 6)
            with tempfile.TemporaryDirectory(prefix='source-' + PROCESS_ID + '-', dir=self.folder) as temporary:
                segment = Path(temporary) / 'segment.mp4'
                started = time.perf_counter()
                try:
                    self._extract(path, request, offset, color_filter, segment, strict=mode == 'sparse')
                except RuntimeError:
                    if mode != 'sparse':
                        raise
                    # Missing packet data must never become a silently corrupt clip.
                    raise HTTPException(422, '按需上传的原片数据不完整，请改用片段上传') from None
                record_timing('extract', time.perf_counter() - started)
                self.fulfill(device_id, request, segment)
        return meta

    def complete_file(self, device_id, upload_id):
        self.maybe_cleanup()
        with self.device_lock(device_id):
            with self.broker.connect() as db:
                row = self._file(db, device_id, upload_id)
            if row['mode'] == 'sparse':
                required, written, _ = self._layout(row)
                if missing_ranges(required, written):
                    raise HTTPException(409, '原片片段尚未全部上传')
            elif Path(row['path']).stat().st_size != row['size']:
                raise HTTPException(409, '原片尚未全部上传')
            try:
                meta = self.fulfill_sources(device_id, row['asset_id'], row['path'], row['mode'], self._layout(row)[2])
            except HTTPException as exc:
                if exc.status_code == 422:
                    self._expire_file(upload_id, row['path'])
                raise
            with self.broker.connect() as db:
                self._file(db, device_id, upload_id)
                keep_source = db.execute("SELECT 1 FROM requests WHERE device_id=? AND asset_id=? AND kind='source' "
                                         "AND state IN ('pending','complete') AND expires>? LIMIT 1",
                                         (device_id, row['asset_id'], time.time())).fetchone()
                db.execute("UPDATE browser_files SET state=?,meta=?,"
                           "offset=CASE WHEN mode='sparse' THEN offset ELSE size END WHERE id=?",
                           ('ready' if keep_source else 'expired', json.dumps(meta), upload_id))
            if not keep_source:
                self._unlink(row['path'])
            return {'complete': True}

    def requests(self, device_id):
        self.maybe_cleanup()
        # Matching previews can reuse a previously prepared analysis video; exports never do.
        lock = self.device_lock(device_id)
        if lock.acquire(blocking=False):
            try:
                with self.broker.connect() as db:
                    previews = db.execute("SELECT * FROM requests WHERE device_id=? AND kind='proxy' AND state='pending' AND expires>?",
                                          (device_id, time.time())).fetchall()
                    cached = [(request, db.execute("SELECT path FROM requests WHERE device_id=? AND clip_id=? AND kind='analysis' "
                               "AND state='complete' AND expires>? ORDER BY created DESC LIMIT 1",
                               (device_id, request['clip_id'], time.time())).fetchone()) for request in previews]
                for request, source in cached:
                    if source and source['path'] and Path(source['path']).is_file():
                        self.fulfill(device_id, request, source['path'])
            finally:
                lock.release()
        with self.broker.connect() as db:
            rows = db.execute("SELECT * FROM browser_files WHERE device_id=? AND state='ready'", (device_id,)).fetchall()
            pending = {}
            for request in db.execute("SELECT * FROM requests WHERE device_id=? AND kind='source' AND state='pending'",
                                      (device_id,)).fetchall():
                pending.setdefault(request['asset_id'], []).append(request)
        # Cached sources answer new requests they cover without another browser upload.
        cached = [row for row in rows if any(self._eligible(row['mode'], self._layout(row)[2], request)
                                             for request in pending.get(row['asset_id'], []))]
        lock = self.device_lock(device_id)
        if cached and lock.acquire(blocking=False):
            try:
                for row in cached:
                    with self.broker.connect() as db:
                        current = db.execute("SELECT * FROM browser_files WHERE id=? AND state='ready'", (row['id'],)).fetchone()
                    if not current:
                        continue
                    try:
                        meta = self.fulfill_sources(device_id, current['asset_id'], current['path'],
                                                    current['mode'], self._layout(current)[2])
                    except HTTPException as exc:
                        if exc.status_code != 422:
                            raise
                        self._expire_file(current['id'], current['path'])
                        continue
                    with self.broker.connect() as db:
                        db.execute('UPDATE browser_files SET meta=? WHERE id=?', (json.dumps(meta), current['id']))
            finally:
                lock.release()
        result = self.broker.requests(device_id)
        return {'requests': [request for request in result['requests'] if request['kind'] != 'analysis']}


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
        await call(adapter.maybe_cleanup)
        return await call(broker.heartbeat, device_id, body.get('status', 'ready'), body.get('error', ''))

    @app.post(prefix + '/clips')
    async def clips(request: Request, device_id=Depends(device)):
        body = await material_body(request)
        await call(adapter.maybe_cleanup)
        return await call(broker.register_clips, device_id, body.get('clips'), restore_revoked=True)

    @app.delete(prefix + '/assets/{asset_id}')
    def remove_asset(asset_id: str, device_id=Depends(device)):
        result = broker.remove_asset(device_id, asset_id)
        adapter.cleanup()
        return result

    @app.post(prefix + '/analyze')
    async def analyze(request: Request, device_id=Depends(device)):
        body = await material_body(request, FRAME_BODY_LIMIT)
        return await call(adapter.analyze, device_id, body.get('clip_id'), body.get('frames'), body.get('source_request_id'))

    @app.post(prefix + '/analysis-source')
    async def analysis_source(request: Request, device_id=Depends(device)):
        body = await material_body(request, 4096)
        return await call(adapter.analysis_source, device_id, body.get('clip_id'))

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

    @app.post(prefix + '/requests/{request_id}/sparse')
    async def sparse(request_id: str, request: Request, device_id=Depends(device)):
        body = await material_body(request, 262144)
        return await call(adapter.begin_sparse, device_id, request_id, body.get('size'), body.get('ranges'))

    @app.post(prefix + '/requests/{request_id}/segment')
    async def segment(request_id: str, request: Request, device_id=Depends(device)):
        body = await material_body(request, 4096)
        return await call(adapter.begin_segment, device_id, request_id, body.get('size'), body.get('origin'))

    @app.head(prefix + '/files/{upload_id}')
    def offset(upload_id: str, device_id=Depends(device)):
        return Response(headers={'Upload-Offset': str(adapter.file_offset(device_id, upload_id))})

    @app.patch(prefix + '/files/{upload_id}')
    async def chunk(upload_id: str, request: Request, device_id=Depends(device)):
        value = request.headers.get('upload-offset', '')
        if not value.isascii() or not value.isdecimal() or len(value) > 15:
            raise HTTPException(400, '需要有效 Upload-Offset')
        content = bytearray()
        async for part in request.stream():
            content.extend(part)
            if len(content) > MAX_CHUNK:
                raise HTTPException(413, '单个上传块不得超过 4 MiB')
        return await call(adapter.append_file, device_id, upload_id, int(value),
                          request.headers.get('upload-checksum', ''), content)

    @app.post(prefix + '/files/{upload_id}/plan')
    async def plan(upload_id: str, device_id=Depends(device)):
        return await call(adapter.plan_file, device_id, upload_id)

    @app.post(prefix + '/files/{upload_id}/complete')
    async def complete(upload_id: str, device_id=Depends(device)):
        return await call(adapter.complete_file, device_id, upload_id)

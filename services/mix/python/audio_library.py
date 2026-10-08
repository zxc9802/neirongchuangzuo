"""Account-owned audio metadata and private COS objects for mix jobs."""
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import tempfile
import threading
import time
import unicodedata
import uuid
import wave
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from starlette.concurrency import run_in_threadpool

COS_ENV = ('MIX_AUDIO_COS_SECRET_ID', 'MIX_AUDIO_COS_SECRET_KEY',
           'MIX_AUDIO_COS_BUCKET', 'MIX_AUDIO_COS_REGION')
LIMITS = {'voice': 32 * 1024 * 1024, 'music': 128 * 1024 * 1024}
FORMATS = {'.mp3': 'mp3', '.wav': 'wav', '.m4a': 'mov'}
MAX_DURATION = 24 * 3600


def valid_kind(kind):
    if kind not in LIMITS:
        raise ValueError('音频类型必须是 voice 或 music')
    return kind


def audio_name(value):
    if not isinstance(value, str):
        raise ValueError('需要音频文件名')
    value = ''.join(c for c in value if not unicodedata.category(c).startswith('C'))
    value = value.replace('\\', '/').rsplit('/', 1)[-1].strip()
    ext = Path(value).suffix.lower()
    if ext not in FORMATS:
        raise ValueError('仅支持 MP3、WAV、M4A 音频')
    return value[:-len(ext)][:100-len(ext)] + ext, ext


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def decode(args):
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=180)
        if result.returncode:
            raise ValueError('音频损坏或格式不受支持')
        return result.stdout
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('无法解码音频，请检查文件格式和时长') from None


def probe(path, ext):
    info = json.loads(decode(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                             '-format_whitelist', 'mp3,wav,mov', '-show_format', '-show_streams',
                             '-of', 'json', str(path)]))
    streams = info.get('streams', [])
    formats = info.get('format', {}).get('format_name', '').split(',')
    if FORMATS[ext] not in formats or not any(s.get('codec_type') == 'audio' for s in streams):
        raise ValueError('文件内容与音频格式不符')
    if any(s.get('codec_type') == 'video' and not s.get('disposition', {}).get('attached_pic')
           for s in streams):
        raise ValueError('请上传音频文件，不能上传视频')
    try:
        duration = float(info['format']['duration'])
    except (KeyError, TypeError, ValueError):
        raise ValueError('无法获取有效音频时长') from None
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError('音频时长必须大于零且不超过 24 小时')
    # Decode the complete audio, including music retained without transcoding.
    decode(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe',
            '-format_whitelist', 'mp3,wav,mov', '-f', FORMATS[ext], '-i', str(path),
            '-map', '0:a:0', '-vn', '-f', 'null', 'pipe:1'])
    return duration


class AudioLibrary:
    def __init__(self, root, client=None, env=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.temp_dir = self.root / 'audio-library-tmp'
        self.temp_dir.mkdir(mode=0o700, exist_ok=True)
        self.db_path = self.root / 'audio-library.sqlite3'
        self.env = os.environ if env is None else env
        self.client = client
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS audio (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL,
                name TEXT NOT NULL, duration REAL NOT NULL, bytes INTEGER NOT NULL,
                key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, ext TEXT NOT NULL,
                created REAL NOT NULL, UNIQUE(owner,kind,sha256))''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def status(self):
        missing = [name for name in COS_ENV if not self.env.get(name, '').strip()]
        return {'configured': not missing, 'missing': missing}

    def require_config(self):
        missing = self.status()['missing']
        if missing:
            raise RuntimeError('音频库 COS 配置缺失：' + ', '.join(missing))

    def cos(self):
        self.require_config()
        if self.client is None:
            try:
                from qcloud_cos import CosConfig, CosS3Client
                self.client = CosS3Client(CosConfig(
                    Region=self.env[COS_ENV[3]], SecretId=self.env[COS_ENV[0]],
                    SecretKey=self.env[COS_ENV[1]], Scheme='https'))
            except Exception:
                raise RuntimeError('音频库 COS 客户端不可用') from None
        return self.client

    @staticmethod
    def public(item):
        return {**{key: item[key] for key in ('id', 'kind', 'name', 'duration', 'bytes')},
                'url': '/api/mix/audio/' + item['id'] + '/stream'}

    def list(self, owner, kind):
        valid_kind(kind)
        with self.connect() as db:
            rows = db.execute('SELECT * FROM audio WHERE owner=? AND kind=? ORDER BY created DESC,id',
                              (owner, kind)).fetchall()
        return [self.public(row) for row in rows]

    def get(self, owner, ident, kind=None):
        if not isinstance(ident, str) or not re.fullmatch('[a-f0-9]{32}', ident):
            raise KeyError('音频不存在')
        with self.connect() as db:
            row = db.execute('SELECT * FROM audio WHERE owner=? AND id=?', (owner, ident)).fetchone()
        if row is None or (kind is not None and row['kind'] != kind):
            raise KeyError('音频不存在')
        return dict(row)

    def upload(self, owner, kind, name, path):
        valid_kind(kind)
        name, ext = audio_name(name)
        self.require_config()
        path = Path(path)
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= LIMITS[kind]:
            raise ValueError('音频文件为空、不是普通文件或超过大小限制')
        with tempfile.TemporaryDirectory(prefix='upload-', dir=self.temp_dir) as folder:
            source = Path(folder) / ('source' + ext)
            size = 0
            with path.open('rb') as original, source.open('wb') as output:
                for chunk in iter(lambda: original.read(1024 * 1024), b''):
                    size += len(chunk)
                    if size > LIMITS[kind]:
                        raise ValueError('音频文件超过大小限制')
                    output.write(chunk)
            duration = probe(source, ext)
            stored = source
            if kind == 'voice':
                stored, ext = Path(folder) / 'reference.wav', '.wav'
                decode(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-y',
                        '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mp3,wav,mov',
                        '-i', str(source), '-map', '0:a:0', '-vn', '-t', '15', '-ac', '1',
                        '-ar', '22050', '-c:a', 'pcm_s16le', str(stored)])
                with wave.open(str(stored), 'rb') as reference:
                    duration = reference.getnframes() / reference.getframerate()
                if not 0 < duration <= 15:
                    raise ValueError('声线参考音频没有有效声音时长')
            digest = file_hash(stored)
            with self.lock:
                with self.connect() as db:
                    existing = db.execute('SELECT * FROM audio WHERE owner=? AND kind=? AND sha256=?',
                                          (owner, kind, digest)).fetchone()
                if existing:
                    return self.public(existing)
                ident = uuid.uuid4().hex
                owner_hash = hashlib.sha256(owner.encode('utf-8')).hexdigest()
                key = f'mix-audio/{owner_hash}/{kind}/{ident}{ext}'
                client = self.cos()
                try:
                    with stored.open('rb') as body:
                        client.put_object(Bucket=self.env[COS_ENV[2]], Key=key, Body=body, ACL='private',
                                          ContentType={'.mp3': 'audio/mpeg', '.wav': 'audio/wav',
                                                       '.m4a': 'audio/mp4'}[ext])
                except Exception:
                    raise RuntimeError('音频上传失败，请重试') from None
                try:
                    with self.connect() as db:
                        db.execute('INSERT INTO audio VALUES(?,?,?,?,?,?,?,?,?,?)',
                                   (ident, owner, kind, name, duration, stored.stat().st_size,
                                    key, digest, ext, time.time()))
                except Exception:
                    try:
                        client.delete_object(Bucket=self.env[COS_ENV[2]], Key=key)
                    except Exception:
                        pass
                    # Another process may have registered the identical retry.
                    with self.connect() as db:
                        existing = db.execute('SELECT * FROM audio WHERE owner=? AND kind=? AND sha256=?',
                                              (owner, kind, digest)).fetchone()
                    if existing:
                        return self.public(existing)
                    raise RuntimeError('音频登记失败，请重试') from None
                return self.public(self.get(owner, ident))

    def signed_url(self, owner, ident, expires=3600, method='GET'):
        item = self.get(owner, ident)
        if type(expires) is not int or not 0 < expires <= 3600:
            raise ValueError('音频链接有效期必须为 1 到 3600 秒')
        if method not in ('GET', 'HEAD'):
            raise ValueError('音频链接只支持 GET 或 HEAD')
        client = self.cos()
        try:
            url = client.get_presigned_url(Bucket=self.env[COS_ENV[2]], Key=item['key'],
                                           Method=method, Expired=expires)
            parsed = urlsplit(url)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError()
            return url
        except Exception:
            raise RuntimeError('无法生成安全音频链接') from None

    def download(self, owner, ident, folder):
        item = self.get(owner, ident)
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / ('audio-' + ident + item['ext'])
        if target.is_file() and not target.is_symlink() and file_hash(target) == item['sha256']:
            return target
        target.unlink(missing_ok=True)
        client = self.cos()
        with tempfile.TemporaryDirectory(prefix='.mix-audio-download-', dir=folder) as temporary:
            partial = Path(temporary) / 'audio.part'
            try:
                client.download_file(Bucket=self.env[COS_ENV[2]], Key=item['key'],
                                     DestFilePath=str(partial), DumpRecordDir=temporary,
                                     DisableTempDestFilePath=True)
                if file_hash(partial) != item['sha256']:
                    raise ValueError()
                partial.replace(target)
            except Exception:
                raise RuntimeError('音频下载失败或校验不一致，请重试') from None
        return target

    def delete(self, owner, ident):
        with self.lock:
            item = self.get(owner, ident)
            client = self.cos()
            try:
                client.delete_object(Bucket=self.env[COS_ENV[2]], Key=item['key'])
            except Exception:
                raise RuntimeError('音频删除失败，请重试') from None
            with self.connect() as db:
                db.execute('DELETE FROM audio WHERE owner=? AND id=?', (owner, ident))


def attach_audio_library(app, library, owner, in_use=None):
    async def call(function, *args, **kwargs):
        try:
            return await run_in_threadpool(function, *args, **kwargs)
        except HTTPException:
            raise
        except KeyError:
            raise HTTPException(404, '音频不存在') from None
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from None
        except Exception:
            raise HTTPException(503, '音频库操作失败，请重试') from None

    @app.get('/v1/mix/audio')
    async def items(kind: str, owner_id=Depends(owner)):
        return {**library.status(), 'items': await call(library.list, owner_id, kind)}

    @app.post('/v1/mix/audio')
    async def upload(request: Request, kind: str, name: str, owner_id=Depends(owner)):
        await call(valid_kind, kind)
        safe_name, ext = await call(audio_name, name)
        await call(library.require_config)
        with tempfile.TemporaryDirectory(prefix='request-', dir=library.temp_dir) as temporary:
            path = Path(temporary) / ('audio' + ext)
            size = 0
            with path.open('wb') as output:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > LIMITS[kind]:
                        raise HTTPException(413, '音频文件超过大小限制')
                    await run_in_threadpool(output.write, chunk)
            return {'item': await call(library.upload, owner_id, kind, safe_name, path)}

    def remove(owner_id, ident):
        # Job submission uses the same lock to register selected audio references.
        with library.lock:
            library.get(owner_id, ident)
            if in_use and in_use(owner_id, ident):
                raise HTTPException(409, '音频正被混剪任务使用')
            library.delete(owner_id, ident)
        return {'deleted': True}

    @app.delete('/v1/mix/audio/{ident}')
    async def delete(ident: str, owner_id=Depends(owner)):
        return await call(remove, owner_id, ident)

    @app.api_route('/v1/mix/audio/{ident}/stream', methods=['GET', 'HEAD'])
    async def stream(ident: str, request: Request, owner_id=Depends(owner)):
        url = await call(library.signed_url, owner_id, ident, expires=300, method=request.method)
        return RedirectResponse(url, headers={'Cache-Control': 'private, no-store'})

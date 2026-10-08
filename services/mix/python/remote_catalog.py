"""Search small server indexes; fetch video payloads only when actually needed."""
import json
import re
import shutil
import uuid
from pathlib import Path

import numpy as np


def broker_for(root):
    from local_materials import MaterialBroker
    return MaterialBroker(root)


class RemoteCatalog:
    def __init__(self, config):
        self.config = config
        for field in ('device_id', 'job_id'):
            if not re.fullmatch(r'[a-f0-9]{32}', config[field]):
                raise ValueError('本地素材任务标识无效')
        self.root = Path(config['root']).resolve()
        self.folder = self.root / 'outputs' / config['job_id'] / 'inputs'

    def close(self):
        pass

    def searcher(self):
        records, vectors = [], []
        rows = broker_for(self.root).indexed_clips(self.config['device_id'])
        for row in sorted(rows, key=lambda item: item['id']):
            clip_id = row['id']
            if not re.fullmatch(r'[a-f0-9]{64}', clip_id):
                raise ValueError('本地素材片段标识无效')
            vector = np.asarray(row['vector'], dtype=np.float32)
            if vector.ndim != 1 or not np.all(np.isfinite(vector)) or np.linalg.norm(vector) <= 0:
                raise ValueError('素材向量无效，请重新整理素材')
            vectors.append(vector / np.linalg.norm(vector))
            records.append({'id': row['numeric_id'], 'path': str(self.folder / (clip_id + '.mp4')), 'stamp': '',
                            'source_start': 0., 'source_end': row['end'] - row['start'],
                            'origin_start': row['start'], 'origin_end': row['end'],
                            'proxy': str(self.folder / (clip_id + '-proxy.mp4')),
                            'description': row['description'],
                            'remote': {'root': str(self.root), 'device_id': self.config['device_id'],
                                       'job_id': self.config['job_id'], 'clip_id': clip_id}})
        if not records:
            raise ValueError('本机素材尚未整理完成，请在网页连接素材文件夹')
        matrix = np.stack(vectors)

        def search(query, count):
            vector = np.asarray(query, dtype=np.float32)
            if vector.shape != matrix.shape[1:] or not np.all(np.isfinite(vector)) or np.linalg.norm(vector) <= 0:
                raise ValueError('素材索引与当前检索模型不一致，请重新整理素材')
            scores = matrix @ (vector / np.linalg.norm(vector))
            indices = np.argsort(-scores, kind='stable')[:max(0, count)]
            return [{**records[index], 'distance': float(scores[index])} for index in indices]

        return search


def hydrate(candidates, kind):
    """Enqueue the whole group first; a pending upload must not repeat model checks."""
    required, seen, brokers = [], set(), {}
    for candidate in candidates:
        remote = candidate.get('remote')
        if not remote:
            continue
        target = Path(candidate['proxy'] if kind == 'proxy' else candidate['path'])
        if target.is_file():
            if kind == 'source':
                from matcher import file_stamp
                candidate['stamp'] = file_stamp(target)
            continue
        key = (remote['root'], remote['device_id'], remote['clip_id'], kind)
        if key in seen:
            continue
        seen.add(key)
        broker = brokers.setdefault(remote['root'], broker_for(remote['root']))
        request = broker.request_clip(remote['device_id'], remote['clip_id'], kind, remote['job_id'])
        required.append((broker, request['id'], target))
    for broker, request_id, target in required:
        source = broker.wait_clip(request_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name('.transfer-' + uuid.uuid4().hex)
        try:
            shutil.copyfile(source, temporary)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    if kind == 'source':
        from matcher import file_stamp
        for candidate in candidates:
            if candidate.get('remote'):
                candidate['stamp'] = file_stamp(candidate['path'])

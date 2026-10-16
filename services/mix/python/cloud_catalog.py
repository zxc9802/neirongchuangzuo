"""Account-scoped FAISS snapshots and lazy original/proxy hydration."""
import uuid
from pathlib import Path

import faiss
import numpy as np

from api import Models, unit_vector
from cloud_materials import CloudMaterials, shared_lock
from local_materials import valid_id


class CloudCatalog:
    def __init__(self, config, library=None, embedding=None):
        self.config = config
        self.owner = valid_id(config['owner'])
        valid_id(config['job_id'], 32)
        self.library = library or CloudMaterials(config['root'])
        self.embedding = embedding or Models().embed_url
        self.folder = self.library.folder / 'indexes' / self.owner

    def close(self):
        pass

    def searcher(self):
        with shared_lock(self.folder):
            rows = self.library.rows(self.owner, self.embedding)
            vectors = [unit_vector(np.frombuffer(row['vector'], dtype=np.float32)) for row in rows]
            if any(vector.shape != vectors[0].shape for vector in vectors):
                raise ValueError('素材向量维度不一致，请重新建立索引')
            index = faiss.IndexIDMap2(faiss.IndexFlatIP(len(vectors[0])))
            index.add_with_ids(np.stack(vectors), np.array([row['id'] for row in rows], dtype=np.int64))
            self.folder.mkdir(parents=True, exist_ok=True)
            temporary = self.folder / (uuid.uuid4().hex + '.tmp')
            try:
                temporary.write_bytes(faiss.serialize_index(index).tobytes())
                temporary.replace(self.folder / 'vectors.faiss')
            finally:
                temporary.unlink(missing_ok=True)
        inputs = self.library.root / 'outputs' / self.config['job_id'] / 'inputs'
        records = {row['id']: {'id': row['id'], 'path': str(inputs / (row['asset_id'] + '.mp4')),
            'proxy': str(inputs / (str(row['id']) + '-proxy.mp4')), 'stamp': '',
            'source_start': row['start'], 'source_end': row['end'], 'description': row['description'],
            'remote': {'type': 'cloud', 'root': str(self.library.root), 'owner': self.owner,
                       'asset_id': row['asset_id'], 'clip_id': row['id']}} for row in rows}

        def search(vector, count):
            query = unit_vector(vector)
            if len(query) != index.d:
                raise ValueError('查询向量维度与素材索引不一致')
            if type(count) is not int or count <= 0:
                return []
            scores, ids = index.search(query[None, :], min(count, len(records)))
            return [{**records[int(ident)], 'cosine': float(score)}
                    for score, ident in zip(scores[0], ids[0]) if ident >= 0]

        return search


def hydrate_cloud(candidate, kind, library=None):
    remote = candidate['remote']
    library = library or CloudMaterials(remote['root'])
    valid_id(remote['owner'])
    if kind == 'proxy':
        candidate['proxy'] = str(library.cache_proxy(remote['owner'], remote['clip_id']))
    elif kind == 'source':
        from matcher import file_stamp
        path = library.cache_source(remote['owner'], remote['asset_id'])
        candidate.update(path=str(path), stamp=file_stamp(path))
    else:
        raise ValueError('素材读取类型无效')

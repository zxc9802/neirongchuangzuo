"""Authenticated cloud library endpoints; storage keys never come from clients."""
from fastapi import Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from starlette.concurrency import run_in_threadpool
from credits import CreditError


def attach_cloud_materials(app, library, owner, body, in_use):
    async def call(function, *args):
        try:
            return await run_in_threadpool(function, *args)
        except KeyError:
            raise HTTPException(404, '素材不存在') from None
        except CreditError as error:
            raise HTTPException(error.status, str(error)) from None
        except ValueError as error:
            raise HTTPException(400, str(error)) from None
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, '云端素材服务暂时不可用，请稍后重试') from None

    @app.get('/v1/mix/materials')
    async def items(owner_id=Depends(owner)):
        rows = await call(library.list, owner_id)
        return {'configured': library.status()['configured'], 'items': rows,
                'indexed_clips': sum(item['indexed_clips'] for item in rows if item['state'] == 'ready')}

    @app.post('/v1/mix/materials/uploads', status_code=201)
    async def upload(request: Request, owner_id=Depends(owner)):
        data = await body(request, 4096)
        if set(data) not in ({'name', 'bytes'}, {'name', 'bytes', 'fingerprint'},
                             {'name', 'bytes', 'fingerprint', 'reuse_legacy'}):
            raise HTTPException(400, '请提交视频名称和文件大小')
        if 'fingerprint' in data and data['fingerprint'] is None:
            raise HTTPException(400, '视频文件标识无效，请重新选择素材文件夹')
        return await call(library.create_upload, owner_id, data['name'], data['bytes'],
                          data.get('fingerprint'), data.get('reuse_legacy', False))

    @app.post('/v1/mix/materials/{ident}/complete')
    async def complete(ident: str, owner_id=Depends(owner)):
        return {'item': await call(library.complete, owner_id, ident)}

    @app.post('/v1/mix/materials/{ident}/retry')
    async def retry(ident: str, owner_id=Depends(owner)):
        return {'item': await call(library.retry, owner_id, ident)}

    def remove(owner_id, ident):
        with library.lock:
            library.get(owner_id, ident)
            if in_use(owner_id):
                raise HTTPException(409, '素材正在用于制作，请任务结束后再删除')
            library.delete(owner_id, ident)

    @app.delete('/v1/mix/materials/{ident}')
    async def delete(ident: str, owner_id=Depends(owner)):
        await call(remove, owner_id, ident)
        return {'ok': True}

    @app.api_route('/v1/mix/materials/{ident}/stream', methods=['GET', 'HEAD'])
    async def stream(ident: str, request: Request, owner_id=Depends(owner)):
        url = await call(library.signed_url, owner_id, ident, request.method)
        return RedirectResponse(url, status_code=307, headers={'Cache-Control': 'no-store'})

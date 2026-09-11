"""Copy an approved legacy account export into its linked Google account.

Uses existing Wrangler authentication and the private, short-lived transfer
capability produced by the browser import. Never logs credentials or records.
Run from this checkout with Python 3. Monitoring copies start paused.
"""
import hashlib
import json
import re
import time
import subprocess
import base64
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import quote
from urllib.error import HTTPError

ACCOUNT = '13aee27300575d6bfbc1362397eb3a9b'
DATABASE = 'cfbf8d54-da94-43c7-8d0c-e2f7613bfa8b'
BUCKET = 'api-diagnostics-evidence'
BASE = 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT
SOURCE = 'https://normal-token-check.yh-xue-2023.chatgpt.site/api/cloudflare-history'
TABLES = ['test_runs', 'test_results', 'rpm_runs', 'rpm_stages',
          'diagnostic_runs', 'animation_results', 'availability_targets', 'availability_samples']


def request(url, method='GET', data=None, headers=None):
    for attempt in range(8):
        try:
            if url == SOURCE or url == 'https://api-diagnostics.xue-yuanhuang.workers.dev/api/migration/evidence':
                script="let input='';for await(const c of process.stdin)input+=c;const a=JSON.parse(input);const r=await fetch(a.url,{method:a.method,headers:a.headers,body:Buffer.from(a.data,'base64'),redirect:'manual'});if(!r.ok){process.stderr.write('HTTP '+r.status);process.exit(1)}process.stdout.write(Buffer.from(await r.arrayBuffer()));"
                result=subprocess.run(['/Users/yuanhuang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node','--input-type=module','-e',script],input=json.dumps({'url':url,'method':method,'headers':headers or {},'data':base64.b64encode(data or b'').decode()}).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
                if result.returncode:
                    status=re.search(r'HTTP (\d+)',result.stderr.decode())
                    if status: raise HTTPError(url,int(status.group(1)),'Source export failed',None,None)
                    raise RuntimeError('Source export transport failed.')
                return result.stdout
            with urlopen(Request(url, data=data, headers=headers or {}, method=method), timeout=90) as response:
                return response.read()
        except HTTPError as error:
            if error.code not in (429,500,502,503,504) or attempt==7:
                raise RuntimeError('Migration endpoint returned HTTP '+str(error.code)) from None
            time.sleep(min(30, 2 ** attempt))
        except Exception:
            if attempt == 7:
                raise RuntimeError('Migration request failed; no credentials or records were logged.') from None
            time.sleep(min(30, 2 ** attempt))


def main():
    config = (Path.home() / 'Library/Preferences/.wrangler/config/default.toml').read_text()
    token = json.loads(re.search(r'^oauth_token\s*=\s*(".*")$', config, re.M).group(1))
    headers = {'Authorization': 'Bearer ' + token}

    def query(sql, params=()):
        result = json.loads(request(BASE + '/d1/database/' + DATABASE + '/query', 'POST',
            json.dumps({'sql': sql, 'params': list(params)}).encode(),
            dict(headers, **{'Content-Type': 'application/json'})))
        if not result.get('success') or any(item.get('success') is False for item in result.get('result', [])):
            raise RuntimeError('Database migration query failed.')
        return result['result'][0]['results']

    def object_url(key):
        return BASE + '/r2/buckets/' + BUCKET + '/objects/' + quote(key, safe='/')

    def put(key, data):
        request(object_url(key), 'PUT', data, dict(headers, **{'Content-Type': 'application/octet-stream'}))
        check = request(object_url(key), headers=headers)
        if hashlib.sha256(check).digest() != hashlib.sha256(data).digest():
            raise RuntimeError('Stored evidence checksum mismatch.')

    links = query('SELECT source_user,target_user FROM legacy_account_links')
    if len(links) != 1:
        raise RuntimeError('Expected one approved account link; select an account explicitly before proceeding.')
    source, owner = links[0]['source_user'], links[0]['target_user']
    capability_key = 'migrations/' + owner + '/source-transfer.json'
    capability = json.loads(request(object_url(capability_key), headers=headers))
    if capability['sourceUser'] != source or capability['targetUser'] != owner or capability['expiresAt'] < time.time()*1000:
        raise RuntimeError('Account transfer approval is invalid or expired.')

    def export(**body):
        return request(SOURCE, 'POST', json.dumps(dict(body, ticket=capability['ticket'], verifier=capability['verifier'])).encode(), {'Content-Type': 'application/json'})

    snapshot_key='migrations/' + owner + '/original-records.json'
    if '--resume' in sys.argv:
        records=json.loads(request(object_url(snapshot_key),headers=headers))
        print('Resuming verified private source snapshot',flush=True)
    else:
        records = {}
        for table in TABLES:
            rows, offset = [], 0
            while offset is not None:
                page = json.loads(export(table=table, offset=offset))
                rows.extend(page['rows'])
                offset = page['nextOffset']
            records[table] = rows
            print('Exported', table, len(rows), flush=True)
        put(snapshot_key, json.dumps(records, ensure_ascii=False).encode())
    manifest={'sourceUser':source,'rpmRunIds':[r['id'] for r in records['rpm_runs'] if r['user_id']==source],'exactKeys':[r['evidence_key'] for t in ('diagnostic_runs','animation_results') for r in records[t] if r['user_id']==source and r.get('evidence_key')]}
    put('migrations/'+owner+'/evidence-allowlist.json',json.dumps(manifest).encode())
    mapping = {row['source_id']: row['target_id'] for row in query('SELECT source_id,target_id FROM chatgpt_imports WHERE user_id=?', [owner])}

    keys = set()
    for table in ('diagnostic_runs', 'animation_results'):
        keys.update(row['evidence_key'] for row in records[table] if row.get('evidence_key'))
    if '--indexed' in sys.argv:
        keys=set(json.loads(request(object_url('migrations/'+owner+'/evidence-index.json'),headers=headers)))
        print('Resuming evidence index',len(keys),'files',flush=True)
    else:
        def list_run(run):
            cursor=None
            run_keys=set()
            while True:
                page=json.loads(export(action='list_rpm',runId=run['id'],cursor=cursor))
                run_keys.update(item['key'] for item in page['objects'])
                cursor=page.get('cursor')
                if not cursor: break
            return run_keys
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures=[pool.submit(list_run,run) for run in records['rpm_runs']]
            for index,future in enumerate(as_completed(futures)):
                keys.update(future.result())
                print('Listed RPM evidence',index+1,'of',len(futures),'objects so far',len(keys),flush=True)
        put('migrations/'+owner+'/evidence-index.json',json.dumps(sorted(keys)).encode())
    # Reject collisions before storing evidence or rows under existing IDs.
    for table in TABLES:
        existing_rows = {r['id']:r for r in query('SELECT * FROM "'+table+'"')}
        for row in records[table]:
            if row['id'] in existing_rows:
                old = existing_rows[row['id']]
                if 'user_id' in old and old['user_id'] != owner:
                    raise RuntimeError('Existing record belongs to a different account.')
                for parent in ('run_id', 'target_id'):
                    if parent in row and old.get(parent) != row[parent]:
                        raise RuntimeError('Existing child record has a different parent.')
    # R2 single-part object ETags are content MD5s. Compare with the source
    # bytes before skipping already stored objects after an interrupted copy.
    stored_etags = {}
    cursor = None
    checkpoint = Path('/tmp/api-diagnostics-migration-verified.json')
    completed = set(json.loads(checkpoint.read_text())) & keys if checkpoint.exists() else set()
    while completed != keys:
        listing_url = BASE + '/r2/buckets/' + BUCKET + '/objects?per_page=1000'
        if cursor: listing_url += '&cursor=' + quote(cursor, safe='')
        listing = json.loads(request(listing_url, headers=headers))
        if not listing.get('success'): raise RuntimeError('Evidence inventory failed.')
        for item in listing['result']:
            if item['key'] in keys:
                stored_etags[item['key']] = item['etag'].strip('"')
        info = listing.get('result_info', {})
        if not info.get('is_truncated'): break
        cursor = info['cursor']
    print('Existing evidence to compare', len(stored_etags), flush=True)

    def copy_batch(batch):
        objects=[]
        try:
            source_objects=json.loads(export(action='objects',keys=batch))['objects']
        except RuntimeError as error:
            if 'HTTP 413' not in str(error): raise
            if len(batch)>1:
                middle=len(batch)//2
                return copy_batch(batch[:middle])+copy_batch(batch[middle:])
            put(batch[0],export(action='object',key=batch[0]))
            return 1
        if {item['key'] for item in source_objects}!=set(batch): raise RuntimeError('Source batch keys do not match.')
        for item in source_objects:
            data=base64.b64decode(item['data'],validate=True)
            if stored_etags.get(item['key']) == hashlib.md5(data).hexdigest():
                continue
            objects.append({'key':item['key'],'data':item['data'],'sha256':hashlib.sha256(data).hexdigest()})
        if not objects: return len(batch)
        payload=json.dumps({'owner':owner,'ticket':capability['ticket'],'verifier':capability['verifier'],'objects':objects}).encode()
        if len(payload)>5_000_000:
            if len(batch)==1: raise RuntimeError('Evidence object exceeds batch endpoint size limit.')
            middle=len(batch)//2
            return copy_batch(batch[:middle])+copy_batch(batch[middle:])
        response=json.loads(request('https://api-diagnostics.xue-yuanhuang.workers.dev/api/migration/evidence','POST',payload,{'Content-Type':'application/json'}))
        if response.get('verified')!=len(objects): raise RuntimeError('Evidence batch verification failed.')
        return len(batch)
    checkpoint = Path('/tmp/api-diagnostics-migration-verified.json')
    completed = set(json.loads(checkpoint.read_text())) & keys if checkpoint.exists() else set()
    remaining = sorted(keys - completed)
    batches=[remaining[i:i+10] for i in range(0,len(remaining),10)]
    verified=len(completed)
    pool=ThreadPoolExecutor(max_workers=6)
    futures={pool.submit(copy_batch,batch): batch for batch in batches}
    try:
        for future in as_completed(futures):
            verified+=future.result()
            completed.update(futures[future])
            temporary = checkpoint.with_suffix(".pending")
            temporary.write_text(json.dumps(sorted(completed)))
            temporary.replace(checkpoint)
            if verified%100==0 or verified==len(keys):
                print('Verified evidence',verified,'of',len(keys),flush=True)
    except BaseException:
        pool.shutdown(wait=False,cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)

    def sql_value(value):
        if value is None: return 'NULL'
        if isinstance(value,(int,float)): return str(value)
        return "'"+str(value).replace("'","''")+"'"

    for table in TABLES:
        statements=[]
        for source_row in records[table]:
            row = dict(source_row)
            if 'user_id' in row:
                if row['user_id'] != source:
                    raise RuntimeError('Source ownership mismatch.')
                row['user_id'] = owner
            if row.get('profile_id'):
                if row['profile_id'] not in mapping:
                    # A historical run may reference a connection that was deleted.
                    if table == 'availability_targets':
                        raise RuntimeError('Monitor connection was not imported.')
                    row['profile_id'] = None
                else:
                    row['profile_id'] = mapping[row['profile_id']]
            if table == 'availability_targets':
                row['paused'] = 1
            columns = list(row)
            if any(not re.fullmatch('[a-z_][a-z0-9_]*', col) for col in columns):
                raise RuntimeError('Unexpected export column.')
            sql = 'INSERT OR IGNORE INTO "' + table + '" (' + ','.join('"'+c+'"' for c in columns) + ') VALUES (' + ','.join(sql_value(row[col]) for col in columns) + ')'
            statements.append(sql)
            if len(statements)==20:
                query(';'.join(statements))
                statements=[]
        if statements: query(';'.join(statements))
        present={r['id'] for r in query('SELECT id FROM "'+table+'"')}
        if any(r['id'] not in present for r in records[table]):
            raise RuntimeError('Imported record missing.')
        print('Imported', table, len(records[table]), flush=True)
    summary = {'completedAt': int(time.time()*1000), 'counts': {t: len(records[t]) for t in TABLES}, 'evidenceObjects': len(keys), 'monitoringPaused': True}
    put('migrations/' + owner + '/completed.json', json.dumps(summary).encode())
    # The expiring capability stays private and expires automatically. Keeping it
    # until expiry permits a retry without deleting original or imported data.
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()

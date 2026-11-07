"""Download a vanilla client (jar, Linux libraries, non-sound assets): getclient.py VERSION_JSON DEST"""
import json, os, sys, hashlib, urllib.request, concurrent.futures as cf
vj, dest = sys.argv[1], sys.argv[2]
v = json.load(open(vj))
def fetch(url, path, sha1=None):
    if os.path.exists(path) and (sha1 is None or hashlib.sha1(open(path,'rb').read()).hexdigest() == sha1):
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = urllib.request.urlopen(url, timeout=120).read()
    if sha1 and hashlib.sha1(data).hexdigest() != sha1:
        raise SystemExit('sha1 mismatch ' + url)
    open(path, 'wb').write(data); return len(data)
def allowed(lib):
    rules = lib.get('rules')
    if not rules: return True
    ok = False
    for r in rules:
        osn = r.get('os', {}).get('name')
        if osn is None or osn == 'linux': ok = r['action'] == 'allow'
    return ok
jobs = []
c = v['downloads']['client']; jobs.append((c['url'], f'{dest}/client.jar', c['sha1']))
cp = [f'{dest}/client.jar']
for lib in v['libraries']:
    if not allowed(lib): continue
    a = lib.get('downloads', {}).get('artifact')
    if a:
        p = f"{dest}/libraries/{a['path']}"; jobs.append((a['url'], p, a['sha1'])); cp.append(p)
ai = v['assetIndex']; idxp = f"{dest}/assets/indexes/{ai['id']}.json"
fetch(ai['url'], idxp, ai['sha1'])
objs = json.load(open(idxp))['objects']
skipped = 0
for name, o in objs.items():
    if name.startswith(('minecraft/sounds/', 'minecraft/music/', 'minecraft/sounds.json/')) or name.endswith('.ogg'):
        skipped += 1; continue
    h = o['hash']; jobs.append((f"https://resources.download.minecraft.net/{h[:2]}/{h}", f"{dest}/assets/objects/{h[:2]}/{h}", h))
total = 0
with cf.ThreadPoolExecutor(24) as ex:
    for n in ex.map(lambda j: fetch(*j), jobs): total += n
open(f'{dest}/classpath.txt', 'w').write(':'.join(cp))
print(f"{len(jobs)} files ({total/1e6:.0f} MB new), {len(cp)-1} libraries, skipped {skipped} sound assets; assetIndex {ai['id']}; mainClass {v['mainClass']}")

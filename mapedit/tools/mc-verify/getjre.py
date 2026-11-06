import json, os, sys, hashlib, urllib.request, concurrent.futures as cf
man_url, dest = sys.argv[1], sys.argv[2]
m = json.load(urllib.request.urlopen(man_url))
files = m['files']
os.makedirs(dest, exist_ok=True)
def get(item):
    path, e = item
    p = os.path.join(dest, path)
    if e['type'] == 'directory':
        os.makedirs(p, exist_ok=True); return 0
    if e['type'] == 'link':
        return ('link', p, e['target'])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    raw = e['downloads']['raw']
    data = urllib.request.urlopen(raw['url']).read()
    if hashlib.sha1(data).hexdigest() != raw['sha1']:
        raise SystemExit('sha1 mismatch ' + path)
    open(p, 'wb').write(data)
    if e.get('executable'): os.chmod(p, 0o755)
    return len(data)
dirs = [(k, v) for k, v in files.items() if v['type'] == 'directory']
for d in dirs: get(d)
rest = [(k, v) for k, v in files.items() if v['type'] != 'directory']
links = []
total = 0
with cf.ThreadPoolExecutor(16) as ex:
    for r in ex.map(get, rest):
        if isinstance(r, tuple): links.append(r)
        else: total += r
for _, p, t in links:
    if not os.path.lexists(p): os.symlink(t, p)
print('files', len(rest), 'bytes', total)

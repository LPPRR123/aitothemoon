"""Download vanilla server jars (and Mojang's Java 25 runtime) for verification.
usage: python3 setup.py 1.21.4 26.3     (files go to $MC_HOME, default ./mc-verify-work)"""
import json, os, sys, hashlib, urllib.request, subprocess
home = os.environ.get("MC_HOME", os.path.join(os.getcwd(), "mc-verify-work"))
os.makedirs(home, exist_ok=True)
man = json.load(urllib.request.urlopen("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"))
print("latest release:", man["latest"]["release"])
for ver in sys.argv[1:] or [man["latest"]["release"]]:
    v = json.load(urllib.request.urlopen([x["url"] for x in man["versions"] if x["id"] == ver][0]))
    s = v["downloads"]["server"]
    os.makedirs(f"{home}/srv-{ver}", exist_ok=True)
    data = urllib.request.urlopen(s["url"]).read()
    assert hashlib.sha1(data).hexdigest() == s["sha1"], "sha1 mismatch"
    open(f"{home}/srv-{ver}/server.jar", "wb").write(data)
    print(ver, "server.jar ok, needs Java", v["javaVersion"]["majorVersion"])
if not os.path.exists(f"{home}/jre/bin/java"):
    rt = json.load(urllib.request.urlopen("https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json"))
    url = rt["linux"]["java-runtime-epsilon"][0]["manifest"]["url"]
    subprocess.check_call([sys.executable, os.path.join(os.path.dirname(__file__), "getjre.py"), url, f"{home}/jre"])

"""Run a vanilla server against a save: forceUpgrade pass, then optional commands."""
import subprocess, sys, os, shutil, time, re, threading, queue
ver, save, mode = sys.argv[1], sys.argv[2], sys.argv[3]   # mode: upgrade | run
cmds = sys.argv[4:]                                         # extra console commands for run mode
S = os.environ.get("MC_HOME", os.path.join(os.getcwd(), "mc-verify-work"))
srv = f"{S}/srv-{ver}"
java = os.environ.get("MC_JAVA", f"{S}/jre/bin/java")
name = os.path.basename(save.rstrip('/')) + "-test"
world = f"{srv}/{name}"
if mode == "upgrade":
    shutil.rmtree(world, ignore_errors=True)
    shutil.copytree(save, world)
open(f"{srv}/eula.txt", "w").write("eula=true\n")
open(f"{srv}/server.properties", "w").write(
    f"level-name={name}\nonline-mode=false\nview-distance=6\nsimulation-distance=4\nspawn-protection=0\n"
    "max-tick-time=-1\nsync-chunk-writes=false\nenable-command-block=true\n")
args = [java, "-Xmx6G", "-jar", "server.jar", "--nogui"]
if mode == "upgrade":
    args.insert(4, "--forceUpgrade")
env = dict(os.environ); env.pop("JAVA_TOOL_OPTIONS", None)
p = subprocess.Popen(args, cwd=srv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
lines = queue.Queue()
log = []
def reader():
    for l in p.stdout:
        log.append(l.rstrip()); lines.put(l.rstrip())
    lines.put(None)
threading.Thread(target=reader, daemon=True).start()
def wait_for(pat, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try: l = lines.get(timeout=1)
        except queue.Empty: continue
        if l is None: return None
        if re.search(pat, l): return l
    return None
def send(c):
    p.stdin.write(c + "\n"); p.stdin.flush()
t0 = time.time()
done = wait_for(r"Done \(", 1800)
print(f"[{ver} {mode}] startup {'OK' if done else 'FAILED'} in {time.time()-t0:.0f}s")
outputs = []
if done:
    for c in cmds:
        if c.startswith("sleep:"):
            time.sleep(float(c[6:])); continue
        n0 = len(log); send(c); time.sleep(1.5)
        outputs.append((c, log[n0:]))
    send("save-all flush"); wait_for(r"Saved the game", 600)
    send("stop")
p.wait(timeout=600)
for c, out in outputs:
    print(f"> {c}")
    for l in out: print("   ", re.sub(r"^\[[^\]]*\] \[[^\]]*\]: ", "", l)[:200])
warn = [l for l in log if re.search(r"WARN|ERROR|Exception|Failed|failed|Couldn't|corrupt", l)]
print(f"[{ver} {mode}] exit {p.returncode}, {len(log)} log lines, {len(warn)} warn/error lines")
for l in warn[:60]: print("  ", l[:300])
open(f"{S}/log-{ver}-{name}-{mode}.txt", "w").write("\n".join(log))

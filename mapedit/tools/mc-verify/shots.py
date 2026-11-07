"""usage: shots.py SCENES_DIR OUT_DIR [WAIT_SECONDS]
Drive a running Minecraft client (DISPLAY=:99) to screenshot each scene from its view camera."""
import json, math, os, subprocess, sys, time, glob
scenes_dir = sys.argv[1]; out = sys.argv[2]
os.makedirs(out, exist_ok=True)
env = dict(os.environ, DISPLAY=":99")
def xdo(*a): subprocess.run(["xdotool", *a], env=env, check=True)
def grab(path): subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "x11grab", "-video_size", "1280x720", "-i", ":99", "-frames:v", "1", path], check=True)
def cmd(c):
    xdo("key", "t"); time.sleep(0.8)
    xdo("type", "--delay", "15", c); time.sleep(0.3)
    xdo("key", "Return"); time.sleep(0.8)
def pt(s):
    v = [float(x) for x in s.split(",")]
    return v
TIMES = {"night": 18000, "dusk": 12600, "day": 6000}
first = True
for f in sorted(glob.glob(f"{scenes_dir}/*.json")):
    calls = json.load(open(f))
    name = [c["args"]["name"] for c in calls if c["tool"] == "world_create"][0]
    v = [c["args"] for c in calls if c["tool"] == "view"][-1]
    cam, look = pt(v["camera"]), pt(v["look_at"])
    dx, dy, dz = look[0] - cam[0], look[1] - cam[1], look[2] - cam[2]
    yaw = math.degrees(math.atan2(dx, -dz))          # ours: 0 = north, 90 = east
    pitch = math.degrees(math.atan2(dy, math.hypot(dx, dz)))
    mc_yaw = (yaw + 180) % 360                        # minecraft: 0 = south, 90 = west
    mc_pitch = -pitch                                 # minecraft: positive = down
    dim = "minecraft:overworld" if f.endswith("01_spore_forest.json") else f"mapedit:{name}"
    if first:
        cmd("/gamemode spectator"); first = False
    cmd(f"/time set {TIMES.get(v.get('time', 'day'), 6000)}")
    cmd(f"/execute in {dim} run tp @s {cam[0]:.1f} {cam[1]:.1f} {cam[2]:.1f} {mc_yaw:.1f} {mc_pitch:.1f}")
    time.sleep(float(sys.argv[3]) if len(sys.argv) > 3 else 40)
    p = f"{out}/{os.path.basename(f)[:-5]}.png"
    grab(p); print(p, "yaw", round(mc_yaw), "pitch", round(mc_pitch), flush=True)

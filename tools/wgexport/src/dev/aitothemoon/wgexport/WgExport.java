package dev.aitothemoon.wgexport;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.ChunkSnapshot;
import org.bukkit.Color;
import org.bukkit.HeightMap;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.server.ServerLoadEvent;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Test-only plugin for the worldgen loop. Reads wgexport-job.json from the server folder,
 * generates a square area (with Chunky when it is installed, otherwise with Paper's own
 * async chunk loading), exports one record per column plus full cross sections, and stops
 * the server. The job starts by itself once the server has finished loading.
 *
 * columns.bin: little endian, rows along z then x, 10 bytes per column:
 *   int16 groundY, int16 waterY (-32768 = no water), uint16 topBlock, uint16 groundBlock, uint16 biome
 * sections/NAME.bin: for each column along the line, uint16 block index for y = minY .. maxY-1
 */
public final class WgExport extends JavaPlugin implements Listener {
    private static final String JOB_FILE = "wgexport-job.json";
    private static final int NO_WATER = -32768;
    /** How many chunk requests may be waiting at once. */
    private static final int MAX_IN_FLIGHT = 96;

    private boolean running = false;

    @Override public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
    }

    @EventHandler public void onServerLoad(ServerLoadEvent event) {
        if (event.getType() != ServerLoadEvent.LoadType.STARTUP) return;
        if (new File(JOB_FILE).isFile()) Bukkit.getScheduler().runTaskLater(this, this::startJob, 20L);
    }

    @Override public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) {
            sender.sendMessage("wgrun can only be used from the server console");
            return true;
        }
        startJob();
        return true;
    }

    private void startJob() {
        if (running) {
            getLogger().warning("a job is already running");
            return;
        }
        try {
            String text = Files.readString(new File(JOB_FILE).toPath(), StandardCharsets.UTF_8);
            Job job = new Job(new Gson().fromJson(text, JsonObject.class));
            running = true;
            job.start();
        } catch (Exception e) {
            fail(null, e);
        }
    }

    /** Writes error.json next to the output (when known), logs, and stops the server if the job asked for that. */
    private void fail(Job job, Throwable e) {
        getLogger().severe("WgExport failed: " + e);
        e.printStackTrace();
        running = false;
        if (job == null) return;
        try {
            JsonObject err = new JsonObject();
            err.addProperty("error", String.valueOf(e));
            job.outDir.mkdirs();
            Files.writeString(new File(job.outDir, "error.json").toPath(), err.toString(), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // nothing more we can do
        }
        if (job.stopWhenDone) Bukkit.shutdown();
    }

    private static final class Section {
        final String name;
        final boolean alongX; // true: a line of constant z, walking along x
        final int at;
        short[] data;
        Section(String name, boolean alongX, int at) { this.name = name; this.alongX = alongX; this.at = at; }
    }

    private final class Job {
        final World world;
        final int size, x0, z0;
        final boolean export, stopWhenDone, useChunky;
        final File outDir;
        final List<Section> sections = new ArrayList<>();
        final int minY, maxY, height;

        // per column output
        short[] groundY, waterY, topBlock, groundBlock, biome;
        final Map<Material, Integer> blockIndex = new HashMap<>();
        final List<Material> blockList = new ArrayList<>();
        final Map<String, Integer> biomeIndex = new HashMap<>();
        final List<String> biomeList = new ArrayList<>();

        // material classes, by ordinal
        final boolean[] isWater, isSkipped;

        final ArrayDeque<long[]> pending = new ArrayDeque<>();
        int total, done, inFlight;
        long startedAt, generatedAt, lastLog;
        boolean chunkyUsed = false;
        boolean finished = false;

        Job(JsonObject j) {
            String worldName = j.has("world") ? j.get("world").getAsString() : "world";
            world = Bukkit.getWorld(worldName);
            if (world == null) throw new IllegalArgumentException("no such world: " + worldName);
            size = j.has("size") ? j.get("size").getAsInt() : 1000;
            int cx = j.has("cx") ? j.get("cx").getAsInt() : 0;
            int cz = j.has("cz") ? j.get("cz").getAsInt() : 0;
            if (size < 16 || size > 4096) throw new IllegalArgumentException("size must be 16..4096");
            x0 = cx - size / 2;
            z0 = cz - size / 2;
            export = !j.has("export") || j.get("export").getAsBoolean();
            stopWhenDone = !j.has("stopWhenDone") || j.get("stopWhenDone").getAsBoolean();
            useChunky = !j.has("useChunky") || j.get("useChunky").getAsBoolean();
            outDir = new File(j.has("outDir") ? j.get("outDir").getAsString() : "wgexport-out");
            minY = world.getMinHeight();
            maxY = world.getMaxHeight();
            height = maxY - minY;
            if (j.has("sections")) {
                for (JsonElement el : j.getAsJsonArray("sections")) {
                    JsonObject s = el.getAsJsonObject();
                    String name = s.get("name").getAsString();
                    if (!name.matches("[A-Za-z0-9_-]{1,40}")) throw new IllegalArgumentException("bad section name: " + name);
                    boolean alongX = s.get("axis").getAsString().equals("x");
                    int at = s.get("at").getAsInt();
                    int lo = alongX ? z0 : x0;
                    if (at < lo || at >= lo + size) throw new IllegalArgumentException("section " + name + " is outside the area");
                    sections.add(new Section(name, alongX, at));
                }
            }
            Material[] all = Material.values();
            isWater = new boolean[all.length];
            isSkipped = new boolean[all.length];
            for (Material m : all) {
                if (m.isLegacy() || !m.isBlock()) continue;
                boolean water = m == Material.WATER || m == Material.ICE || m == Material.BUBBLE_COLUMN
                        || m == Material.SEAGRASS || m == Material.TALL_SEAGRASS || m == Material.KELP || m == Material.KELP_PLANT;
                boolean skip = water || m.isAir() || !m.isSolid() || m == Material.LAVA
                        || Tag.LEAVES.isTagged(m) || Tag.LOGS.isTagged(m)
                        || m == Material.MUSHROOM_STEM || m == Material.RED_MUSHROOM_BLOCK || m == Material.BROWN_MUSHROOM_BLOCK
                        || m == Material.BAMBOO || m == Material.CACTUS || m == Material.PUMPKIN || m == Material.MELON
                        || m == Material.BEE_NEST || m == Material.COCOA || m == Material.VINE;
                isWater[m.ordinal()] = water;
                isSkipped[m.ordinal()] = skip;
            }
            // Blocks a data pack uses for decoration (glowing blocks in tree tops, crystal pillars, ...)
            // would otherwise be taken for terrain. The job can list them.
            if (j.has("notGround")) {
                for (JsonElement el : j.getAsJsonArray("notGround")) {
                    Material m = Material.matchMaterial(el.getAsString());
                    if (m == null || !m.isBlock()) throw new IllegalArgumentException("notGround: no such block: " + el.getAsString());
                    isSkipped[m.ordinal()] = true;
                }
            }
        }

        void start() {
            startedAt = System.currentTimeMillis();
            getLogger().info("job: " + size + "x" + size + " from (" + x0 + ", " + z0 + "), export=" + export
                    + ", sections=" + sections.size());
            if (useChunky && Bukkit.getPluginManager().isPluginEnabled("Chunky")) {
                chunkyUsed = true;
                runChunky();
            } else {
                startChunkPass();
            }
        }

        // ---- step 1 (optional): let Chunky generate the area ----

        /**
         * Starts a Chunky task and waits until every chunk of the area exists. This does not depend on
         * Chunky's messages: it polls isChunkGenerated. If Chunky makes no progress for a while, the
         * chunk pass below generates whatever is missing, so the result is the same either way.
         */
        void runChunky() {
            ConsoleCommandSender console = Bukkit.getConsoleSender();
            int radius = size / 2 + 16;
            Bukkit.dispatchCommand(console, "chunky world " + world.getName());
            Bukkit.dispatchCommand(console, "chunky shape square");
            Bukkit.dispatchCommand(console, "chunky center " + (x0 + size / 2) + " " + (z0 + size / 2));
            Bukkit.dispatchCommand(console, "chunky radius " + radius);
            Bukkit.dispatchCommand(console, "chunky start");
            final int[] last = {-1};
            final long[] lastChange = {System.currentTimeMillis()};
            final int cx0 = x0 >> 4, cz0 = z0 >> 4, cx1 = (x0 + size - 1) >> 4, cz1 = (z0 + size - 1) >> 4;
            final int all = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
            Bukkit.getScheduler().runTaskTimer(WgExport.this, task -> {
                int have = 0;
                for (int cz = cz0; cz <= cz1; cz++)
                    for (int cx = cx0; cx <= cx1; cx++)
                        if (world.isChunkGenerated(cx, cz)) have++;
                long now = System.currentTimeMillis();
                if (have != last[0]) { last[0] = have; lastChange[0] = now; }
                getLogger().info("Chunky: " + have + "/" + all + " chunks");
                boolean stuck = now - lastChange[0] > 60_000;
                if (have >= all || stuck) {
                    task.cancel();
                    if (stuck) {
                        getLogger().warning("Chunky made no progress for 60s; generating the rest directly");
                        Bukkit.dispatchCommand(console, "chunky cancel");
                        Bukkit.dispatchCommand(console, "chunky confirm");
                    }
                    startChunkPass();
                }
            }, 100L, 100L);
        }

        // ---- step 2: load (and generate if needed) every chunk, reading it as it arrives ----

        void startChunkPass() {
            if (export) {
                int n = size * size;
                groundY = new short[n];
                waterY = new short[n];
                topBlock = new short[n];
                groundBlock = new short[n];
                biome = new short[n];
                for (Section s : sections) s.data = new short[size * height];
            }
            int cx0 = x0 >> 4, cz0 = z0 >> 4, cx1 = (x0 + size - 1) >> 4, cz1 = (z0 + size - 1) >> 4;
            for (int cz = cz0; cz <= cz1; cz++)
                for (int cx = cx0; cx <= cx1; cx++) pending.add(new long[] {cx, cz});
            total = pending.size();
            Bukkit.getScheduler().runTaskTimer(WgExport.this, task -> {
                if (finished) { task.cancel(); return; }
                pump();
                long now = System.currentTimeMillis();
                if (now - lastLog > 5000) {
                    lastLog = now;
                    getLogger().info("chunks: " + done + "/" + total);
                }
            }, 1L, 1L);
        }

        void pump() {
            while (inFlight < MAX_IN_FLIGHT && !pending.isEmpty()) {
                long[] c = pending.poll();
                inFlight++;
                world.getChunkAtAsync((int) c[0], (int) c[1], true).whenComplete((chunk, err) -> {
                    // Paper completes this future on the main thread.
                    inFlight--;
                    if (finished) return;
                    try {
                        if (err != null) throw err;
                        if (chunk == null) throw new IllegalStateException("chunk " + c[0] + "," + c[1] + " did not load");
                        if (export) readChunk(chunk);
                        done++;
                        if (done == total) finish();
                    } catch (Throwable t) {
                        finished = true;
                        fail(Job.this, t);
                    }
                });
            }
        }

        int blockId(Material m) {
            Integer i = blockIndex.get(m);
            if (i == null) {
                i = blockList.size();
                blockList.add(m);
                blockIndex.put(m, i);
            }
            return i;
        }

        void readChunk(Chunk chunk) {
            ChunkSnapshot snap = chunk.getChunkSnapshot(false, false, false);
            int baseX = chunk.getX() << 4, baseZ = chunk.getZ() << 4;
            for (int lz = 0; lz < 16; lz++) {
                int wz = baseZ + lz;
                if (wz < z0 || wz >= z0 + size) continue;
                for (int lx = 0; lx < 16; lx++) {
                    int wx = baseX + lx;
                    if (wx < x0 || wx >= x0 + size) continue;
                    int col = (wz - z0) * size + (wx - x0);

                    int top = world.getHighestBlockYAt(wx, wz, HeightMap.WORLD_SURFACE);
                    if (top < minY) top = minY;
                    Material topMat = snap.getBlockType(lx, top, lz);
                    int water = NO_WATER;
                    int y = top;
                    Material m = topMat;
                    while (y > minY && isSkipped[m.ordinal()]) {
                        if (water == NO_WATER && isWater[m.ordinal()]) water = y;
                        y--;
                        m = snap.getBlockType(lx, y, lz);
                    }
                    groundY[col] = (short) y;
                    waterY[col] = (short) water;
                    topBlock[col] = (short) blockId(topMat);
                    groundBlock[col] = (short) blockId(m);

                    // The Bukkit Biome enum only says CUSTOM for data pack biomes; this gives the real id.
                    NamespacedKey key = Bukkit.getUnsafe().getBiomeKey(world, wx, Math.max(y, water), wz);
                    String name = key.toString();
                    Integer bi = biomeIndex.get(name);
                    if (bi == null) {
                        bi = biomeList.size();
                        biomeList.add(name);
                        biomeIndex.put(name, bi);
                    }
                    biome[col] = (short) (int) bi;

                    for (Section s : sections) {
                        if ((s.alongX ? wz : wx) != s.at) continue;
                        int along = s.alongX ? wx - x0 : wz - z0;
                        int off = along * height;
                        for (int yy = minY; yy < maxY; yy++)
                            s.data[off + (yy - minY)] = (short) blockId(snap.getBlockType(lx, yy, lz));
                    }
                }
            }
        }

        // ---- step 3: write the files ----

        /**
         * Chunks arrive in a different order on every run, so the indexes handed out while reading are
         * not stable. Renumber blocks and biomes by name so the same world always gives the same bytes.
         */
        void sortPalettes() {
            List<Material> sortedBlocks = new ArrayList<>(blockList);
            sortedBlocks.sort((a, b) -> a.getKey().toString().compareTo(b.getKey().toString()));
            short[] blockMap = new short[blockList.size()];
            for (int i = 0; i < sortedBlocks.size(); i++) blockMap[blockIndex.get(sortedBlocks.get(i))] = (short) i;
            List<String> sortedBiomes = new ArrayList<>(biomeList);
            java.util.Collections.sort(sortedBiomes);
            short[] biomeMap = new short[biomeList.size()];
            for (int i = 0; i < sortedBiomes.size(); i++) biomeMap[biomeIndex.get(sortedBiomes.get(i))] = (short) i;
            for (int i = 0; i < topBlock.length; i++) {
                topBlock[i] = blockMap[topBlock[i] & 0xffff];
                groundBlock[i] = blockMap[groundBlock[i] & 0xffff];
                biome[i] = biomeMap[biome[i] & 0xffff];
            }
            for (Section s : sections)
                for (int i = 0; i < s.data.length; i++) s.data[i] = blockMap[s.data[i] & 0xffff];
            blockList.clear();
            blockList.addAll(sortedBlocks);
            biomeList.clear();
            biomeList.addAll(sortedBiomes);
        }

        void finish() {
            finished = true;
            generatedAt = System.currentTimeMillis();
            getLogger().info("all " + total + " chunks ready in " + (generatedAt - startedAt) + " ms");
            if (!export) {
                running = false;
                getLogger().info("WgExport: area generated (no export requested)");
                if (stopWhenDone) Bukkit.shutdown();
                return;
            }
            sortPalettes();
            // Map colors need the main thread; the file writing does not.
            JsonArray blocks = new JsonArray();
            for (Material mat : blockList) {
                JsonObject b = new JsonObject();
                b.addProperty("id", mat.getKey().toString());
                String color = null;
                try {
                    Color c = mat.createBlockData().getMapColor();
                    if (c.getRed() + c.getGreen() + c.getBlue() > 0 || !mat.isAir())
                        color = String.format("#%02x%02x%02x", c.getRed(), c.getGreen(), c.getBlue());
                } catch (Throwable ignored) {
                    // leave the color out; the renderer has its own table
                }
                if (color != null) b.addProperty("color", color);
                blocks.add(b);
            }
            JsonArray biomes = new JsonArray();
            for (String b : biomeList) biomes.add(b);
            JsonObject palette = new JsonObject();
            palette.add("blocks", blocks);
            palette.add("biomes", biomes);

            JsonObject meta = new JsonObject();
            meta.addProperty("seed", String.valueOf(world.getSeed()));
            meta.addProperty("size", size);
            meta.addProperty("x0", x0);
            meta.addProperty("z0", z0);
            meta.addProperty("minY", minY);
            meta.addProperty("maxY", maxY);
            meta.addProperty("seaLevel", world.getSeaLevel());
            meta.addProperty("minecraft", Bukkit.getMinecraftVersion());
            meta.addProperty("server", Bukkit.getVersion());
            meta.addProperty("chunks", total);
            meta.addProperty("chunky", chunkyUsed);
            meta.addProperty("generateMs", generatedAt - startedAt);
            JsonArray packs = new JsonArray();
            Bukkit.getDatapackManager().getEnabledPacks().forEach(p -> packs.add(p.getName()));
            meta.add("datapacks", packs);
            JsonArray secs = new JsonArray();
            for (Section s : sections) {
                JsonObject o = new JsonObject();
                o.addProperty("name", s.name);
                o.addProperty("axis", s.alongX ? "x" : "z");
                o.addProperty("at", s.at);
                secs.add(o);
            }
            meta.add("sections", secs);

            Bukkit.getScheduler().runTaskAsynchronously(WgExport.this, () -> {
                try {
                    writeFiles(palette, meta);
                    Bukkit.getScheduler().runTask(WgExport.this, () -> {
                        running = false;
                        getLogger().info("WgExport: done, wrote " + outDir.getPath());
                        if (stopWhenDone) Bukkit.shutdown();
                    });
                } catch (Throwable t) {
                    Bukkit.getScheduler().runTask(WgExport.this, () -> fail(Job.this, t));
                }
            });
        }

        void writeFiles(JsonObject palette, JsonObject meta) throws IOException {
            Gson gson = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
            File secDir = new File(outDir, "sections");
            secDir.mkdirs();
            new File(outDir, "done.json").delete();
            new File(outDir, "error.json").delete();

            int n = size * size;
            ByteBuffer buf = ByteBuffer.allocate(n * 10).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < n; i++) {
                buf.putShort(groundY[i]).putShort(waterY[i]).putShort(topBlock[i]).putShort(groundBlock[i]).putShort(biome[i]);
            }
            try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(new File(outDir, "columns.bin").toPath()))) {
                out.write(buf.array());
            }
            for (Section s : sections) {
                ByteBuffer sb = ByteBuffer.allocate(s.data.length * 2).order(ByteOrder.LITTLE_ENDIAN);
                for (short v : s.data) sb.putShort(v);
                try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(new File(secDir, s.name + ".bin").toPath()))) {
                    out.write(sb.array());
                }
            }
            meta.addProperty("exportMs", System.currentTimeMillis() - generatedAt);
            Files.writeString(new File(outDir, "palette.json").toPath(), gson.toJson(palette), StandardCharsets.UTF_8);
            Files.writeString(new File(outDir, "meta.json").toPath(), gson.toJson(meta), StandardCharsets.UTF_8);
            // Written last: its presence means everything above is complete.
            JsonObject doneJson = new JsonObject();
            doneJson.addProperty("columns", n);
            doneJson.addProperty("bytes", (long) n * 10);
            doneJson.addProperty("sections", sections.size());
            Files.writeString(new File(outDir, "done.json").toPath(), gson.toJson(doneJson), StandardCharsets.UTF_8);
        }
    }
}

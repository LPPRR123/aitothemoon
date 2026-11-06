package dev.aitothemoon.testmenus;

import java.util.List;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Villager;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

/** Test-only plugin: a two-level chest menu opened by /menu or by right-clicking a tagged NPC. */
public final class TestMenus extends JavaPlugin implements Listener {
    private static final String NPC_TAG = "testmenus_npc";

    /** Marks inventories created by this plugin so clicks can be cancelled. */
    static final class MenuHolder implements InventoryHolder {
        final String id;
        Inventory inv;
        MenuHolder(String id) { this.id = id; }
        @Override public Inventory getInventory() { return inv; }
    }

    @Override public void onEnable() {
        getServer().getPluginManager().registerEvents(this, this);
    }

    private static ItemStack item(Material m, String name, String... lore) {
        ItemStack s = new ItemStack(m);
        ItemMeta meta = s.getItemMeta();
        meta.setDisplayName(name);
        meta.setLore(List.of(lore));
        s.setItemMeta(meta);
        return s;
    }

    private void openMain(Player p) {
        MenuHolder h = new MenuHolder("main");
        Inventory inv = getServer().createInventory(h, 27, "§8服务器菜单");
        h.inv = inv;
        inv.setItem(11, item(Material.GRASS_BLOCK, "§a生存服", "§7点击进入生存服"));
        inv.setItem(13, item(Material.EMERALD, "§b商店", "§7打开商店"));
        inv.setItem(15, item(Material.BARRIER, "§c关闭菜单"));
        p.openInventory(inv);
    }

    private void openShop(Player p) {
        MenuHolder h = new MenuHolder("shop");
        Inventory inv = getServer().createInventory(h, 27, "§8商店");
        h.inv = inv;
        inv.setItem(10, item(Material.BREAD, "§e面包 x5", "§7价格: 免费", "§7点击购买"));
        inv.setItem(12, item(Material.OAK_LOG, "§e橡木原木 x8", "§7价格: 免费", "§7点击购买"));
        inv.setItem(26, item(Material.ARROW, "§7返回"));
        p.openInventory(inv);
    }

    @Override public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (cmd.getName().equalsIgnoreCase("menu")) {
            if (sender instanceof Player p) openMain(p);
            return true;
        }
        if (cmd.getName().equalsIgnoreCase("spawnnpc")) {
            if (!(sender instanceof Player p)) return true;
            String name = args.length > 0 ? String.join(" ", args) : "菜单NPC";
            Location loc = p.getLocation().add(p.getLocation().getDirection().setY(0).normalize().multiply(3));
            Villager v = p.getWorld().spawn(loc, Villager.class);
            v.setCustomName(name);
            v.setCustomNameVisible(true);
            v.setAI(false);
            v.setInvulnerable(true);
            v.setSilent(true);
            v.addScoreboardTag(NPC_TAG);
            p.sendMessage("§a[TestMenus] 已生成 NPC: " + name);
            return true;
        }
        return false;
    }

    @EventHandler public void onNpcClick(PlayerInteractEntityEvent e) {
        Entity ent = e.getRightClicked();
        if (!ent.getScoreboardTags().contains(NPC_TAG)) return;
        e.setCancelled(true);
        openMain(e.getPlayer());
    }

    @EventHandler public void onDrag(InventoryDragEvent e) {
        if (e.getInventory().getHolder() instanceof MenuHolder) e.setCancelled(true);
    }

    @EventHandler public void onClick(InventoryClickEvent e) {
        if (!(e.getInventory().getHolder() instanceof MenuHolder h)) return;
        e.setCancelled(true);
        if (!(e.getWhoClicked() instanceof Player p)) return;
        if (e.getClickedInventory() == null || e.getClickedInventory() != e.getInventory()) return;
        int slot = e.getRawSlot();
        if (h.id.equals("main")) {
            if (slot == 11) {
                p.closeInventory();
                p.sendMessage("§a[服务器] 你已进入生存服！");
            } else if (slot == 13) {
                getServer().getScheduler().runTask(this, () -> openShop(p));
            } else if (slot == 15) {
                p.closeInventory();
            }
        } else if (h.id.equals("shop")) {
            if (slot == 10) {
                p.getInventory().addItem(new ItemStack(Material.BREAD, 5));
                p.sendMessage("§e[商店] 购买成功: 面包 x5");
            } else if (slot == 12) {
                p.getInventory().addItem(new ItemStack(Material.OAK_LOG, 8));
                p.sendMessage("§e[商店] 购买成功: 橡木原木 x8");
            } else if (slot == 26) {
                getServer().getScheduler().runTask(this, () -> openMain(p));
            }
        }
    }
}

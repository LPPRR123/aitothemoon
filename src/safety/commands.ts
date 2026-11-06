/**
 * Decides whether the AI may run a server command.
 *
 * - Commands on the deny list are never run.
 * - Commands on the allow list run freely.
 * - Anything else runs only if the owner typed that exact command (e.g. "帮我执行 /warp pvp")
 *   in a message during the current task. The model cannot approve its own commands, so text
 *   hidden in menus, signs or other players' chat cannot make the bot run something new.
 */
export interface CommandPolicy {
  allow: string[];
  deny: string[];
}

export type CommandDecision =
  | { ok: true; command: string }
  | { ok: false; command: string; reason: string };

/** Commands that are dangerous on almost every server. Always denied, on top of the config. */
export const BUILTIN_DENY = [
  "op", "deop", "stop", "restart", "reload", "rl", "ban", "ban-ip", "pardon", "kick",
  "whitelist", "gamemode", "gm", "give", "pay", "eco", "sudo", "lp", "luckperms", "pex",
  "plugins", "pl", "execute", "unregister", "changepassword", "changepw", "logout",
];

export function normalizeCommand(input: string): string {
  return input.trim().replace(/^\/+/, "").replace(/\s+/g, " ");
}

/** First word of a command, lowercase, without plugin namespace ("essentials:home" -> "home"). */
export function commandName(command: string): string {
  const first = normalizeCommand(command).split(" ")[0] ?? "";
  const bare = first.includes(":") ? first.slice(first.indexOf(":") + 1) : first;
  return bare.toLowerCase();
}

/** Names of all "/command" mentions in the given messages. */
export function commandsMentioned(messages: string[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    // A slash not preceded by a letter/digit/URL character, followed by an ASCII command name.
    for (const match of m.matchAll(/(?<![A-Za-z0-9/:.])\/([A-Za-z][\w:-]*)/g)) {
      if (match[1]) names.add(commandName(match[1]));
    }
  }
  return names;
}

export function checkCommand(input: string, policy: CommandPolicy, ownerMessages: string[]): CommandDecision {
  const command = normalizeCommand(input);
  const name = commandName(command);
  if (!name) return { ok: false, command, reason: "指令为空" };
  const deny = new Set([...BUILTIN_DENY, ...policy.deny.map((c) => c.toLowerCase())]);
  if (deny.has(name)) {
    return { ok: false, command, reason: `/${name} 在禁止列表里，AI 不能执行。需要的话请主人自己输入。` };
  }
  const allow = new Set(policy.allow.map((c) => c.toLowerCase()));
  if (allow.has(name)) return { ok: true, command };
  if (commandsMentioned(ownerMessages).has(name)) return { ok: true, command };
  return {
    ok: false,
    command,
    reason: `/${name} 不在允许列表里。请让主人在聊天里直接打出这条指令（例如"执行 /${command}"），或者把 ${name} 加进 config.yaml 的 commands.allow。`,
  };
}

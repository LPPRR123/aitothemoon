import { z } from "zod";
import { ActionError, defineAction } from "./types.js";

export const chat = defineAction({
  name: "chat",
  description: "在公屏聊天里说一句话（所有人都能看到）。用于做事途中给主人报告进度。不要用它发指令。",
  risk: "low",
  schema: z.object({ message: z.string().min(1).max(200) }),
  async run(ctx, { message }) {
    if (message.trim().startsWith("/")) throw new ActionError("chat 不能发指令，请用 run_command");
    if (!ctx.sender.say(message)) throw new ActionError("聊天发送太频繁，消息被丢弃了");
    return "已发送";
  },
});

export const whisper = defineAction({
  name: "whisper",
  description: "私聊某个玩家（/msg）。",
  risk: "low",
  schema: z.object({ player: z.string(), message: z.string().min(1).max(200) }),
  async run(ctx, { player, message }) {
    if (!/^\w{1,16}$/.test(player)) throw new ActionError("玩家名不合法");
    if (!ctx.sender.say(`/msg ${player} ${message.replace(/\s+/g, " ")}`)) {
      throw new ActionError("聊天发送太频繁，消息被丢弃了");
    }
    return "已发送";
  },
});

export const chatActions = [chat, whisper];

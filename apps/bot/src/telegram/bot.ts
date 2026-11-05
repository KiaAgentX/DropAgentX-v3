/**
 * grammY glue — maps Telegram updates to orchestrator calls and replies.
 * Deliberately thin: NO business logic here. Runs offline in tests via
 * bot.handleUpdate + a stubbed API transformer.
 */

import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Orchestrator, BotActor, BotOutcome } from '../core/orchestrator.js';

export interface TelegramGlueOptions {
  readonly botToken: string;
  readonly adminChatId?: string;
  /** Offline construction (tests) — skips the getMe network round-trip. */
  readonly botInfo?: UserFromGetMe;
}

function actorFrom(ctx: Context, adminChatId?: string): BotActor | null {
  const from = ctx.from;
  const chat = ctx.chat;
  if (from === undefined || chat === undefined) return null;
  return {
    telegramId: String(from.id),
    ...(from.username !== undefined && from.username.length > 0 ? { username: from.username } : {}),
    chatId: String(chat.id),
    isAdmin: adminChatId !== undefined && String(chat.id) === adminChatId,
  };
}

function markupFor(outcome: BotOutcome): { reply_markup?: InlineKeyboard } | undefined {
  const kb = outcome.reply.keyboard;
  if (kb === undefined || kb.length === 0) return undefined;
  const ik = new InlineKeyboard();
  for (const [rowIndex, row] of kb.entries()) {
    for (const button of row) {
      ik.text(button.text, button.callbackData);
    }
    if (rowIndex < kb.length - 1) ik.row();
  }
  return { reply_markup: ik };
}

/** Fire-and-forget side-channel deliveries — never break the main reply path. */
async function deliverSideChannel(
  bot: Bot,
  outcome: BotOutcome,
  adminChatId: string | undefined,
): Promise<void> {
  try {
    if (outcome.notifyAdmin !== undefined && adminChatId !== undefined) {
      const markup = markupFor({ reply: outcome.notifyAdmin });
      await bot.api.sendMessage(adminChatId, outcome.notifyAdmin.text, markup);
    }
    if (outcome.notifyRequester !== undefined) {
      await bot.api.sendMessage(outcome.notifyRequester.telegramId, outcome.notifyRequester.text);
    }
  } catch {
    // A failed notification must never wedge the conversation; the queue on
    // the server remains the source of truth and /pending recovers it.
  }
}

export function createTelegramBot(
  glue: TelegramGlueOptions,
  orchestrator: Orchestrator,
): Bot {
  const bot = new Bot(glue.botToken, glue.botInfo !== undefined ? { botInfo: glue.botInfo } : undefined);

  bot.on('message:text', async (ctx) => {
    const actor = actorFrom(ctx, glue.adminChatId);
    if (actor === null) return;
    const messageId = ctx.message?.message_id ?? 0;
    const outcome = await orchestrator.handle(actor, {
      text: ctx.message.text,
      commandId: `${ctx.chat.id}:${messageId}`,
    });
    await ctx.api.sendMessage(ctx.chat.id, outcome.reply.text, markupFor(outcome));
    await deliverSideChannel(bot, outcome, glue.adminChatId);
  });

  bot.on('callback_query:data', async (ctx) => {
    const actor = actorFrom(ctx, glue.adminChatId);
    const chat = ctx.chat;
    if (actor === null || chat === undefined) return;
    const outcome = await orchestrator.handleCallback(actor, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.api.sendMessage(chat.id, outcome.reply.text, markupFor(outcome));
    await deliverSideChannel(bot, outcome, glue.adminChatId);
  });

  return bot;
}

export { deliverSideChannel };

import { getDb, mutate, newId, nowIso } from "../db";
import type { DB } from "../types";

const MAX_CHATS = 50;
const MAX_MESSAGES = 200;

export const chatsOf = (db: DB) => (db.chats ??= []);

/** The person's conversations, newest first, without their messages. */
export function listChats(userId: string) {
  return chatsOf(getDb())
    .filter((c) => c.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }));
}

/** One conversation, only if it belongs to this person. */
export const getChat = (userId: string, id: string) => chatsOf(getDb()).find((c) => c.id === id && c.userId === userId);

const titleOf = (q: string) => {
  const t = q.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t;
};

/** Add a question and its answer to a conversation (starting one if needed); returns its id. */
export function saveTurn(userId: string, chatId: string | undefined, question: string, answer: { text: string; reply: unknown }) {
  return mutate((db) => {
    const chats = chatsOf(db);
    let chat = chatId ? chats.find((c) => c.id === chatId && c.userId === userId) : undefined;
    const now = nowIso();
    if (!chat) {
      chat = { id: newId("chat"), userId, title: titleOf(question), createdAt: now, updatedAt: now, messages: [] };
      chats.push(chat);
      // Keep each person's newest conversations only.
      const mine = chats.filter((c) => c.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const old of mine.slice(MAX_CHATS)) chats.splice(chats.indexOf(old), 1);
    }
    chat.messages.push({ role: "user", text: question, ts: now }, { role: "assistant", text: answer.text, ts: now, reply: answer.reply });
    if (chat.messages.length > MAX_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
    chat.updatedAt = now;
    return chat.id;
  });
}

export function renameChat(userId: string, id: string, title: string) {
  return mutate((db) => {
    const c = chatsOf(db).find((x) => x.id === id && x.userId === userId);
    if (!c) return false;
    c.title = titleOf(title) || c.title;
    return true;
  });
}

export function deleteChat(userId: string, id: string) {
  return mutate((db) => {
    const chats = chatsOf(db);
    const i = chats.findIndex((c) => c.id === id && c.userId === userId);
    if (i < 0) return false;
    chats.splice(i, 1);
    return true;
  });
}

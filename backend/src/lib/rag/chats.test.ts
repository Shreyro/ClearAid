import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-chats-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { deleteChat, getChat, listChats, renameChat, saveTurn } = await import("./chats");

test("a conversation grows turn by turn and is titled from the first question", () => {
  const id = saveTurn("u1", undefined, "Where did the cyclone money go?", { text: "Mostly shelter.", reply: null });
  saveTurn("u1", id, "and who got the most?", { text: "The tarpaulin supplier.", reply: null });
  const c = getChat("u1", id)!;
  assert.equal(c.title, "Where did the cyclone money go?");
  assert.deepEqual(c.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(listChats("u1")[0].count, 4);
});

test("nobody else can see, extend, rename or delete it", () => {
  const id = listChats("u1")[0].id;
  assert.equal(getChat("u2", id), undefined);
  assert.deepEqual(listChats("u2"), []);
  assert.equal(renameChat("u2", id, "mine now"), false);
  assert.equal(deleteChat("u2", id), false);
  // Passing someone else's chat id starts a fresh chat for the caller instead of writing into it.
  const other = saveTurn("u2", id, "hello", { text: "hi", reply: null });
  assert.notEqual(other, id);
  assert.equal(getChat("u1", id)!.messages.length, 4);
});

test("only the newest 50 conversations are kept", () => {
  for (let i = 0; i < 55; i++) saveTurn("u3", undefined, `question ${i}`, { text: "a", reply: null });
  assert.equal(listChats("u3").length, 50);
});

test("the owner can rename and delete", () => {
  const id = listChats("u1")[0].id;
  assert.equal(renameChat("u1", id, "Cyclone spending"), true);
  assert.equal(getChat("u1", id)!.title, "Cyclone spending");
  assert.equal(deleteChat("u1", id), true);
  assert.equal(getChat("u1", id), undefined);
});

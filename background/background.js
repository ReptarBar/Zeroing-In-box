/*
 * Inbox Laser (MVP)
 * - Reads last N messages from Unified Inbox
 * - Stores staged-for-trash list in storage.local
 * - On confirm, moves to Trash (via messages.delete deletePermanently:false)
 */

const GAME_URL = "src/ui/game.html";
const DEFAULT_WAVE_SIZE = 30;
const STAGING_KEY = "inboxLaserStaging";

/** @typedef {{ id:number, author:string, subject:string, date:number, folderId:string }} ShipMessage */

async function openGameWindow() {
  await browser.windows.create({
    url: GAME_URL,
    type: "popup",
    width: 820,
    height: 660
  });
}

async function getUnifiedInboxFolder() {
  // TB 127+ provides unified mailbox folders.
  try {
    return await browser.folders.getUnifiedFolder("inbox");
  } catch (err) {
    // Fallback: first account's inbox.
    const accounts = await browser.accounts.list();
    for (const acct of accounts) {
      const inbox = (acct.folders || []).find(f => f.type === "inbox");
      if (inbox) return inbox;
    }
    throw new Error("Could not locate an Inbox folder.");
  }
}

async function loadWave1({ folderId } = {}) {
  const folder = folderId
    ? await browser.folders.get(folderId, false).catch(() => null)
    : await getUnifiedInboxFolder();

  const effectiveFolderId = folder?.id;
  if (!effectiveFolderId) {
    throw new Error("No folderId available for message query.");
  }

  // IMPORTANT: The messages.* APIs do not expose a server-side sort option for
  // messages.query()/list(). To reliably approximate "newest N" without paging
  // through an entire Inbox, we progressively widen a fromDate window and fetch
  // *all* messages within that window, then pick the newest N.
  const msgs = await getNewestMessagesInFolder(effectiveFolderId, DEFAULT_WAVE_SIZE);

  /** @type {ShipMessage[]} */
  const mapped = msgs.slice(0, DEFAULT_WAVE_SIZE).map(m => ({
    id: m.id,
    author: m.author || "(unknown)",
    subject: m.subject || "(no subject)",
    date: m.date ? new Date(m.date).getTime() : 0,
    folderId: m.folder?.id || effectiveFolderId
  }));

  return { folderId: effectiveFolderId, messages: mapped };
}

/**
 * Fetch newest messages by progressively widening a time window.
 *
 * Why: messages.query() returns a paginated MessageList in an unspecified order.
 * In some profiles, the first page contains the oldest messages, which would
 * make a naive messagesPerPage=N request behave like "oldest N".
 *
 * Strategy: fetch *all* messages in a recent time window (few days), then sort
 * locally. If the window does not contain enough messages, widen it.
 *
 * This is intentionally conservative to avoid iterating entire huge Inboxes.
 *
 * @param {string} folderId
 * @param {number} limit
 */
async function getNewestMessagesInFolder(folderId, limit) {
  const day = 24 * 60 * 60 * 1000;
  const windows = [3, 7, 14, 30, 90, 365];

  for (const days of windows) {
    const fromDate = new Date(Date.now() - days * day);
    const all = await collectAllMessages(
      browser.messages.query({
        folderId,
        fromDate,
        // Small pages return faster (autoPaginationTimeout makes this even more
        // responsive for large folders).
        messagesPerPage: 200,
        autoPaginationTimeout: 250
      })
    );

    if (all.length >= limit || days === windows[windows.length - 1]) {
      all.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      });
      return all.slice(0, limit);
    }
  }

  return [];
}

/**
 * Collect all pages from a MessageList promise.
 * @param {Promise<any>} listPromise
 */
async function collectAllMessages(listPromise) {
  /** @type {any[]} */
  const out = [];
  let page = await listPromise;
  if (Array.isArray(page?.messages)) out.push(...page.messages);
  while (page?.id) {
    page = await browser.messages.continueList(page.id);
    if (Array.isArray(page?.messages)) out.push(...page.messages);
  }
  return out;
}

async function getStaging() {
  const { [STAGING_KEY]: value } = await browser.storage.local.get(STAGING_KEY);
  return value && typeof value === "object" ? value : { byFolder: {} };
}

async function setStaging(next) {
  await browser.storage.local.set({ [STAGING_KEY]: next });
}

async function stageSet({ folderId, message, staged }) {
  const staging = await getStaging();
  staging.byFolder ||= {};
  staging.byFolder[folderId] ||= { ids: [], meta: {} };

  const bucket = staging.byFolder[folderId];
  const id = message.id;

  const has = bucket.ids.includes(id);
  if (staged && !has) bucket.ids.push(id);
  if (!staged && has) bucket.ids = bucket.ids.filter(x => x !== id);

  if (staged) {
    bucket.meta[id] = message;
  } else {
    delete bucket.meta[id];
  }

  await setStaging(staging);
  return { ok: true, ids: bucket.ids.slice() };
}

async function stageGet({ folderId }) {
  const staging = await getStaging();
  const bucket = staging.byFolder?.[folderId] || { ids: [], meta: {} };

  const items = bucket.ids
    .map(id => bucket.meta[id])
    .filter(Boolean)
    .sort((a, b) => (b.date || 0) - (a.date || 0));

  return { ok: true, folderId, items };
}

async function stageClear({ folderId }) {
  const staging = await getStaging();
  if (staging.byFolder?.[folderId]) {
    staging.byFolder[folderId] = { ids: [], meta: {} };
    await setStaging(staging);
  }
  return { ok: true };
}

async function moveToTrashViaDelete(messageIds) {
  // deletePermanently:false should move to trash / obey account deletion model.
  // isUserAction enables undo in newer TB versions.
  await browser.messages.delete(messageIds, {
    deletePermanently: false,
    isUserAction: true
  });
}

async function moveToTrashViaMove(messageIds) {
  const trash = await browser.folders.getUnifiedFolder("trash");
  await browser.messages.move(messageIds, trash.id, { isUserAction: true });
}

async function trashStaged({ folderId }) {
  const staging = await getStaging();
  const bucket = staging.byFolder?.[folderId];
  const ids = bucket?.ids || [];

  if (!ids.length) {
    return { ok: true, trashed: [], failed: [] };
  }

  const failed = [];
  const trashed = [];

  // Do in chunks to avoid large operations.
  const chunks = chunk(ids, 100);
  for (const chunkIds of chunks) {
    try {
      await moveToTrashViaDelete(chunkIds);
      trashed.push(...chunkIds);
    } catch (err) {
      // Fallback to explicit move.
      try {
        await moveToTrashViaMove(chunkIds);
        trashed.push(...chunkIds);
      } catch (err2) {
        failed.push(...chunkIds.map(id => ({ id, error: String(err2?.message || err2) })));
      }
    }
  }

  // Remove successfully trashed from staging.
  if (bucket) {
    bucket.ids = bucket.ids.filter(id => !trashed.includes(id));
    for (const id of trashed) delete bucket.meta[id];
    await setStaging(staging);
  }

  return { ok: failed.length === 0, trashed, failed };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

browser.action.onClicked.addListener(() => {
  openGameWindow().catch(console.error);
});

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "inboxLaser:getWave1":
      return loadWave1(msg.payload);
    case "inboxLaser:stageSet":
      return stageSet(msg.payload);
    case "inboxLaser:stageGet":
      return stageGet(msg.payload);
    case "inboxLaser:stageClear":
      return stageClear(msg.payload);
    case "inboxLaser:trashStaged":
      return trashStaged(msg.payload);
    default:
      return;
  }
});

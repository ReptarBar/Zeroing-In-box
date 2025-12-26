/*
 * Inbox Laser (MVP)
 * - Reads last N messages from Unified Inbox
 * - Stores staged-for-trash list in storage.local
 * - On confirm, moves to Trash (via messages.delete deletePermanently:false)
 */

const GAME_URL = "src/ui/game.html";
const DEFAULT_WAVE_SIZE = 30;
const STAGING_KEY = "inboxLaserStaging";
const TRASH_CACHE = new Map();
let unifiedTrash = null;

const TO_DELETE_TAG_KEY = "To-Delete";
const TO_DELETE_TAG_LABEL = "To-Delete";
const TO_DELETE_TAG_COLOR = "#e34d55";
let toDeleteTagReady = false;

async function listTags() {
  try {
    // Thunderbird 128+ namespace for tag helpers.
    return await browser.messages.tags.list();
  } catch (_) {
    // Legacy fallback for environments that expose listTags at the root.
    try {
      return await browser.messages.listTags();
    } catch {
      return [];
    }
  }
}

async function createToDeleteTag() {
  // Prefer the namespaced tag API; fall back to legacy createTag signature.
  try {
    await browser.messages.tags.create({
      key: TO_DELETE_TAG_KEY,
      tag: TO_DELETE_TAG_LABEL,
      color: TO_DELETE_TAG_COLOR
    });
    return;
  } catch (_) {
    // Ignore and try legacy shape.
  }

  try {
    await browser.messages.createTag(TO_DELETE_TAG_KEY, TO_DELETE_TAG_LABEL, TO_DELETE_TAG_COLOR);
  } catch (_) {
    // Best-effort: failure is non-fatal; tagging will simply be skipped.
  }
}

async function ensureToDeleteTag() {
  if (toDeleteTagReady) return true;
  const tags = await listTags();
  const exists = tags?.some?.((t) => t?.key === TO_DELETE_TAG_KEY);
  if (exists) {
    toDeleteTagReady = true;
    return true;
  }

  await createToDeleteTag();
  const updated = await listTags();
  const created = updated?.some?.((t) => t?.key === TO_DELETE_TAG_KEY);
  toDeleteTagReady = !!created;
  return toDeleteTagReady;
}

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
  let newest = [];

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
      }),
      limit * 3
    );

    newest = all;

    if (all.length >= limit) break;
  }

  // Fallback: if our date-window strategy could not gather enough messages,
  // fetch a capped unfiltered list and sort locally. This avoids returning only
  // a handful of ships in profiles where fromDate filters are sparse.
  if (newest.length < limit) {
    newest = await collectAllMessages(
      browser.messages.query({
        folderId,
        messagesPerPage: 400,
        autoPaginationTimeout: 800
      }),
      limit * 4
    );
  }

  newest.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  return newest.slice(0, limit);
}

/**
 * Collect all pages from a MessageList promise.
 * @param {Promise<any>} listPromise
 * @param {number} cap
 */
async function collectAllMessages(listPromise, cap = Infinity) {
  /** @type {any[]} */
  const out = [];
  let page = await listPromise;
  if (Array.isArray(page?.messages)) out.push(...page.messages);
  while (page?.id && out.length < cap) {
    page = await browser.messages.continueList(page.id);
    if (Array.isArray(page?.messages)) out.push(...page.messages);
    else break;
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
  const trash = await getUnifiedTrash();
  if (!trash) throw new Error("Could not locate a Trash folder.");
  await browser.messages.move(messageIds, trash.id, { isUserAction: true });
}

async function tagMessagesForDeletion(messageIds) {
  const tagged = [];
  const failed = [];

  if (!messageIds?.length) return { tagged, failed };

  const ready = await ensureToDeleteTag().catch(() => false);
  if (!ready) return { tagged, failed };

  for (const id of messageIds) {
    try {
      await browser.messages.update(id, { addTags: [TO_DELETE_TAG_KEY] });
      tagged.push(id);
    } catch (err) {
      failed.push({ id, error: String(err?.message || err) });
    }
  }

  return { tagged, failed };
}

async function getUnifiedTrash() {
  if (unifiedTrash) return unifiedTrash;
  try {
    unifiedTrash = await browser.folders.getUnifiedFolder("trash");
    return unifiedTrash;
  } catch (_) {
    return null;
  }
}

function findFolderById(folders, id) {
  for (const f of folders || []) {
    if (f.id === id) return f;
    const nested = findFolderById(f.subFolders, id);
    if (nested) return nested;
  }
  return null;
}

function findFolderByType(folders, type) {
  for (const f of folders || []) {
    if (f.type === type) return f;
    const nested = findFolderByType(f.subFolders, type);
    if (nested) return nested;
  }
  return null;
}

async function resolveTrashForFolder(folderId) {
  if (TRASH_CACHE.has(folderId)) return TRASH_CACHE.get(folderId);

  const unified = await getUnifiedTrash();
  if (unified) {
    TRASH_CACHE.set(folderId, unified);
    return unified;
  }

  const folder = await browser.folders.get(folderId, false).catch(() => null);
  const accountId = folder?.accountId;
  const accounts = await browser.accounts.list();

  for (const acct of accounts) {
    if (accountId && acct.id !== accountId) continue;
    const belongs = accountId ? true : !!findFolderById(acct.folders, folderId);
    if (!belongs) continue;
    const trash = findFolderByType(acct.folders, "trash");
    if (trash) {
      TRASH_CACHE.set(folderId, trash);
      return trash;
    }
  }

  return null;
}

async function moveMessagesToResolvedTrash(messages) {
  const grouped = new Map();
  const failed = [];
  const moved = [];

  for (const msg of messages) {
    const dest = await resolveTrashForFolder(msg.folderId);
    if (!dest?.id) {
      failed.push({ id: msg.id, error: "No Trash folder available" });
      continue;
    }
    const bucket = grouped.get(dest.id) || { ids: [] };
    bucket.ids.push(msg.id);
    grouped.set(dest.id, bucket);
  }

  for (const [trashId, bucket] of grouped) {
    try {
      await browser.messages.move(bucket.ids, trashId, { isUserAction: true });
      moved.push(...bucket.ids);
    } catch (err) {
      failed.push(...bucket.ids.map(id => ({ id, error: String(err?.message || err) })));
    }
  }

  return { moved, failed };
}

async function trashStaged({ folderId }) {
  const staging = await getStaging();
  const bucket = staging.byFolder?.[folderId];
  const ids = bucket?.ids || [];
  const meta = bucket?.meta || {};

  if (!ids.length) {
    return { ok: true, trashed: [], failed: [] };
  }

  const failed = [];
  const trashed = [];
  const tagFailed = [];

  // Do in chunks to avoid large operations.
  const chunks = chunk(ids, 100);
  for (const chunkIds of chunks) {
    const chunkMessages = chunkIds.map(id => ({ id, folderId: meta[id]?.folderId || folderId }));

    const tagRes = await tagMessagesForDeletion(chunkIds);
    tagFailed.push(...(tagRes?.failed || []));

    try {
      await moveToTrashViaDelete(chunkIds);
      trashed.push(...chunkIds);
      continue;
    } catch (err) {
      // delete failed, fall through to move
    }

    try {
      const moveRes = await moveMessagesToResolvedTrash(chunkMessages);
      trashed.push(...moveRes.moved);
      failed.push(...moveRes.failed);
    } catch (err2) {
      failed.push(...chunkIds.map(id => ({ id, error: String(err2?.message || err2) })));
    }
  }

  // Remove successfully trashed from staging.
  if (bucket) {
    bucket.ids = bucket.ids.filter(id => !trashed.includes(id));
    for (const id of trashed) delete bucket.meta[id];
    await setStaging(staging);
  }

  failed.push(...tagFailed);

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

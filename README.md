# Inbox Laser (MVP)

A Thunderbird MailExtension that turns inbox cleanup into a tiny Space-Invaders style game.

**Safety first:** clicking ships only **stages** messages. Nothing is moved until you confirm **Send to the Scrap Yard**, and we prefer moving to **Trash** rather than permanent deletion.

## What you get in Wave 1

- Loads the latest **30** messages from the **Unified Inbox** (fallback: first account inbox).
- Renders each email as an "enemy ship" showing `From · Subject` (smartly truncated).
- Fleet moves: **left → down → right → down → repeat**.
- Click a ship to stage it:
  - laser animation
  - synth “pew” sound
  - boom particles
  - ship flips to "STAGED" styling
- Review screen:
  - see staged messages (subject, from, date)
  - remove individual items, or restore all
  - **Send to the Scrap Yard** (moves staged messages to Trash)

## Install (temporary load)

1. Open Thunderbird.
2. Go to **Tools → Add-ons and Themes**.
3. Click the gear icon, choose **Debug Add-ons** (or open `about:debugging` and select **This Thunderbird**).
4. Click **Load Temporary Add-on…**
5. Select the `manifest.json` inside the `inbox-laser-source.zip` (extract it first).

## Install (.xpi)

1. Download `inbox-laser.xpi`.
2. Thunderbird → **Tools → Add-ons and Themes**.
3. Gear icon → **Install Add-on From File…**
4. Select the `.xpi`.

> Note: If your Thunderbird requires signing, use temporary loading for development.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist the staged list (survives closing the window). |
| `accountsRead` | Find the Unified Inbox (TB 127+) and folder IDs. |
| `messagesRead` | Read message metadata for ships (from, subject, date). |
| `messagesMove` | Move to Trash (explicit move fallback) and enable trash-style deletion. |

## How staging works

- When you click a ship, we store that message ID + metadata in `storage.local` under `inboxLaserStaging`.
- Closing the game window does **not** delete anything.
- Clicking **Send to the Scrap Yard** attempts to move staged messages to Trash.
- If any messages fail to move, we keep them staged and show a summary.

## Dev notes

- No inline scripts (CSP-safe). All JS is in external files.
- Laser and explosion sounds are synthesized with WebAudio, so there are no audio assets.

## Next iterations (not in MVP)

- Folder selection (current folder, Inbox, per-account, etc.)
- Multiple waves / difficulty tuning
- Better ship sprites + sender avatars
- Keyboard controls + accessibility refinements
- Optional Experiment API for older Thunderbird versions

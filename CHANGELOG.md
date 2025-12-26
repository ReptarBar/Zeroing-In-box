# Changelog

## 0.1.0 - 2025-12-26

- MVP Wave 1: load 30 messages from Unified Inbox.
- Canvas Space-Invaders fleet with click-to-stage (laser + particles + synth sfx).
- Review modal with Restore All, remove individual, and confirm move-to-Trash.
- Background staging stored in `storage.local`.

## 0.1.1 - 2025-12-26

- Fix: load newest messages (progressive time-window query, then local sort) instead of accidentally pulling the oldest page on some profiles.
- Fix: review modal always closable (Escape key + z-index hardening + focus guard).

## 0.1.2 - 2025-12-26

- Fix: Scrap Yard Review overlay no longer "traps" input in some Thunderbird popup builds, forces `display:none` when closed and uses pointerdown + capture listeners for close actions.
- UX: added an explicit Close button in the review footer as a second escape hatch.

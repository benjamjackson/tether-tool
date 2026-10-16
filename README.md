# Tether Tool

An offline, subscription-free desktop app for on-set RAW ingestion. Files come off the
camera or card, get named from the location folder you're shooting into, are copied to
two drives and checksum-verified, and are ready to take into Bridge and Photoshop at the
end of the shoot.

No editing, no cloud, no accounts. The files, folders and `.xmp` sidecars on your drives
are the real record. The app's database is only a working index, so deleting the app
loses nothing.

## Run it (macOS)

You need [Node.js](https://nodejs.org) 22 or newer (the LTS installer is fine).

```sh
npm install
npm start
```

## How a shoot works

1. **New session**: enter client, job and date, list your locations (Main Salon, Lobby…),
   and choose three folders:
   - **Watched folder**: where RAWs arrive. This can be the camera card's `DCIM` folder,
     or the folder your tether software (EOS Utility, Sony Imaging Edge, etc.) saves into.
   - **Main destination** and **Backup**: two different drives. You can add more backups.
2. Click a location's dot in the right panel to make it the **capture location**. Every
   new frame is named into it, e.g. `2026-10-16_DunDiggin_MainSalon_0042.CR3` in
   `DunDiggin/MainSalon/`, on every drive.
3. The top bar shows the state of the shoot: green means every frame is on every drive,
   blue means copying, and red (pulsing) means something needs you, like a drive that's
   unplugged or a frame that failed to copy. **Retry failed copies** fixes them once
   the drive is back.
4. Review with the keyboard: **1–3** stars, **0** clears, **6–9** color labels
   (red, yellow, green, blue), **Enter** opens the large view, **C** shows clipping,
   **X** compares, **F** follows new frames as they arrive.

## What it guarantees

- The source file is never moved, renamed or deleted.
- Each copy is written under a temporary name, flushed to disk, and only gets its final
  name after its SHA-256 checksum matches the original.
- An existing file is never overwritten. A name clash shows up as an error.
- Frames already on a card are ingested in shooting order. Reopening a session never
  ingests the same file twice, and the counter carries on where it left off.

## Bridge

Stars and color labels are written to an `.xmp` sidecar next to each RAW on every
drive (`xmp:Rating` and `xmp:Label`), which Bridge and Camera Raw read directly.
Existing Camera Raw settings in a sidecar are kept.

Bridge stores a color label as its **name**, and only shows the color if that name
matches Bridge › Settings › Labels exactly. The defaults match Bridge's (Select, Second,
Approved, Review, To Do). If you've renamed yours in Bridge, enter the same names under
*Naming and Bridge labels* when you set up the session.

## Clipping checks

Previews, the histogram and the clipping overlay use the JPEG the camera embeds in each
RAW, so they're instant. That JPEG clips slightly before the RAW data, so a warning means
"check this frame" rather than "this is definitely blown."

## Development

```sh
npm test        # engine, naming and sidecar tests
npm run build   # bundle the interface into dist/
```

- `src/core/`: ingest engine, naming templates, `.xmp` sidecars, previews, database. Plain Node, tested.
- `src/main/`: Electron window and the bridge to the interface.
- `src/renderer/`: the React interface.

The database uses Node's built-in SQLite (`node:sqlite`) rather than `better-sqlite3`,
so there is no native module to rebuild for Electron.

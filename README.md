# Wrangle

_(Formerly Tether Tool.)_

An offline, subscription-free desktop app for on-set RAW ingestion. Files come off the
camera or card, get named from the location folder you're shooting into, are copied to
two drives and checksum-verified, and are ready to take into Bridge and Photoshop at the
end of the shoot.

No editing, no cloud, no accounts. The files, folders and `.xmp` sidecars on your drives
are the real record. The app's database is only a working index, so deleting the app
loses nothing.

## Install it

Wrangle is built automatically every time a change lands. The newest version is always on
the repo's **Releases** page (right-hand side of the repo's main page on GitHub).

**Mac**

1. Find out which chip your Mac has: Apple menu (top left) > **About This Mac**. If it
   says **Chip: Apple M…**, you want the `Mac-Apple-chip` file. If it says **Intel**, you
   want the `Mac-Intel` file.
2. On the Releases page, under the newest release, click that `.dmg` file to download it.
3. Open the downloaded `.dmg`. Drag **Wrangle** onto the **Applications** folder, then
   close the window and eject the Wrangle disk in Finder's sidebar.
4. Open **Applications** and double-click **Wrangle**. The first time, macOS says it
   can't check the app for malware, because it isn't signed with a paid Apple developer
   account. Click **Done** (not Move to Trash).
5. Open **System Settings** > **Privacy & Security**, scroll down to the line that says
   "Wrangle was blocked", click **Open Anyway**, then **Open Anyway** again and enter your
   Mac password. (On older macOS you can instead right-click Wrangle, choose **Open**,
   then **Open**.) You only do this once per new version.

Your sessions and settings carry over between versions; installing a new one just
replaces the app.

**Windows**

Download the `Windows-Setup.exe` file from the newest release and double-click it. If
Windows says "Windows protected your PC", click **More info**, then **Run anyway**.

### Run from the source instead

For trying out unreleased changes. Install [Node.js](https://nodejs.org) 22 or newer,
download this repo (green **Code** button, **Download ZIP**), unzip it, and double-click
`Start Wrangle (Mac).command` or `Start Wrangle (Windows).bat`. On a Mac, Sony tethering
from source also needs Apple's free Command Line Tools, which the launcher offers to install.

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

## Tethered cameras

### Sony (direct, Mac)

Wrangle talks to Sony cameras directly through Sony's Camera Remote SDK, the way
Capture One does. No other program is needed.

1. Nothing extra to install: Sony's libraries come inside the app.
2. On the camera, plug in the USB cable and choose **Remote Shoot (PC Remote)** when
   asked. Close Capture One and Imaging Edge, since only one program can control the
   camera at a time.
3. Open a session. The top bar shows "Sony a7 IV tethered" and a **Shoot** button.
   Press **Space** or the shutter button on the camera. Each frame is copied to this
   Mac, named into the capture location, backed up, and also kept on the camera's card.
4. The **Camera** panel on the right shows the camera's settings: aperture, shutter,
   ISO, exposure comp, white balance (and Kelvin), focus mode and drive mode. Click a
   value to pick from a list, or use ◀ ▶ to step one click. Changes made on the camera
   show up in the app too. The mode (M, A, S, P) is set with the dial on the camera.
5. **Bracketing**: choose a bracket in **Drive**. A *Cont. bracket* fires the whole set
   from one click of **Shoot**; a *Single bracket* is pressed once per frame, and Wrangle
   does those presses for you, so one click still gives the full set.

### Other cameras

When another camera is plugged in by USB, it shows up by name in the top bar. Click it
and choose the folder that camera's tether program saves into (for Fujifilm, **FUJIFILM
X Acquire**). The app remembers that folder for that camera model and watches it in every
session. Only frames that arrive after the session opens are taken in, so older files in
that folder are left alone. If a camera drops off mid-shoot, the top bar turns amber.

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

On Windows, Bridge reads the same `.xmp` sidecars, so ratings and labels carry over
the same way.

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

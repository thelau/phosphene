# Phosphene

Makes 9:16 match-cut films around a brand mark: AI images where the mark always sits at the same place and size, cut to a
synthesized drone. Curate the images, cut the film, export an MP4.

It runs on your own computer. You sign in with your own Krea account (images use its credits) and your own Kimi key
(it writes the image ideas).

## The Mac app (easiest)

Download **Phosphene.dmg** from the link you were sent, open it and drag Phosphene into Applications.
The first time, right-click Phosphene › **Open** › **Open** (the app is not signed by Apple yet). After that it opens normally,
and it updates itself: when a new version is out it says so, and **Restart to update** installs it.

- Your projects are in **Documents › Phosphene**, one folder each. Updates never touch them, and deleting the app leaves them.
  Back them up like any document. Demo, the sample, is copied there the first time.
- To send a project to someone: the project menu (next to Phosphene) › **Export project…**; they use **Import project…**.
- Needs a Mac with Apple silicon (M1 or newer).

## Install from the code (for developers)

You need a Mac (or Linux) with [Homebrew](https://brew.sh), and Git.

```sh
git clone <this repository> phosphene
cd phosphene
npm run setup        # checks Python 3.10+, Node 20+, ffmpeg and git-lfs (offers to install what is missing),
                     # downloads the Demo images and installs the app's packages
```

If `npm` itself is missing: `brew install node`, then run the line again.

## Run

```sh
npm run dev
```

Then open http://localhost:5173. Stop it with Ctrl-C.

The first time:
1. **Settings** (the sliders icon, top right) › **Connect Krea**: sign in to Krea in the tab that opens, then come back.
2. In the same Settings, paste your **Kimi API key** and save.

## Projects

A project is one brand mark. The name next to **Phosphene** (top left) switches between them.

- **Demo** is shared through this repository: its images, groups and snapshots come with `git pull`.
  If two people curate it at the same time, the curation file (`studio/curation_state.json`) will conflict when you pull:
  agree who curates it, or make your own project.
- **New project…** takes your mark (a PNG or SVG with a transparent background works best), its size and place in the frame,
  how the image prompts should describe it, one line about the brand, and its colours. A new project stays on your computer
  (`projects/<name>/`, not committed).

## Update

```sh
git pull
npm run setup        # only needed when packages changed; safe to run any time
```

## For developers

`AGENTS.md` describes how everything works. Tests: `.venv/bin/python -m pytest studio/tests -q`.

## Releasing the Mac app

```sh
npm run release 0.1.1     # builds, signs and publishes to github.com/thelau/phosphene-releases
```

The automatic tests (`.venv/bin/python -m pytest studio/tests -q`, `npm test`, `node --test studio/tests/e2e/*.e2e.test.cjs`) cover
the page and the server. They cannot reach the Mac app's own shell, where several bugs were only found by hand, so before
publishing, open the built app (`app/src-tauri/target/release/bundle/macos/Phosphene.app`) and check, about 5 minutes:

- [ ] **It opens**, on the last project, with the Phosphene icon in the Dock and in ⌘Tab; About Phosphene shows the new version.
- [ ] **Menu bar**: File › New Project (⌘N) opens the form; File › Open Project File… (⌘O) opens the macOS file dialog; Project ›
      Import project… opens the same dialog; Export project… saves a `.phos` file to Downloads.
- [ ] **A `.phos` file double-clicked in Finder** opens as a project.
- [ ] **Settings › Connect Krea** opens Krea's sign-in in your browser and comes back connected.
- [ ] **Generate** a small batch (2 images): they arrive with the logo check's badges.
- [ ] **Sound**: Film › play: the drone plays. Put Phosphene behind other windows for 5 minutes, come back: it still plays.
- [ ] **Export** a short film: "Downloaded", and the MP4 in Downloads plays (not a tiny broken file).
- [ ] **⌘Q while generating** asks "Quit anyway / Keep working"; reopening offers to Resume the images not made.
- [ ] **Full screen** and back: the window's red / yellow / green buttons sit right in the top bar.
- [ ] **Update** (from the previous version installed): the "Restart to update" bar appears and the app comes back as the new version.

Keep the update signing key (`~/.tauri/phosphene.key`) backed up: without it, installed apps can never update again.

# Phosphene

Makes 9:16 match-cut films around a brand mark: AI images where the mark always sits at the same place and size, cut to a
synthesized drone. Curate the images, cut the film, export an MP4.

It runs on your own computer. You sign in with your own Krea account (images use its credits) and your own Kimi key
(it writes the image ideas).

## Install (once)

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

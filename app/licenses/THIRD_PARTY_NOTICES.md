# Third-party software in Phosphene

Phosphene.app carries these programs and fonts, each under its own license. Their license texts are in this folder.

## FFmpeg 7.1 (bin/ffmpeg)

The film export runs FFmpeg as a separate program. This build comes from imageio-ffmpeg 0.7.0
(https://github.com/imageio/imageio-ffmpeg) and was configured with `--enable-gpl`, so it is licensed under the
GNU General Public License, version 2 or later (GPL-2.0.txt). It includes x264 and x265 (GPL).

- FFmpeg: https://ffmpeg.org · source of this version: https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz
- Configuration of this build:

```
--prefix=/Volumes/tempdisk/sw --extra-cflags=-fno-stack-check --arch=arm64 --cc=/usr/bin/clang --enable-gpl --enable-libvmaf --enable-libopenjpeg --enable-libopus --enable-libmp3lame --enable-libx264 --enable-libx265 --enable-libvpx --enable-libwebp --enable-libass --enable-libfreetype --enable-fontconfig --enable-libtheora --enable-libvorbis --enable-libsnappy --enable-libaom --enable-libvidstab --enable-libzimg --enable-libsvtav1 --enable-libharfbuzz --enable-libkvazaar --pkg-config-flags=--static --enable-ffplay --enable-postproc --enable-neon --enable-runtime-cpudetect --disable-indev=qtkit --disable-indev=x11grab_xcb
```

## Fonts

- JetBrains Mono, SIL Open Font License 1.1 (OFL-1.1-JetBrainsMono.txt)
- Schibsted Grotesk, SIL Open Font License 1.1 (OFL-1.1-SchibstedGrotesk.txt)

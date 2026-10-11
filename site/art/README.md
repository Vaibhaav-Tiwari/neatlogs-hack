# Artwork

Painted images, converted from the approved PNGs (which stay out of git) with
ffmpeg: AVIF first, JPEG as the fallback, each at 1920 and 960 pixels wide.

| Files | Section | How it is used |
|---|---|---|
| `hero.avif`, `hero.jpg`, `hero-960.*` | Hero | The drawn SVG mark develops into it. The script switches it on only after `hero.jpg` has loaded; if it is missing, the SVG mark stays. |
| `desert.avif`, `desert.jpg`, `desert-960.*` | Proof | Full-bleed plate above the section, with parallax. |
| `og.jpg` | Link previews | 1200 x 630 crop of the hero. |

Still empty, and harmless until a file exists (the browser logs one "not found" request for each):

| File | Section | Suggested size |
|---|---|---|
| `mascots.webp` | Agent Orchestrator | 1920 wide |
| `contact.webp` | Contact | 1600 wide |

To convert a new painting:

```bash
ffmpeg -i in.png -vf "scale=1920:-2,format=yuv420p" -frames:v 1 -c:v libsvtav1 -crf 30 -preset 4 name.avif
ffmpeg -i in.png -vf "scale=1920:-2" -frames:v 1 -q:v 4 name.jpg
```

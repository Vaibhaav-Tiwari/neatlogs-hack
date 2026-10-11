# Artwork slots

The page is complete without any file here. Dropping a file with one of these
names adds the painted layer to its section; nothing else needs editing.

| File | Section | Used as | Suggested size |
|---|---|---|---|
| `hero.webp` | Hero | Layer over the backdrop, behind the mark and text, blended with `screen` so black stays transparent | 2400 x 1500 |
| `mascots.webp` | Agent Orchestrator | Section background | 2000 x 1200 |
| `desert.webp` | Proof | Section background | 2400 x 1400 |
| `contact.webp` | Contact | Section background | 1600 x 1200 |
| `og.png` | Link previews (Open Graph, X) | Share image; previews have none until it exists | 1200 x 630 |

Keep each file under about 400 KB. The opacity and blend of a slot are set on
`.art-<name>` in `styles.css`.

Until a file exists the browser logs one "not found" request for it. That is
expected and harmless.

# AVCP online gallery - CDN upload package

Upload the contents of this folder to the CDN so the panel's
**Settings → Online gallery** can find them. The panel fetches exactly one.
This is currently not implemented, but the code is technically there.
hard-coded URL:

```
https://cdn.boykisser.cloud/malo-interactive/avcp/gallery.json
```

so the target layout on the CDN is:

```
malo-interactive/
└── avcp/
    ├── gallery.json              ← the manifest (this folder's copy)
    ├── profiles/
    │   └── track-day.json        ← profile JSONs referenced by the manifest
    └── backgrounds/              ← background images (optional, see below)
```

## CORS - required for the manifest and profiles

The browser fetches `gallery.json` and every `profiles/*.json` with
JavaScript, which means the CDN must answer those files with:

```
Access-Control-Allow-Origin: *
```

Without that header the gallery shows a "couldn't load" message even though
the file is publicly reachable. **Background images do not need CORS** - they
are applied as CSS `background-image` URLs, which browsers display without
cross-origin checks. The intro splash videos don't need it either (`<video>`
playback is also CORS-exempt).

Serve `gallery.json` with a short cache time (or `no-cache`) so edits show up
promptly; the panel requests it with `cache: "no-store"` on its side.

## Manifest format (`avcp-gallery-1`)

```json
{
  "format": "avcp-gallery-1",
  "backgrounds": [ { "name": "…", "url": "https://…/full.jpg", "thumb": "https://…/thumb.jpg" } ],
  "profiles":    [ { "name": "…", "description": "…", "url": "https://…/profile.json" } ]
}
```

- **themes are deliberately not part of the gallery** - they stay local to the
  panel (Settings → Theme presets + custom colours). A `themes` array in the
  manifest is ignored. To share a look, share a *profile* (it carries the
  theme choice along with everything else) or custom CSS.
- **backgrounds** - `url` is the full-size image (1920×1080+ JPEG works well;
  keep them under ~1 MB for phone users). `thumb` is optional (a small
  ~200px crop used for the gallery tile; falls back to `url`). The panel
  hot-links these - they are *not* downloaded into the user's storage, so a
  removed file simply stops displaying.
- **profiles** - point at `avcp-profile-1` JSON files (the same format the
  panel's *Profiles → export* button produces). The easiest way to make one:
  set the panel up how you want, save a profile, export it, upload it, add a
  manifest entry.

Adding an entry never requires a panel update - edit `gallery.json`, upload,
done. Users see it on their next *Browse*.

**Testing a manifest before uploading:** in the panel's browser console run
`localStorage.setItem("avcp.galleryUrl", "<any URL>")` to point the gallery at
a draft manifest (remove the key to go back to the CDN).

## Included starter content

- `gallery.json` - no backgrounds yet (add your own per above), one profile.
- `profiles/track-day.json` - *Track Day*: Redline theme, boost in bar,
  95 % redline with the shift light armed, carbon background.

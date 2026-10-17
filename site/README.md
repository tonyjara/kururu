# kururu.dev

The landing page for kururu, in TanStack Start. It is its own package, with its
own `bun.lock`, and is not one of the root's workspaces: nothing here takes part
in building, testing or releasing the app, and the root's `bun install`,
`typecheck` and `test` never look in this folder.

```sh
cd site
bun install
bun run dev        # http://localhost:3031 — the port is pinned in vite.config.ts
bun run build      # prerenders to dist/client
bun run preview    # serves the build on 3031
```

## Publishing

`bun run build` prerenders the one page to plain HTML, so what gets published
is **a static folder, `site/dist/client/`**, on any static host (Cloudflare
Pages, Netlify, Vercel, an nginx root). No Node server is needed. `dist/server/`
is the renderer the prerender step used, and is not deployed.

A host that builds from the repository wants: root directory `site`, build
command `bun install && bun run build`, output directory `dist/client`.

## What to change when

- **A release:** the version and the two DMG links in `src/site.ts`. The links
  name the version because the files do, so `releases/latest/download/` cannot
  stand in for them.
- **New screenshots:** `public/shots/`, as WebP, and their sizes in
  `src/shots.ts`. They come from the real app in an isolated instance filled
  with made-up projects, never from the user's own window.
- **The Open Graph image:** `public/og.png`, 1200×630.

# slakk web

Static desktop planner: Leaflet map + Rust Wasm A\*. Hosted from this repo on
GitHub Pages (`../.github/workflows/pages.yml`).

```sh
# from repo root
make web-dev    # http://localhost:5173/slakk/
make web        # web/dist/
```

Requires [rustup](https://rustup.rs/) (not Homebrew `rust` alone),
`wasm32-unknown-unknown`, `wasm-pack`, and Node 20+. From the repo root,
`make web-dev` puts `~/.cargo/bin` on `PATH` first.

If an older session registered the COI service worker and the map is grey,
unregister it (DevTools → Application → Service Workers) or use a private window.

After the first Pages deploy, set the repository Pages source to **GitHub
Actions** (Settings → Pages).

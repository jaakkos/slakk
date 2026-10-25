# Contributing to slakk

Thanks for helping. slakk is deliberately small: one module (`slakk.py`), one
test file, and NumPy and Pillow as the only dependencies. Please keep it that
way unless a change clearly needs more.

## Ground rules

- **Never commit private data.** No GPX tracks, Strava activity ids, tokens,
  client secrets or terrain caches. `temp/` and `*-cache/` are ignored for
  this. Tests use synthetic terrain only.
- **Fail closed.** Unknown NVE colours, missing coverage and modified caches
  must stop the run with an error. Never relax a route constraint without
  telling the user.
- **Say when outputs change.** If a change alters the GPX, PNG, HTML or
  report for the same inputs, say so in the pull request, and prefer an
  opt-in flag.
- **No safety claims.** Candidates are unverified planning aids. Don't
  describe a route as safe.

## Set up

```sh
python3 -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
python -m pip install --require-hashes -r requirements.lock
python -m pip install --no-deps -e .
```

## Check your change

```sh
python -m unittest -v                  # offline unit tests
python scripts/smoke_test.py           # end-to-end run on synthetic terrain
uvx ruff check .                       # lint
```

CI runs the same on Linux, macOS and Windows with Python 3.11 to 3.14. Tests
must not use the network; mock `slakk.download` instead.

## Dependencies

`pyproject.toml` holds the allowed version ranges. `requirements.lock` pins
the exact runtime versions with hashes for every platform, and
`requirements-build.lock` does the same for PyInstaller, from
`requirements-build.in`. After changing a range, regenerate the matching lock
with [uv](https://docs.astral.sh/uv/) and commit both files:

```sh
uv pip compile pyproject.toml --universal --python-version 3.11 --generate-hashes -o requirements.lock
uv pip compile requirements-build.in --universal --python-version 3.11 --generate-hashes -o requirements-build.lock
```

To pick up a newer release within the existing range, add
`--upgrade-package <name>`. CI fails if a lock no longer matches, and the
weekly Dependencies workflow runs pip-audit on both locks.

## Releases

Maintainers only:

1. Bump `VERSION` in `slakk.py` and `version` in `pyproject.toml` to the same
   number, and merge that to `main`.
2. Tag and push: `git tag v0.6.0 && git push origin v0.6.0`.
3. The Release workflow checks the tag against the version, builds and
   smoke-tests binaries for Linux, macOS and Windows, and attaches them with
   `SHA256SUMS` and build attestations to a **draft** release.
4. Review the draft and its notes on GitHub, then publish it.

# Local install and checks for slakk. Requires Python 3.11+ and Make.
PYTHON ?= .venv/bin/python
PIP ?= .venv/bin/pip
# Prefer rustup's toolchain over Homebrew rust (which lacks wasm32 by default).
export PATH := $(HOME)/.cargo/bin:$(PATH)

.PHONY: help install install-garmin slakk test smoke test-rust test-web check web web-dev wasm-tools

help:
	@echo 'Targets:'
	@echo '  make install         Create .venv, install locked deps, editable slakk'
	@echo '  make install-garmin  Same as install, plus optional Garmin upload extra'
	@echo '  make slakk ARGS="…"  Run .venv/bin/slakk (example: ARGS="pick --center 69.65,18.95")'
	@echo '  make test            Run offline Python unit tests'
	@echo '  make test-rust       Run slakk-core (Wasm planner) unit tests'
	@echo '  make test-web        Run web Vitest unit tests'
	@echo '  make smoke           End-to-end run on synthetic terrain'
	@echo '  make check           Python + Rust + web unit tests + smoke'
	@echo '  make web             Build Rust Wasm + static site into web/dist'
	@echo '  make web-dev         Wasm build + Vite dev server (http://localhost:5173/slakk/)'
	@echo ''
	@echo 'After install, either use .venv/bin/slakk … or: source .venv/bin/activate'
	@echo 'Web builds need rustup + wasm32-unknown-unknown + wasm-pack (make wasm-tools).'

wasm-tools:
	@command -v rustup >/dev/null || { echo 'Install rustup from https://rustup.rs/ (Homebrew rust alone cannot build Wasm).'; exit 1; }
	rustup target add wasm32-unknown-unknown
	@command -v wasm-pack >/dev/null || cargo install wasm-pack --locked
	@echo "Using $$(command -v rustc) ($$(rustc --version))"

.venv/bin/python:
	python3 -m venv .venv
	$(PIP) install --upgrade pip

install: .venv/bin/python
	$(PIP) install --require-hashes -r requirements.lock
	$(PIP) install --no-deps -e .
	@echo ""
	@echo "Installed. The shell does not see 'slakk' until the venv is on PATH."
	@echo "  .venv/bin/slakk --help"
	@echo "  .venv/bin/slakk pick --center 69.65,18.95"
	@echo "Or:  source .venv/bin/activate   # then plain 'slakk' works"

install-garmin: .venv/bin/python
	$(PIP) install --require-hashes -r requirements.lock
	$(PIP) install -e '.[garmin]'
	@echo ""
	@echo "Installed with Garmin extra (unofficial Connect API)."
	@echo "  .venv/bin/slakk --help"
	@echo "  .venv/bin/slakk garmin-login"
	@echo "Or:  source .venv/bin/activate"

# Example: make slakk ARGS='pick --center 69.65,18.95'
slakk: .venv/bin/python
	.venv/bin/slakk $(ARGS)

test: .venv/bin/python
	$(PYTHON) -m unittest -v

test-rust:
	cargo test -p slakk-core --lib

test-web:
	cd web && npm install && npm test

smoke: .venv/bin/python
	$(PYTHON) scripts/smoke_test.py

check: test test-rust test-web smoke

web: wasm-tools
	cd web && npm install && npm run wasm && npm run build

web-dev: wasm-tools
	cd web && npm install && npm run wasm && npm run dev

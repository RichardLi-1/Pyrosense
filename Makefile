# Dev commands. `make` lists them.
SHELL := /bin/bash

PY          := .venv/bin/python
COMPOSE_DEV := docker compose -f docker-compose.dev.yml
LOCAL_DB    := postgresql://postgres:postgres@localhost:5433/app
LOCAL_PI    := ws://localhost:8765

.DEFAULT_GOAL := help
.PHONY: help setup db schema psql db-down db-reset fake-pi api api-local dashboard dev test smoke

help: ## List commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

setup: ## Install backend venv + dashboard deps, create backend/.env
	@if command -v uv >/dev/null; then \
	  cd backend && uv venv --python 3.12 .venv && uv pip install --python $(PY) -e ".[dev]"; \
	elif command -v python3.12 >/dev/null; then \
	  cd backend && python3.12 -m venv .venv && $(PY) -m pip install -q -e ".[dev]"; \
	else echo "Need Python 3.12+: brew install uv  (then re-run make setup)"; exit 1; fi
	npm --prefix dashboard install
	@[ -f backend/.env ] || { cp backend/.env.example backend/.env; echo "created backend/.env"; }

db: ## Start local TimescaleDB (port 5433), wait for it, apply schema
	$(COMPOSE_DEV) up -d
	@printf "waiting for db"; until $(COMPOSE_DEV) exec -T timescaledb pg_isready -q -h 127.0.0.1 -U postgres -d app; do printf .; sleep 1; done; echo
	@$(MAKE) -s schema

schema: ## Re-apply db/schema.sql to the local db (idempotent)
	$(COMPOSE_DEV) exec -T timescaledb psql -q -v ON_ERROR_STOP=1 -U postgres -d app < db/schema.sql

psql: ## Open psql on the local db
	$(COMPOSE_DEV) exec timescaledb psql -U postgres -d app

db-down: ## Stop the local db (keeps data)
	$(COMPOSE_DEV) down

db-reset: ## Wipe the local db and start fresh
	$(COMPOSE_DEV) down -v
	@$(MAKE) -s db

fake-pi: ## Fake Pi on :8765 (VOC spike after 20 s)
	cd backend && $(PY) -m tools.fake_pi --port 8765 --spike-at 20

api: ## API on :8000 using backend/.env (real Pi / Tiger)
	cd backend && .venv/bin/uvicorn app.main:app --port 8000 --reload

api-local: ## API on :8000 against the local db + fake Pi
	cd backend && BRIDGE_URL=$(LOCAL_PI) DATABASE_URL=$(LOCAL_DB) .venv/bin/uvicorn app.main:app --port 8000 --reload

dashboard: ## Dashboard dev server
	npm --prefix dashboard run dev

dev: ## Everything, no hardware: db + fake Pi + API + dashboard (Ctrl-C stops all)
	@scripts/dev.sh

test: ## Backend tests (no db or bridge needed)
	cd backend && $(PY) -m pytest -q

smoke: ## Hit every REST route on a running API
	@scripts/smoke.sh

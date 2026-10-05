.PHONY: install infra dev build lint typecheck test test-browser test-integration coverage-api e2e smoke seed traffic bench loadtest size publint attw pack docs up down

install:
	pnpm install

infra:
	../devinfra/start.sh

dev:
	pnpm dev

build:
	pnpm build

lint:
	pnpm lint && pnpm format:check

typecheck:
	pnpm typecheck

test:
	pnpm test

test-browser:
	pnpm test:browser

test-integration:
	pnpm test:integration

coverage-api:
	pnpm test:coverage:api

e2e: build
	pnpm test:e2e

smoke:
	pnpm smoke

seed:
	pnpm seed -- --reset

traffic:
	pnpm traffic

bench:
	pnpm bench

loadtest: build
	pnpm loadtest

size:
	pnpm size

publint:
	pnpm publint

attw:
	pnpm attw

pack:
	pnpm pack:check

docs:
	pnpm docs:api

up:
	docker compose up --build

down:
	docker compose down -v

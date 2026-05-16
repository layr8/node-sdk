.DEFAULT_GOAL := help

COMPOSE := docker compose -f docker-compose.yml

.PHONY: help generate up down test ci logs ps

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

generate: ## Generate docker-compose.yml from matrix.json
	npx tsx generate-compose.ts

up: generate ## Start all services (Postgres, Traefik, nodes)
	$(COMPOSE) up -d --wait

down: ## Tear down all containers and volumes
	$(COMPOSE) down -v --remove-orphans

test: up ## Run integration tests (leaves containers running)
	npx vitest run --config vitest.config.ts

ci: up ## Run tests then tear down (for CI)
	npx vitest run --config vitest.config.ts; status=$$?; $(COMPOSE) down -v --remove-orphans; exit $$status

logs: ## Tail logs from all services
	$(COMPOSE) logs -f

ps: ## Show running services
	$(COMPOSE) ps


SHELL := /bin/bash
DC    := docker compose
STACK := $(notdir $(CURDIR))

.DEFAULT_GOAL := help

help: ## show this
	@echo "Field Checkout"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  first time:  ./setup.sh"

up: ## start everything
	$(DC) up -d --build
	@$(MAKE) --no-print-directory health

down: ## stop everything (data is kept)
	$(DC) down

restart: ## restart the containers
	$(DC) restart

logs: ## tail all logs
	$(DC) logs -f --tail=100

logs-pb: ## tail the backend only
	$(DC) logs -f --tail=100 pocketbase

ps: ## what is running
	$(DC) ps

health: ## check every service answers
	@set -a; source .env 2>/dev/null; set +a; \
	if [ "$$APP_DOMAIN" = "lan.invalid" ]; then BASE=http://localhost:8080; \
	else BASE=https://$$APP_DOMAIN; fi; \
	printf 'app       '; curl -sfo /dev/null -w '%{http_code}\n' $$BASE/ || echo DOWN; \
	printf 'backend   '; curl -sf $$BASE/api/health  >/dev/null && echo ok || echo DOWN; \
	printf 'exporter  '; curl -sf $$BASE/export/health >/dev/null && echo ok || echo DOWN

app: ## publish a new build of the app (FILE=index.html)
	@test -n "$(FILE)" || { echo "usage: make app FILE=field_checkout.html"; exit 1; }
	cp "$(FILE)" web/index.html
	@# bump the cache name so phones pick it up instead of serving yesterday's app
	@sed -i "s/fc-shell-v[0-9]*/fc-shell-v$$(date +%s)/" web/sw.js
	$(DC) restart caddy
	@echo "Published. Phones update next time they open the app with signal."

template: ## upload a project's source workbook (PROJECT=id FILE=x.xlsm TOKEN=...)
	@test -n "$(PROJECT)" -a -n "$(FILE)" -a -n "$(TOKEN)" || \
	  { echo "usage: make template PROJECT=<id> FILE=KOKUSAI_P2P.xlsm TOKEN=<lead token>"; exit 1; }
	@set -a; source .env; set +a; \
	if [ "$$APP_DOMAIN" = "lan.invalid" ]; then BASE=http://localhost:8080; \
	else BASE=https://$$APP_DOMAIN; fi; \
	curl -sf -X POST $$BASE/export/template/$(PROJECT) \
	  -H "Authorization: Bearer $(TOKEN)" -F file=@$(FILE) && echo

backup: ## snapshot the database and photos into ./backups
	@mkdir -p backups
	docker run --rm -v $(STACK)_pb_data:/data -v $(CURDIR)/backups:/out alpine \
	  tar czf /out/pb_$$(date +%F_%H%M).tar.gz -C /data .
	@ls -lh backups | tail -3

restore: ## restore a snapshot (FILE=backups/pb_....tar.gz) — stops the stack
	@test -n "$(FILE)" || { echo "usage: make restore FILE=backups/pb_2026-09-21.tar.gz"; exit 1; }
	@echo "This replaces all current data. Ctrl-C to bail."; sleep 4
	$(DC) stop pocketbase
	docker run --rm -v $(STACK)_pb_data:/data -v $(CURDIR):/in alpine \
	  sh -c "rm -rf /data/* && tar xzf /in/$(FILE) -C /data"
	$(DC) start pocketbase
	@$(MAKE) --no-print-directory health

deploy: ## git pull, publish the app, rebuild, health check
	git pull --ff-only
	@sed -i "s/fc-shell-v[0-9]*/fc-shell-v$$(date +%s)/" web/sw.js
	$(DC) up -d --build
	@$(MAKE) --no-print-directory health
	@echo "Deployed. Phones update next time they open the app with signal."

update: ## pull newer images and rebuild
	$(DC) pull
	$(DC) up -d --build
	@$(MAKE) --no-print-directory health

shell-pb: ## shell inside the backend container
	$(DC) exec pocketbase sh

reset-password: ## set an app user's password (EMAIL=... PASS=...)
	@test -n "$(EMAIL)" -a -n "$(PASS)" || { echo "usage: make reset-password EMAIL=x@y.com PASS=newpass"; exit 1; }
	@echo "Use the dashboard at /_/ → users → the record → password."
	@echo "Doing it here would bypass the audit trail."

nuke: ## delete EVERYTHING including the database
	@echo "This destroys all data and certificates. Type the stack name to confirm:"
	@read -r c; [ "$$c" = "$(STACK)" ] || { echo "aborted"; exit 1; }
	$(DC) down -v

.PHONY: help up down restart logs logs-pb ps health app template backup restore deploy update shell-pb reset-password nuke

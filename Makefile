# Aegisci Control Plane Makefile
#
# 用法：
#   make help                 # 查看所有目标
#   make install              # 安装依赖
#   make build                # 构建所有包
#   make dev                  # 开发模式启动控制面
#   make test                 # 运行全部测试
#   make lint                 # 检查代码风格
#   make clean                # 清理构建产物
#
# 环境变量：
#   AEGISCI_PORT          监听端口（默认 3000）
#   AEGISCI_ENV           环境（development / production）
#   AEGISCI_DEPLOYMENT_MODE  部署档位（minimal / standard / hardened，默认 standard）
#   AEGISCI_PG_URL        PostgreSQL 连接串
#   AEGISCI_MOCK_MODE     Mock 开关（on / off / strict / auto，默认未设置）
#   OTEL_EXPORTER_OTLP_ENDPOINT  OTel 追踪端点
#   VAULT_ADDR            HashiCorp Vault 地址
#   VAULT_TOKEN           Vault Token

.PHONY: help install build dev \
        run:minimal run:standard run:hardened \
        dev:minimal dev:standard dev:hardened \
        test test:watch lint lint:fix clean build:control-plane

# ──────────────────────────────────────────────
# 元信息
# ──────────────────────────────────────────────
NODE_BIN  = node_modules/.bin
NX        = $(NODE_BIN)/nx
JEST      = $(NODE_BIN)/jest
ESLINT    = $(NODE_BIN)/eslint

default: help

help:
	@echo "Aegisci Control Plane — 构建与部署"
	@echo ""
	@echo "【构建 & 开发】"
	@echo "  make install        安装依赖"
	@echo "  make build          构建（tsc + nx build）"
	@echo "  make dev            开发模式启动（nx serve control-plane，默认 standard 档）"
	@echo ""
	@echo "【各档本地运行（build + node，完整环境变量）】"
	@echo "  make run:minimal    minimal 档本地运行（默认端口 3000，无需外部依赖）"
	@echo "  make run:standard   standard 档本地运行（默认 PG localhost，OTel 4318）"
	@echo "  make run:hardened   hardened 档本地运行（同 standard + WORM/Opa）"
	@echo ""
	@echo "【各档开发服务器（nx serve，动态注入环境变量）】"
	@echo "  make dev:minimal    minimal 档开发服务器"
	@echo "  make dev:standard   standard 档开发服务器"
	@echo "  make dev:hardened   hardened 档开发服务器"
	@echo ""
	@echo "【测试 & 代码质量】"
	@echo "  make test           运行全部测试"
	@echo "  make test:watch     测试监听模式"
	@echo "  make lint           代码风格检查"
	@echo "  make lint:fix       自动修复代码风格"
	@echo "  make clean          清理 dist/ 和 node_modules/.cache/"
	@echo ""
	@echo "环境变量："
	@echo "  AEGISCI_PORT            监听端口（默认 3000）"
	@echo "  AEGISCI_ENV             环境（development / production）"
	@echo "  AEGISCI_DEPLOYMENT_MODE 部署档位（minimal / standard / hardened）"
	@echo "  AEGISCI_PG_URL          PostgreSQL 连接串"
	@echo "  AEGISCI_MOCK_MODE       Mock 开关（on / off / strict / auto，默认未设置）"
	@echo "  OTEL_EXPORTER_OTLP_ENDPOINT  OTel 追踪端点（default: http://localhost:4318/v1/traces）"
	@echo "  VAULT_ADDR              HashiCorp Vault 地址"
	@echo "  VAULT_TOKEN             Vault Token"

# ──────────────────────────────────────────────
# 安装
# ──────────────────────────────────────────────
install:
	npm install

# ──────────────────────────────────────────────
# 构建
# ──────────────────────────────────────────────
build: build:control-plane
	@echo "✓ 全部构建完成"

build:control-plane:
	$(NX) run control-plane:build

# ──────────────────────────────────────────────
# 开发（默认 standard 档）
# ──────────────────────────────────────────────
dev:
	AEGISCI_ENV=development $(NX) run control-plane:serve

# ──────────────────────────────────────────────
# 各档位本地运行（build + node dist，适用于本地联调）
# 外部依赖地址通过变量 $(VAR) 或环境变量传入，缺失时提供合理默认值
# ──────────────────────────────────────────────

# minimal：无外部依赖，内存实现；可快速验证 API
run:minimal:
	AEGISCI_ENV=development \
	AEGISCI_DEPLOYMENT_MODE=minimal \
	AEGISCI_PORT=$(or $(AEGISCI_PORT),3000) \
	$(NX) run control-plane:build && \
	AEGISCI_ENV=development \
	AEGISCI_DEPLOYMENT_MODE=minimal \
	AEGISCI_PORT=$(or $(AEGISCI_PORT),3000) \
	node dist/apps/control-plane/main.js

# standard：需 PG + Vault；本地兜底使用 localhost:5432 + 默认 OTel 端点
run:standard:
	AEGISCI_ENV=production \
	AEGISCI_DEPLOYMENT_MODE=standard \
	AEGISCI_PORT=$(or $(AEGISCI_PORT),3000) \
	$(NX) run control-plane:build && \
	AEGISCI_ENV=production \
	AEGISCI_DEPLOYMENT_MODE=standard \
	AEGISCI_PG_URL=$(or $(AEGISCI_PG_URL),postgres://aegisci:aegisci@localhost:5432/aegisci) \
	AEGISCI_PORT=$(or $(AEGISCI_PORT),3000) \
	OTEL_EXPORTER_OTLP_ENDPOINT=$(or $(OTEL_EXPORTER_OTLP_ENDPOINT),http://localhost:4318/v1/traces) \
	node dist/apps/control-plane/main.js

# hardened：同 standard + WORM Trace Exporter / OPA Policy Engine
run:hardened:
	AEGISCI_ENV=production \
	AEGISCI_DEPLOYMENT_MODE=hardened \
	AEGISCI_PORT=$(or $(AEGISCI_PORT),3000) \
	$(NX) run control-plane:build && \
	AEGISCI_ENV=production \
	AEGISCI_DEPLOYMENT_MODE=hardened \
	AEGISCI_PG_URL=$(or $(AEGISCI_PG_URL),postgres://aegisci:aegisci@localhost:5432/aegisci) \
	AEGISCI_PORT=$(or $(AEGISCI_PORT),3000) \
	OTEL_EXPORTER_OTLP_ENDPOINT=$(or $(OTEL_EXPORTER_OTLP_ENDPOINT),http://localhost:4318/v1/traces) \
	node dist/apps/control-plane/main.js

# ──────────────────────────────────────────────
# 各档位开发服务器（nx serve，动态注入环境变量）
# 适用场景：热重载开发，无需每次 rebuild
# ──────────────────────────────────────────────
dev:minimal:
	AEGISCI_ENV=development AEGISCI_DEPLOYMENT_MODE=minimal $(NX) run control-plane:serve

dev:standard:
	AEGISCI_ENV=development AEGISCI_DEPLOYMENT_MODE=standard $(NX) run control-plane:serve

dev:hardened:
	AEGISCI_ENV=development AEGISCI_DEPLOYMENT_MODE=hardened $(NX) run control-plane:serve

# ──────────────────────────────────────────────
# 测试
# ──────────────────────────────────────────────
test:
	$(JEST) --config apps/control-plane/jest.config.ts --no-coverage

test:watch:
	$(JEST) --config apps/control-plane/jest.config.ts --watch

lint:
	$(ESLINT) apps/ libs/ --ext .ts

lint:fix:
	$(ESLINT) apps/ libs/ --ext .ts --fix

# ──────────────────────────────────────────────
# 清理
# ──────────────────────────────────────────────
clean:
	rm -rf dist/
	rm -rf node_modules/.cache/

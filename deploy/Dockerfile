# ─────────────────────────────────────────────────────────────────────────────
# Aegisci Control Plane — Dockerfile（多阶段构建）
#
# 阶段1: builder   — 安装依赖 + 编译 TypeScript / Webpack bundle
# 阶段2: runtime   — Alpine Linux，仅含 Node.js + 打包产物
#
# 用法：
#   docker build -t aegisci/control-plane:latest -f deploy/Dockerfile .
#
# 运行时环境变量：
#   AEGISCI_PORT          监听端口（默认 3000）
#   AEGISCI_ENV           production（默认）
#   AEGISCI_DEPLOYMENT_MODE  minimal / standard / hardened
#   AEGISCI_PG_URL        PostgreSQL 连接串
#   AEGISCI_MOCK_MODE     on / off / strict / auto（默认未设置）
#   OTEL_EXPORTER_OTLP_ENDPOINT
#   VAULT_ADDR / VAULT_TOKEN
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# 复制根 package.json + lockfile（nx monorepo 根目录管理依赖）
COPY package.json package-lock.json* ./
COPY nx.json ./
COPY tsconfig.base.json ./

# 复制 workspace 中各子项目文件（确保路径解析完整）
COPY apps/      apps/
COPY libs/      libs/
COPY .eslint*   ./
COPY jest.preset.js ./

# 安装所有依赖（含 devDependencies，构建需要 ts-node / webpack 等）
RUN npm ci --ignore-scripts

# 构建：仅编译 control-plane 应用（排除 spec/test 文件由 tsconfig.app.json 控制）
RUN npx nx run control-plane:build

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# 安全加固：非 root 用户运行
RUN addgroup -g 1001 -S aegisci \
 && adduser  -u 1001 -S aegisci -G aegisci

WORKDIR /app

# 仅复制生产依赖（运行时不需要 devDependencies）
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules  ./node_modules/
# 复制构建产物（webpack 单文件入口 dist/apps/control-plane/main.js）
COPY --from=builder /app/dist/apps/control-plane ./dist/apps/control-plane/

# 切换至非 root 用户
USER aegisci

# NestJS 默认端口；nginx/ingress 可反向代理至此
EXPOSE 3000

# 健康探针：内置 /health 端点
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/v1/health || exit 1

# 启动入口
ENTRYPOINT ["node"]
CMD ["dist/apps/control-plane/main.js"]

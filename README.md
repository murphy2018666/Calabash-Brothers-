# AegisCI Control Plane

> 企业级「AI 多 Agent 驱动的 CI/CD 智能交付平台」
> 核心理念：**让 Agent 干活，让人掌权**。多 Agent 自动化执行流水线任务，细粒度权限体系确保每一步高危操作可授权、可审批、可审计。

---

## 快速开始

### 前置条件

- Node.js >= 20.x
- npm >= 9.x
- (可选) Docker & Docker Compose（快速启动依赖服务）
- (可选) Helm 3.x（K8s 部署）

### 安装

```bash
# 克隆仓库
git clone <repo-url>
cd cicd-llm

# 安装依赖
npm install
# 或使用 Makefile
make install
```

### 开发模式启动

```bash
# 快速启动（minimal 档，无需外部依赖）
make dev:minimal

# 开发模式启动（standard 档，需 PG + OTel）
make dev:standard
```

浏览器访问：http://localhost:3000/api/v1/health

---

## 本地联调

### 构建运行

```bash
# 构建
make build

# 各档位本地运行（完整环境变量）
make run:minimal      # 无外部依赖，内存实现
make run:standard     # PG localhost + OTel 4318
make run:hardened     # standard + WORM/Opa
```

### 测试

```bash
# 运行全部测试
make test

# 监听模式
make test:watch
```

**当前测试状态：124 套件 / 1671 测试 / 100% 通过**

### 代码质量

```bash
make lint           # 检查代码风格
make lint:fix       # 自动修复
make clean          # 清理构建产物
```

---

## Docker 部署

### 构建镜像

```bash
docker build -f deploy/Dockerfile -t aegisci/control-plane:latest .
```

### 运行容器

```bash
# Minimal 档（无外部依赖）
docker run -d --name aegisci -p 3000:3000 \
  -e AEGISCI_DEPLOYMENT_MODE=minimal \
  aegisci/control-plane:latest
```

---

## Docker Compose（三档一键启动）

### 快速启动（Minimal 档）

```bash
docker compose -f deploy/docker-compose.yml up -d
```

### 查看状态

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f control-plane
```

### 各档服务

| 档位 | 服务组成 |
|------|---------|
| minimal | 控制面 + PG + NATS + Redis + MinIO |
| standard | + Vault + OTel Collector |
| hardened | + WORM Trace Exporter + OPA |

---

## K8s 部署（Helm Chart）

### 前置条件

- Kubernetes 1.24+
- Helm 3.x
- kubectl 配置

### 安装

```bash
# 安装依赖
helm dependency update deploy/helm-chart/

# 创建命名空间
kubectl create namespace aegisci

# 安装标准档
helm install aegisci deploy/helm-chart/ \
  --namespace aegisci \
  --set deployment.mode=standard \
  --set postgresql.auth.password=<密码> \
  --set vault.auth.token=<Token>
```

### 三档部署命令

```bash
# Minimal 档
helm install aegisci deploy/helm-chart/ \
  --namespace aegisci \
  --set deployment.mode=minimal \
  --set postgresql.enabled=false \
  --set nats.enabled=false \
  --set redis.enabled=false \
  --set minio.enabled=false \
  --set vault.enabled=false \
  --set otelCollector.enabled=false \
  --set autoscaling.enabled=false

# Standard 档
helm install aegisci deploy/helm-chart/ \
  --namespace aegisci \
  --set deployment.mode=standard

# Hardened 档
helm install aegisci deploy/helm-chart/ \
  --namespace aegisci \
  --set deployment.mode=hardened \
  --set hardened.enabled=true \
  --set hardened.opa.enabled=true
```

详细部署文档见 [docs/DEPLOYMENT_BUILD.md](docs/DEPLOYMENT_BUILD.md)

---

## 三档部署架构

| 属性 | Minimal | Standard | Hardened |
|------|---------|----------|----------|
| 适用场景 | 开发验证 | 生产环境 | 等保三级 |
| 副本数 | 1 | 3 | 3 + HPA |
| 数据库 | 内存/PG单节点 | PG主从 | PG主从+加密 |
| 密钥管理 | EnvFile | Vault | Vault+HSM |
| 策略引擎 | Embedded | Embedded | OPA Sidecar |
| 追踪导出 | Noop | OTel | WORM |
| 沙箱运行时 | runc | runc加固 | gVisor |
| 首次启动 | 15分钟 | 30分钟 | 60分钟 |

详细部署方案见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AEGISCI_PORT` | 否 | 3000 | 监听端口 |
| `AEGISCI_ENV` | 否 | development | 环境标识 |
| `AEGISCI_DEPLOYMENT_MODE` | 是 | standard | 部署档位 |
| `AEGISCI_MOCK_MODE` | 否 | 未设置 | Mock 开关（仅测试） |
| `AEGISCI_PG_URL` | 否 | — | PostgreSQL 连接串 |
| `VAULT_ADDR` | 否 | — | Vault 地址 |
| `VAULT_TOKEN` | 否 | — | Vault Token |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 否 | — | OTel 端点 |

---

## 项目结构

```
cicd-llm/
├── apps/
│   └── control-plane/     # 控制面应用（NestJS）
│       ├── src/
│       │   ├── guards/    # 权限守卫
│       │   ├── spi/       # SPI 接口定义
│       │   ├── providers/ # 服务提供者
│       │   ├── mocks/     # Mock 工厂（测试用）
│       │   └── ...
│       └── jest.config.ts
├── libs/
│   └── domain/
│       └── identity/      # 身份域模块
├── deploy/
│   ├── Dockerfile         # 控制面容器镜像
│   ├── docker-compose.yml # 本地一键启动
│   └── helm-chart/        # K8s Helm Chart
├── docs/
│   ├── DEPLOYMENT.md      # 部署方案
│   └── DEPLOYMENT_BUILD.md # 构建与部署手册
└── Makefile               # 构建与部署命令
```

---

## 文档导航

| 文档 | 说明 |
|------|------|
| [产品文档](docs/product/product-document.md) | 定位、价值主张、用户画像 |
| [架构设计文档](docs/design/architecture-design.md) | ADD v1.0：12章完整架构设计 |
| [需求文档](docs/requirements/requirements-spec.md) | BR/FR/NFR 需求规格 |
| [部署方案](docs/DEPLOYMENT.md) | 三档部署方案详解 |
| [构建与部署手册](docs/DEPLOYMENT_BUILD.md) | Docker/Helm/CI-CD 完整指南 |
| [合规声明](docs/compliance/compliance-statement.md) | 等保三级合规覆盖度声明 |
| [索引](docs/00-index.md) | 全项目文档导航 |

---

## 许可证

MIT License

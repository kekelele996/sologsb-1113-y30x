# 天文观测计划编排台（gbobsplan）

面向业余天文台与高校天文社团的值班排期人员：把「观测目标—可见窗口—月相—望远镜与终端—备用观测夜」串成一份可执行的观测夜编排表，解决目标亮度与月相冲突、设备被重复占用、阴天临时改期难以追溯的问题。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21813>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | MUI（Material UI 5）+ Emotion |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（targetStore / sessionStore / equipmentStore / nightStore） |
| 存储 | IndexedDB（Dexie）两个物理独立库：目标库 `gbobsplan-catalog-db` 与编排库 `gbobsplan-plan-db`，v3 拆分（含旧混库回填迁移） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21813
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── db/                # catalogDb / planDb 两个独立库 + legacyDb + migrate(v2回填) + seeds + bootstrap
│       ├── services/          # 跨上下文联动（目标约束改动 → 待重排、启动补核对）
│       ├── types/             # ownership(归属) / target / session / equipment / night（+ index.ts 统一出口）
│       ├── stores/            # targetStore / sessionStore / equipmentStore / nightStore
│       ├── components/common/ # Timeline / StatusChip / ConflictBadge / FieldRow
│       ├── hooks/             # usePersistentStore（就绪判定）/ useConflictCheck
│       ├── pages/             # OverviewPage / TargetsPage / SessionsPage / EquipmentPage / ExportPage
│       ├── router/index.tsx   # 路由表
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ scheduling.ts（容量/失效）/ export.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突与低于高度阈值的目标自动标灰 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与冲突 | 冲突检测、按时段/望远镜校验，超容量自动顺延，阈值改动失效段进入待重排队列；勾选多条批量改期到备用观测夜并填写改期原因 |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；冲突格标红，点击可一键跳转到对应排程段 |
| `/export` | 导出观测清单 | 目标、时刻、滤镜、帧数导出为文本与 CSV，支持打印视图 |

## 数据存储说明（目标库 / 编排表分离）

两侧是两个**物理独立的 IndexedDB 数据库**，按限界上下文各管各的、互不可写：

| 数据库 | 归属 | 表 |
| --- | --- | --- |
| `gbobsplan-catalog-db`（目标库，协调员） | 观测目标、曝光参数、高度阈值 | `targets`、`meta` |
| `gbobsplan-plan-db`（编排表，排程员） | 观测夜、排程段、望远镜 / 终端占用 | `sessions`、`nights`、`telescopes`、`instruments`、`meta` |

- 每条记录带 `owner`（`catalog` / `plan`），写入前由所属侧校验，任一侧都写不进对方那份。
- 两侧各自开自己的 Dexie 事务：一侧写入失败只回滚自己那份，另一侧已提交的数据不连坐。
- 排程段带排定时固化的目标约束快照 `targetSnapshot`（阈值 / 曝光 / 累计时长 / 滤镜 + `revision`）。协调员只在改动这些**排程约束字段**时才让目标 `revision +1`；改名称、坐标、备注不影响已排时段。
- 目标约束一改动，引用它且尚未拍完（待执行 / 进行中）、快照 revision 落后的排程段自动转为 **待重排**，进队列等排程员处理；**已完成 / 因云取消的段照旧留住**。该联动在编排库自己的事务里完成，若失败（如编排库不可写）目标侧改动仍保留，下次启动由 `reconcileSessionSnapshots` 补核对。
- 单台望远镜单个观测夜容量为 720 分钟（`TELESCOPE_NIGHT_CAPACITY_MINUTES`，18:00–次日 06:00）。新增 / 重排段时若各已确认段合计超出容量，该段自动转为 **排队顺延** 挂到后续观测夜等待重排，绝不挤掉或挪动任何已确认段。待重排 / 排队顺延段不占容量、不进时间轴 / 占用网格 / 导出清单。
- 排程员重排待重排段（重新指定夜 / 望远镜 / 时段或确认回待执行）时，快照按目标当前参数重新固化。
- **旧 v2 混库升级（回填再启用）**：启动时若检测到旧 `gbobsplan-db`，只读打开并按表归属回填到两个新库——目标补 `owner=catalog` 与 `revision=1`；观测夜 / 望远镜 / 终端补 `owner=plan`；排程段补 `owner=plan` 与按旧目标当前值固化的快照（revision=1，避免“无改动却失效”）。两侧各用各的事务回填、各自落迁移标记，**两侧都成功后才删除旧库**；中途失败保留旧库，下次打开可安全重试（put 幂等）。
- 首次打开（两侧均无数据）时各自写入示例数据（12 个观测目标、5 个观测夜、4 台望远镜、4 台终端、14 段排程，含 1 处设备冲突与 1 条改期记录）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
- 运行时冒烟验证（含 v2 回填、阈值失效、容量顺延、归属拦截、联动补核对）：`cd frontend && npm run smoke`（基于 `fake-indexeddb`，dev 依赖）。

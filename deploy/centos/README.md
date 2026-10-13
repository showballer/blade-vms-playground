# BladeVMS：CentOS Stream 9 部署与现有数据迁移

本目录提供 `115.190.201.41` 的部署配置。它不是自动部署脚本；仓库中存在配置文件不代表服务器已安装、已启动或已完成验收。服务器操作由部署负责人执行。

本次方案为**迁移现有 Web 数据**，保留账号、用户 UUID、租户、密码摘要、会话、API 令牌、业务记录、审计及旋转原始数据。不重新初始化账号，不重置现有密码。

## 运行约定

| 项目 | 路径或约定 |
| --- | --- |
| 正式 Web / API 入口 | `http://115.190.201.41:3000` |
| 80 端口 | 固定 308 跳转到上述入口；安全组未开放时不影响 3000 |
| 发布目录 | `/opt/bladevms/releases/<release-id>` |
| 当前版本 | `/opt/bladevms/current`，指向上述发布目录的软链接 |
| Node | `/usr/bin/node`，当前部署约定版本 `v20.19.6` |
| Web 工作目录 | `/opt/bladevms/current/apps/web` |
| 内部监听 | `127.0.0.1:3210`，不对外开放 |
| 服务身份 | Unix 用户及组 `bladevms`，禁止交互登录 |
| 运行环境 | `/etc/bladevms/web.env`，`root:bladevms`，权限 `0640` |
| 分析 Python | Python 3.12 venv：`/opt/bladevms/venv/bin/python` |
| 桌面采集与上传暂存 | `/var/lib/bladevms/web-captures`，`bladevms:bladevms`，目录权限 `0700` |
| 旋转原始数据 | `/var/lib/bladevms/web-rotation`，`bladevms:bladevms`，目录权限 `0700` |
| 数据库 | 复用现有 MySQL 容器；仅 `blade_vms_playground` 库及 `blade_vms_app` 账号 |
| Windows 下载（可选） | `/var/lib/bladevms/downloads/BladeVMS-Setup-1.3.0-x64.exe` |

Next 同时提供 Web 页面和 API。systemd 直接启动一个 Node 进程，不使用 PM2 cluster、多个 Web 副本或另一个 `npm start` 守护进程。旋转分析按请求启动短期 Python 子进程；无需启动采集 HTTP 服务或真实设备连接。

`APP_ORIGIN` 固定为 3000 入口。80 只负责跳转，不能改成另一个直接反代入口后仍沿用单一 `APP_ORIGIN`：浏览器写请求会受到来源校验。以后切换 HTTPS 域名时，应一起调整环境变量、Nginx 和访问地址。

## 配置文件

| 文件 | 安装位置 | 作用 |
| --- | --- | --- |
| `bladevms-web.service` | `/etc/systemd/system/bladevms-web.service` | Web / API 自启动、故障重启、资源与写入路径限制 |
| `bladevms-backup.service` | `/etc/systemd/system/bladevms-backup.service` | 单次检查业务快照计划，执行后退出 |
| `bladevms-backup.timer` | `/etc/systemd/system/bladevms-backup.timer` | 每分钟触发上述检查 |
| `nginx-bladevms.conf` | `/etc/nginx/conf.d/bladevms.conf` | 80 跳转；3000 代理至 3210 |
| `web.env.example` | 手工补全后安装到 `/etc/bladevms/web.env` | 环境变量模板，无真实密码 |

Nginx 接收上限为 144 MiB，为应用的 128 MiB CSV / CSV.GZ 文件上限留下请求封装余量；应用仍独立限制 XLSX 为 16 MiB。上游读取和发送超时为 200 秒，应用分析任务自身为 180 秒。请求和响应关闭代理缓冲，保留下载的流式响应、`Range` / `206` 及 Next 响应流。参见 [Nginx 代理指令](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) 与 [请求体大小限制](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)。

## 1. 安装前检查与旧服务记录

先确认操作系统、磁盘空间、端口占用、现有 Nginx 配置、MySQL 容器身份及其宿主机访问端口。不要停止或重建其他容器，不执行本地开发用的 `scripts/setup-mysql.mjs`，不修改其他 schema、MySQL 全局账号或服务器防火墙的既有规则。

本次部署的先前操作记录：旧容器 `soniva-admin` 已执行 `docker stop`，容器检查快照已保存在 `/opt/bladevms/rollback/soniva-admin-before.json`。执行部署时仍须重新确认当前状态；保留该容器、镜像、卷和检查快照，不删除它们。

```sh
cat /etc/centos-release
systemd --version
/usr/bin/node --version
python3.12 --version
free -h
df -h /opt /var/lib
ss -ltnp
docker ps -a --filter name=soniva-admin
test -s /opt/bladevms/rollback/soniva-admin-before.json
```

当前容量规划依据约 3.7 GiB RAM、无 swap、现有 MySQL 约 500 MiB。Web 的 `MemoryMax=2500M` 覆盖 Node、原生缓冲及最多两个 Python 子进程；`--max-old-space-size=1536` 仅限制 Node 的旧生代堆。未配置 CPUQuota。上限是防止服务耗尽宿主机内存的边界，不是每个分析任务的独立配额，也不保证所有大文件都能同时完成；上线后观测实际峰值再调整。参见 [systemd 252 资源控制](https://github.com/systemd/systemd/blob/v252/man/systemd.resource-control.xml)。

## 2. 准备发布目录及运行环境

发布包必须由目标 Linux 架构兼容的依赖构建，不能复制 macOS 的 `node_modules` 或 Python venv。安装 Node 依赖后运行 `npm run build -w @blade/web`；Web 部署不需要运行桌面打包。当前 Next 配置未启用 standalone 输出，需要保留完整运行布局：根 `node_modules`、根与工作区 package 文件、`apps/web/.next`、Web 配置/静态资源、工作区依赖、`scripts/backup-worker.mjs`、`scripts/migrate.mjs`、`scripts/seed-data.mjs`、完整 `services/acquisition/blade_acquisition` 及 Web Python 依赖清单。

发布包不包含本地 `.env.local`、数据库凭证、桌面用户认证文件、开发 venv 或采集记录目录。记录实际源码版本、依赖锁文件及发布包 SHA-256；未提交改动构建的发布包也要留存清单，不能仅用 Git HEAD 代替发布内容标识。

下列目录初始化命令在服务器由 root 执行；已存在的账号先检查再复用：

```sh
getent group bladevms || groupadd --system bladevms
id bladevms || useradd --system --gid bladevms --home-dir /var/lib/bladevms --shell /sbin/nologin bladevms
install -d -o root -g root -m 0755 /opt/bladevms /opt/bladevms/releases
install -d -o root -g root -m 0700 /opt/bladevms/rollback
install -d -o root -g bladevms -m 0750 /etc/bladevms /var/lib/bladevms
install -d -o bladevms -g bladevms -m 0700 /var/lib/bladevms/web-rotation /var/lib/bladevms/web-captures
install -d -o root -g bladevms -m 0750 /var/lib/bladevms/downloads
```

将完整发布包解压到新的 `/opt/bladevms/releases/<release-id>`，不要覆盖运行中的发布目录。代码和 venv 由 root 持有、服务用户可读/执行；不要将整个发布目录赋予服务用户写权限。首次创建 venv 后按该发布的 Web 专用清单安装：

```sh
python3.12 -m venv /opt/bladevms/venv
/opt/bladevms/venv/bin/python -m pip install --index-url https://pypi.org/simple -r '/opt/bladevms/releases/<release-id>/services/acquisition/requirements-web.txt'
/opt/bladevms/venv/bin/python -c 'import numpy, scipy, pydantic; print("analysis dependencies ready")'
```

命令中的 `<release-id>` 是实际发布目录名，执行前替换。Web 只需要分析依赖；不要为了 Web 部署改装或启动采集 HTTP 服务依赖。升级 venv 前记录已安装版本并保存可回退版本，避免代码回退后依赖仍不兼容。

补全 `web.env.example` 的专用数据库密码及现有 MySQL 宿主机端口，保存为 `/etc/bladevms/web.env`。不要直接复制模板后带占位密码启动；不要把文件内容打印到终端、提交到 Git 或写入发布包。完成后设置 `root:bladevms`、`0640`。本次迁移**不设置 `BOOTSTRAP_PASSWORD`**。

待数据导入完成后设置 `current`。先记录旧链接目标，使用同目录临时软链接加原子重命名替换；例如 `current.next` 指向本次 release 后执行 `mv -Tf /opt/bladevms/current.next /opt/bladevms/current`。变更链接后必须重启 Web，运行中的 Node 不会自动切换版本。

## 3. 迁移 SQL 与旋转原始数据

1. 为源 Web 安排短暂停写窗口，先停止接收新的导入/修改并等待现有旋转任务结束，再停止源 Web 和业务快照 worker。SQL 和旋转文件须属于同一冻结时点。不要一边继续写入，一边分别拷贝两份数据。
2. 使用 MySQL 官方客户端完整导出 `blade_vms_playground`，至少覆盖 `users`、`sessions`、`records`、`audit_logs`、`sync_imports`，并包含源库存在的触发器/例程/事件。仅导出该库，不导出 `mysql` 等系统 schema。凭证放权限为 `0600` 的客户端配置文件中，不放命令行密码参数。
3. 将源端实际 `BLADE_ANALYSIS_DATA_DIR` 整个目录打包。未覆盖环境变量时，当前代码默认位置是仓库 `.data/web-rotation`。保留所有按用户 UUID 和租户生成的哈希子目录、原始分块、索引和清单，不重新命名或扁平化目录。无旋转数据时，记录“源目录为空/尚未创建”，不要伪造记录。
4. 对 SQL 压缩文件和旋转目录归档分别生成 SHA-256，经加密传输后在服务器再次校验；备份文件仅管理员可读。数据库含认证摘要及令牌摘要，不能作为普通公开构建产物分发。
5. 由数据库管理员在现有 MySQL 容器内创建或确认独立 `blade_vms_playground` 库及 `blade_vms_app` 账号。账号仅授权该库；宿主机到容器的访问来源按实际网络配置。应用只连接宿主机 loopback 暴露的数据库端口，不新增公网数据库监听。先检查授权和目标库是否为空；如果目标库已有数据，先完整备份并人工核对来源，禁止直接覆盖。
6. 导入 SQL 到专用库，恢复原始数据到 `/var/lib/bladevms/web-rotation`。恢复前确认归档成员都位于数据目录内；恢复后归属 `bladevms:bladevms`，目录 `0700`、普通数据文件 `0600`。不要把源机器的 UID/GID 原样用作目标服务身份。
7. 对比源/目标五张表行数、按租户/业务类型的记录数、用户 UUID 与租户映射；安全地核对密码摘要、令牌摘要及有效期是否保持一致，不在终端输出摘要。核对旋转目录文件数量、总字节和文件 SHA-256 清单，确认用户目录仍能被对应账号读取。
8. 确认 `users` 非空后才执行下面的结构检查；这不是空库初始化。`migrate.mjs` 只在空用户表时创建演示账号和演示数据，因此不能先执行脚本再覆盖导入，也不能添加 `BOOTSTRAP_PASSWORD` 来绕过漏导入。

在 `current` 指向完整发布且环境文件已就绪后，用服务身份执行：

```sh
runuser -u bladevms -- env -i PATH=/usr/bin:/bin /usr/bin/node --env-file=/etc/bladevms/web.env /opt/bladevms/current/scripts/migrate.mjs
```

预期输出包含“表结构已检查；现有用户和业务数据保留”。出现初始账号创建信息时应停止发布并检查导入过程。

迁移保留会话行和 API 令牌摘要，但浏览器原地址的 Cookie 不会自动转到新 IP；浏览器在新地址仍需用原密码登录。不要因地址变更而重置密码或重新生成账号 UUID。

## 4. 安装服务与反向代理

先创建 Next 的可写缓存路径。systemd 的 `ProtectSystem=strict` 只允许分析目录、采集目录和该缓存目录持久写入；缺少目录会使服务启动失败。

```sh
install -d -o bladevms -g bladevms -m 0700 /opt/bladevms/current/apps/web/.next/cache
chown -R bladevms:bladevms /opt/bladevms/current/apps/web/.next/cache
install -o root -g root -m 0644 /opt/bladevms/current/deploy/centos/bladevms-web.service /etc/systemd/system/bladevms-web.service
install -o root -g root -m 0644 /opt/bladevms/current/deploy/centos/bladevms-backup.service /etc/systemd/system/bladevms-backup.service
install -o root -g root -m 0644 /opt/bladevms/current/deploy/centos/bladevms-backup.timer /etc/systemd/system/bladevms-backup.timer
install -o root -g root -m 0644 /opt/bladevms/current/deploy/centos/nginx-bladevms.conf /etc/nginx/conf.d/bladevms.conf
systemd-analyze verify /etc/systemd/system/bladevms-web.service /etc/systemd/system/bladevms-backup.service /etc/systemd/system/bladevms-backup.timer
systemd-analyze calendar '*-*-* *:*:00'
nginx -t
```

安装 Nginx 文件前备份现有配置，检查同端口的其他 server 块，避免替换其他站点。日志写入 `/var/log/nginx/bladevms-access.log` 和 `bladevms-error.log`；确认发行版现有 logrotate 的 `/var/log/nginx/*log` 规则覆盖它们，避免再安装重复轮转规则。

CentOS 若启用 SELinux，应检查 Nginx 连接 loopback 的策略及 TCP 3000 的 `http_port_t` 标签。需要时启用 `httpd_can_network_connect` 并添加尚未占用的 3000 标签；如果端口已有其他标签，先核对用途。不得以关闭 SELinux 代替正确配置。仅按当前安全组/firewalld规则开放外部 3000；80 为可选跳转入口，不开放 3210 或 MySQL 到公网。

验证配置无误后启动，先检查内部健康接口，再启用外部入口：

```sh
systemctl daemon-reload
systemctl enable --now bladevms-web.service
curl --fail --silent --show-error http://127.0.0.1:3210/api/v1/health
systemctl enable nginx
systemctl reload-or-restart nginx
systemctl enable --now bladevms-backup.timer
systemctl status --no-pager bladevms-web.service bladevms-backup.timer nginx
```

若既有环境正在运行同项目的 `npm run worker` 或其他 backup-worker 守护进程，先停用它再启用 timer。`bladevms-backup.service` 不单独 enable、不设置循环 Restart。每次 `--once` 仅检查已启用的业务计划，按北京时间和每日执行标记生成快照；不是每分钟无条件生成一个备份。同一个 oneshot 尚未退出时，timer 不会并行再启动一个实例。参见 [systemd 252 timer 语义](https://github.com/systemd/systemd/blob/v252/man/systemd.timer.xml)。

## 5. 上线验收

```sh
curl --fail --silent --show-error http://115.190.201.41:3000/api/v1/health
curl --head --silent --show-error http://115.190.201.41/
curl --fail --silent --show-error http://115.190.201.41:3000/api/desktop-download
systemctl show bladevms-web.service -p MainPID -p MemoryCurrent -p MemoryPeak -p NRestarts
systemctl list-timers bladevms-backup.timer --all
journalctl -u bladevms-web.service -u bladevms-backup.service --since '10 minutes ago' --no-pager
ss -ltnp
```

80 可达时应返回固定 `Location: http://115.190.201.41:3000/...`。除命令检查外，实际浏览器用迁移前账号登录，核对各角色权限、租户数据、既有分析记录、旋转原始数据预览及小文件导入/计算。测试写入要有明确测试记录标识并按正常功能清理；不要用批量清库脚本验收。确认只有一个常驻 Web Node 进程、3210 仅 loopback 监听、MySQL 未新增公网暴露。更新源码/部署配置/数据迁移/浏览器验收分别记录结果。

监控分析期间的内存峰值、OOM 与任务超时。若发生 OOM，Web unit 会停止其进程组并按重启策略恢复；排查上传大小与并发、宿主机容量和依赖后再调整，不以无限重启替代修复。正常发布应先等待分析任务结束；停服务会结束其 Python 子进程。

## Windows 下载和桌面统一账号边界

HTTP IP 地址可供浏览器访问 Web。当前桌面统一账号模块只接受可信 HTTPS 服务地址，HTTP 仅允许精确 loopback（`localhost` / `127.0.0.1` / `[::1]`）；因此**不能使用 `http://115.190.201.41:3000` 完成桌面统一账号绑定**。需要后续配置可信证书的 HTTPS 域名，不能通过关闭证书验证或扩大 HTTP 例外绕过。

如启用下载，将现有安装包放入下载目录，设为 `root:bladevms`、`0640`，核对文件 SHA-256，再启用环境模板中的 `BLADE_DESKTOP_WINDOWS_*` 三项并重启 Web。验证元信息、HEAD、首段 Range 及实际下载；例如已安装文件时下列请求应返回 `206` 和正确 `Content-Range`：

```sh
curl --fail --silent --show-error --dump-header /tmp/bladevms-download-headers.txt --header 'Range: bytes=0-1023' --output /tmp/bladevms-download-prefix.bin http://115.190.201.41:3000/api/desktop-download/windows
```

`1.3.0` 仅代表已有 Windows 安装包可供下载；本次部署没有据此声称已重新打包、签名或验证包含当前改动的新版 Windows 客户端。未安装文件时，元信息应报告不可用，不能把页面上的下载入口当作安装包已交付的证据。

## 备份、更新与回退

业务 timer 生成的是同一 MySQL 中 `records(kind='backups')` 的业务快照，不包含完整账号/会话/审计/同步表，也不包含旋转原始文件。**它不能替代完整 SQL 备份和 `/var/lib/bladevms/web-rotation` 备份**；数据库或磁盘损坏时，同库业务快照也可能丢失。另行安排完整备份、外部保留副本及恢复演练，并保护运行环境文件；不要把凭证和公开发布包一起归档。

常规更新使用新 release、备份当前 SQL/旋转目录、验证依赖兼容后切换软链接和重启。记录旧链接及配置文件；代码回退不等于数据库回退，涉及数据变化时先分析兼容性，禁止直接覆盖回退期间新增的数据。

本次恢复旧 `soniva-admin` 服务的顺序为先停止新服务和占用 3000 的 Nginx，再启动旧容器：

```sh
systemctl disable --now bladevms-backup.timer
systemctl stop bladevms-backup.service
systemctl disable --now bladevms-web.service
systemctl disable --now nginx
docker start soniva-admin
docker ps --filter name=soniva-admin
ss -ltnp
```

上述完整回退适用于本次由 BladeVMS 启用的 Nginx；如果上线后 Nginx 增加了其他业务站点，先移除 BladeVMS server 配置并验证/重载，使 3000 释放，避免停掉其他站点。参考 `/opt/bladevms/rollback/soniva-admin-before.json` 核对旧容器端口和状态，按旧应用自身的健康检查验收。保留新库、新原始数据、发布目录和日志供排查，不删除 MySQL 数据，不把旧应用回退当作撤销 BladeVMS 数据迁移。

## 2026-10-13 联动功能的增量升级

此节是当前源码的部署要求，不代表线上已升级。保留现有数据库和数据目录；不运行 `db:setup`，不重新导入本地数据库。

- 发布前备份现有 SQL、旋转数据，并在后续备份中纳入完整 `web-captures`（包括 incoming、complete、latest.json）。业务快照不等于原始二进制文件备份。
- `users` 新增可空 `deleted_at`；可单独调用 `scripts/migrations/user-soft-delete.mjs` 的 `migrateUserSoftDelete(connection)`，或在确认现有用户不为空后使用上述 `migrate.mjs`。它保留账号和历史业务记录。
- 以现有服务身份执行 `node --env-file=/etc/bladevms/web.env /opt/bladevms/current/scripts/migrate-captures.mjs`，只创建 `captures` 表，不初始化账号。
- 环境新增 `BLADE_CAPTURE_DATA_DIR=/var/lib/bladevms/web-captures`，创建目录并给服务用户 0700 权限。更新 systemd `ReadWritePaths` 后执行 daemon-reload，再切换已构建发布目录并重启。只有环境变量而未放开目录写权限会导致上传失败。
- 现有 Nginx 的 144 MiB / 200 秒限制足够容纳 4 MiB 原始分段与最长 180 秒完整性校验；保留认证转发和禁用代理缓存。每条原始记录总量上限 64 GiB，不代表可用磁盘配额；上传失败时保留本机源数据。
- Web 与新版客户端需配套发布。仅更新 Web，不会让旧 1.4.0 客户端产生推送；仅更新客户端而未迁移 Web，会显示同步失败，但本机采集和保存应继续。
- 回退代码时保留新增表、字段和原始目录，不删除已上传数据；旧代码不使用新增字段即可继续原有功能。

操作流程和权限见 [桌面与 Web 联动](../../CLOUD_CAPTURE_FLOW.md)。

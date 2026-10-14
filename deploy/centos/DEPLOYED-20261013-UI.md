# 2026-10-13 健康监测与溯源界面增量发布

- 用户授权：将本轮界面优化部署至 115 服务器。
- 正式入口：http://115.190.201.41:3000/
- 切换时间：2026-10-13 16:50:28（Asia/Shanghai）。
- 当前 release：`/opt/bladevms/releases/20261013-health-ui`。
- 前一 release：`/opt/bladevms/releases/20261008-initial`，保留可回退。
- Next Build ID：`s53sDsxoS1CgVWznDuSku`。

## 发布范围

以线上旧 release 完整复制为基础，只覆盖以下 8 个界面文件，在 Linux 服务器使用原依赖锁文件和运行依赖重新构建：

- `packages/ui/src/web-screens.tsx`
- `packages/ui/src/charts.tsx`
- `packages/ui/src/desktop-screens.tsx`
- `packages/ui/src/health-trends.tsx`
- `packages/ui/src/styles.css`
- `packages/ui/src/health-layout.css`
- `packages/ui/src/health-trends.css`
- `packages/ui/src/signal-analysis.css`

实现监测筛选框加宽与响应式换行、环形评分中心数字与满分同组布局、未完整判定的中性色、特征指标间距、趋势操作置顶、溯源独立查看工具栏及缩放条/坐标轴/色条空间。

后端 API、数据库 schema、服务配置和环境变量均未变更。未覆盖本地其他尚未上线的采集联动、用户删除等功能。Windows 下载继续为 1.4.0，此次未重新发布客户端。

## 备份与验收

- 备份目录：`/opt/bladevms/rollback/20261013-health-ui`，root 专用，含数据库 SQL、旋转原始目录、运行环境及 systemd 配置；不在本文记录凭据。
- 发布清单：release 下 `UI-RELEASE.json`，记录八文件 SHA-256；增量包 SHA-256：`01ebffacf673fa8e4ad14cf6cc4882a94c7f71776bec06a49a1670106a1cc156`。
- Linux 生产构建和 TypeScript 检查通过，切换后 Web/Nginx/backup timer active。
- 公网页面 200，健康检查数据库正常；10 个公开 CSS/JS 资源读取成功，检查了本轮特征选择器及组件标识。
- 浏览器实际重新加载线上登录页，新样式加载且无控制台错误；本次未登录业务账号进行线上页面交互验收。交互和 1920/1440/1024/390 宽度验收已在本地隔离数据完成。
- 下载元信息仍为 1.4.0 / 199471034 字节，安装包 HEAD 返回 200。
- 本地发布证据：`artifacts/ui-release-20261013/`。

## 代码回退

如需回退，将 `/opt/bladevms/current` 原子切回上述前一 release，重启 `bladevms-web.service` 并检查 `/api/v1/health`。本次无数据库迁移，代码回退不需要恢复 SQL 或覆盖回退期间新增数据。

# Web 旋转测振

Web「旋转测振」复用采集服务的 `calculate_rotation`，支持阶次谱、周期同步平均、多点复数振型、悬臂梁候选匹配和叶片动画。Python 作为短生命周期的独立分析进程运行，无需启动 Electron，不连接设备或开启激光。

## 本地环境与部署

- 默认 Python：`services/acquisition/.venv/bin/python`；Windows 为 `.venv/Scripts/python.exe`。未找到时使用 `python3` / `python`。
- `BLADE_ANALYSIS_PYTHON`：可配置部署机器上的 Python 可执行文件绝对路径。Web 单独部署时安装 `services/acquisition/requirements-web.txt` 中依赖；完整设备采集服务仍使用 `requirements.txt`。
- `BLADE_ANALYSIS_DATA_DIR`：可配置持久数据目录；默认项目 `.data/web-rotation`。部署时同时保留 `services/acquisition` 目录。
- Python 可执行文件、虚拟环境和数据目录属于运行期资源，路径调用用 Turbopack 忽略标注排除静态资源追踪。生产构建不会复制本机虚拟环境；部署机器仍需准备上面的 Python 环境和采集服务源码。
- 数据按 Web 账号与课题组的 SHA-256 目录隔离。界面和请求不接受服务器文件路径；账号沿用 Web 登录会话。
- 每个 Node 进程最多同时运行 2 个上传/分析任务，每账号同时 1 个；上传和分析各有 180 秒上限。多实例部署需共用账号排队机制或固定路由，当前为单实例本机部署。

## 文件格式

支持多测点 XLSX、UTF-8 CSV、Gzip 压缩 CSV（`.csv.gz`）。桌面导出的 CSV/GZ 可直接导入。XLSX 上限 16 MB，每测点最多 100 万点，每文件最多 8 点、合计 200 万样本及 400 万个数据单元格；工作表和共享文本按流解析，解压后上限 96 MB。CSV/GZ 上传上限 128 MB，CSV 解压后最多 512 MB，最多 800 万个连续样本；上传和 CSV 解析均按流处理。

时间列为 `time_s`（秒）；速度列为 `velocity_m_s` / `velocity_mm_s`。位移列为 `displacement_m` / `displacement_mm` / `displacement_um`，经差分换算为 m/s，换算依据会保存。通用 `value` 列要求导入时明确指定物理量和单位，不按幅值猜单位。

桌面导出首行协议：

```text
# BladeVMS {"format":"blade-vms-csv-1","source":"simulation","simulation":{"scenario":"baseline"},"sampleRate":1000,"samples":10000,"unit":"m/s","point":"P1","position":0.6,"rpm":1200}
time_s,velocity_m_s,RSSI_percent,overrange
```

`source=polytec_ivs500` 标为实测导入。`source=simulation` 或有效 `simulation` 元数据始终保留模拟标签；界面的来源选择不能覆盖为实测。导出样本数、采样率与数据不符时拒绝完整入库。缺 RSSI 使用空值，超量程为 0/1。原文件及质量列保存，不静默删除低回波样本；超量程区间由现有分析算法明确拒绝，用户可选择未超量程的连续区间。

同事的 `Pn_xL...` 工作簿会识别测点位置、RPM、quality、RSSI、keyphase 等列；来源标题中的 simulation 标记会保留。

## API

- `GET /api/v1/rotation/recordings`：读取当前账号记录。
- `POST /api/v1/rotation/import?filename=...&source=...&quantity=...&unit=...`：请求体为文件二进制流，`Content-Type: application/octet-stream`。
- `POST /api/v1/rotation/analyze`：请求体为 `RotationRequest` JSON。

导入和计算要求分析写权限，并记录审计；结果可导出完整 JSON，含源文件哈希、数据来源、质量统计、算法版本和全部图表数据。

## 计算范围

仍采用用户给定的恒定 RPM 与 t=0 共同相位假设。变转速输入会额外提示；输入键相信号会保留，但本算法尚不将其作为真实相位触发。候选弯曲模板匹配不等同于实验模态确认。模拟数据的输出用于调试，不作为实测结论。

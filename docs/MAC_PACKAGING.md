# Mac 独立客户端打包

在 Apple Silicon Mac 上使用 ARM64 Node.js 22+、Python 3.12+ 和 Xcode Command Line Tools。安装后的客户端不需要 Python 或项目源码；目前仅提供 ARM64 测试包。

## 首次准备

在仓库根目录运行：

```sh
npm ci
python3 -m venv services/acquisition/.venv-build
services/acquisition/.venv-build/bin/python -m pip install -r services/acquisition/requirements-build.txt
```

按 [Mac SDK 构建说明](MAC_SDK_BUILD.md) 准备 `apps/desktop/resources/acquisition/vendor`。该目录需要包含 ARM64 的 `libDeviceCommunication.dylib`、`licenses` 和 `source`，均不提交 Git。不能用 Windows DLL 替代。

## 生成安装包

```sh
npm run package:mac --workspace=@blade/desktop -- --output "$HOME/Downloads"
```

也可直接运行脚本，指定已经安装构建依赖的 Python 和 SDK 目录：

```sh
node scripts/package-macos.cjs --python /absolute/path/to/python --sdk-dir /absolute/path/to/vendor --output /absolute/output/directory
```

脚本会构建当前工作区的界面和采集服务，收集依赖许可，生成独立 `.app` 和 DMG。它保留运行库的相对符号链接，验证应用签名、内置 SDK 加载及无系统 Python 的服务启动，再验证 DMG 并输出 SHA-256。验证不连接设备、不移动转盘、不开始真实采集。

输出包括 DMG、安装与登录说明、SHA-256 文件。每次构建生成独立的首次登录密码，仅写入说明文件；不会读取、打包或覆盖开发者的 `bootstrap-admin.json`、本机账号或统一账号绑定；标准包不包含采集记录。已有本机账号不会重置，首次使用需改密码。

构建暂存目录和日志位于 Git 忽略的 `artifacts/mac-package-*`，不提交安装包、SDK、密码说明或采集数据。默认输出目录为 `apps/desktop/release`。测试包采用 ad-hoc 签名，未进行 Apple 公证；系统阻止首次打开时按说明操作，不需要关闭系统安全功能。设备网络与现场采集另行验证。

## 定制包：预置指定采集任务

在标准命令后显式提供记录库目录和完整任务名：

```sh
node scripts/package-macos.cjs \
  --recordings-dir /absolute/path/to/recordings \
  --task-name '10241804-叶片2-P1至P5' \
  --output "$HOME/Downloads"
```

只有该任务的已完成记录会进入定制包，包括波形分块、点位元数据和原始导出来源说明。不会打包整个用户目录，也不会携带账号、密码、Web 绑定、上传队列、采集日志索引或现场设备配置。实际记录、SDK 和安装包仍放在 Git 忽略目录，不提交到仓库。

定制包首次启动时校验清单和文件 SHA-256，将记录导入当前用户的本机记录库；采集服务随后重建索引。重复启动不重复导入，用户已删除的预置记录不会重新出现，同编号已有记录不覆盖。导入异常保存在数据目录的 `bundled-recordings-error.json`，原有记录仍可使用。

登录后进入“本机记录”→“叶片采集汇总”，选择预置任务即可查看。它们保留原始诊断属性及质量标记，不会被改成正式测量数据，也不会因预置而自动上传 Web。若数据来自 CSV 导入，CSV 中不存在的原始 ADC 整数码仍标记为不可用。

定制安装包文件名包含 `custom`。首次登录密码仅在随包的“安装与登录说明.txt”内，已有本机账号沿用原密码。

预置模块离线回归测试（临时目录，不连接设备）：

```sh
node --test scripts/test-field-bundled-recordings.cjs
```

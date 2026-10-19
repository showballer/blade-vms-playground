# Polytec macOS SDK 构建工具

仅针对已验证的 Apple Silicon（arm64）本地构建。需自行安装 Xcode command-line tools、Python 3、CMake 与 Boost；脚本不会安装依赖或访问设备。本次验证版本为 Apple Clang 21.0.0、CMake 4.4.4、Boost 1.92.0。

在仓库根目录执行：

```bash
python3 scripts/polytec-macos/build.py --sdk /absolute/path/to/122
```

默认输出为已忽略的 `apps/desktop/resources/acquisition/vendor`，构建日志保留在 `artifacts/polytec-macos-*`。可通过 `--output` 指定其他目录、`--boost-prefix` 指定现有 Boost、`--work-dir` 指定新的构建目录。已有 Mac SDK 输出时默认拒绝覆盖，确认需更新后传 `--replace`；不会清空其他 SDK 文件。

输出包含 `libDeviceCommunication.dylib`、构建元信息、GPL/LGPL/Boost/GSL 许可，以及原始 SDK 源码压缩包、兼容补丁和复现脚本。原始 SDK 目录始终不变；不要将生成的二进制或完整厂商源码再添加进 Git。

从分发的源码材料复现时，先解开 `DeviceCommunication-original-source.tar.gz`，再执行：

```bash
python3 build.py --sdk ./DeviceCommunication-original --output ./rebuilt-vendor --work-dir ./build-work
```

`macos-compat.patch` 是唯一源码补丁，作用见 `NOTICE.md`。`smoke.py` 只检查 C API 导出与内存 payload 往返，不执行网络、串口、激光或采集动作。构建成功不能替代真机验证，也不代表厂商已经正式支持 macOS。

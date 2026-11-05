# Polytec DeviceCommunication SDK 使用说明

本文整理项目中随附的 Polytec DeviceCommunication SDK（`DeviceCommunication.dll` / macOS 构建的 `libDeviceCommunication.dylib`）的使用方法，以及 IVS-500 / VibroFlex 类设备常见参数的含义。

文档依据：

- 原厂 SDK 源码包：`vendor/polytec/source/DeviceCommunication-2021-source.zip`
- 项目设备配置封装：`services/acquisition/blade_acquisition/device.py`
- 项目采集封装：`services/acquisition/blade_acquisition/receiver.py`

SDK 是设备通信库，不是一个只负责“开关激光”的库。它包含两部分能力：

1. **Device Communication**：通过 UDP/TCP/串口读取、修改设备配置。
2. **Data Acquisition**：打开数据采集句柄，读取速度、位移、加速度、RSSI、触发和有效性等通道。

SDK 命令是否可用由设备型号、传感器头、固件、许可证和当前配置决定。SDK 头文件中存在某个命令，并不代表所有设备都支持该命令；发送命令前必须使用 `PolyHasDevice` / `PolyHasCommand` 检查，并以设备返回的选项为准。

## 一、通信模型

### 1. 逻辑设备

Polytec 控制器内部按逻辑设备组织命令。项目中常用的设备编号如下：

| 常量 | 编号 | 作用 |
|---|---:|---|
| `PTCDeviceType_Controller` | `1` | 控制器、系统信息、网络和全局状态 |
| `PTCDeviceType_SensorHead` | `2` | 传感器头、激光、聚焦、回波信号 |
| `PTCDeviceType_VelocityDecoderDigital` | `7` | 速度解码器 |
| `PTCDeviceType_DisplacementDecoderDigital` | `9` | 位移解码器 |
| `PTCDeviceType_SignalProcessing` | `18` | DAQ 模式、采样、触发和通道配置 |
| `PTCDeviceType_AccelerationDecoderDigital` | `22` | 加速度解码器 |

命令调用的基本参数是：

```text
(communicationHandle, deviceType, deviceNumber, deviceCommand, payload)
```

本项目目前使用设备号 `0`。如果设备有多个同类逻辑设备，必须先从设备列表读取实际编号，不能硬编码假设。

### 2. 命令访问类型

每条命令可能支持以下一种或多种访问方式：

| 访问 | 含义 |
|---|---|
| `Get` | 读取当前值 |
| `Set` | 写入当前值 |
| `GetDevInfo` | 读取允许范围、可用索引或能力信息 |
| `GetValueList` | 读取面向用户的选项名称，例如 `1 m/s, 2 m/s` |

量程、带宽、滤波器等“列表型参数”通常不是直接写入物理数值，而是用 `GetValueList` 取得字符串列表，再用列表中的完整字符串执行 `Set`。

## 二、标准调用流程

建议每次设备配置操作都遵循以下顺序：

1. 加载与设备架构匹配的动态库。
2. 打开 UDP 或 TCP 通信。
3. 检查逻辑设备和目标命令是否存在。
4. 读取当前值和设备支持的范围/选项。
5. 如需写入，取得写锁（设备或固件要求时），发送 `Set`。
6. 重新读取并核对实际值。
7. 关闭通信句柄。

配置读取不应使用程序内置的默认值替代设备返回值。设备不支持某项时应显示“未支持/未知”。

### 1. Python `ctypes` 基本声明

项目的采集服务使用 Python `ctypes` 加载 DLL。以下是最小化示例，实际项目还需要绑定所有调用到的函数并检查返回码：

```python
import ctypes as C

api = C.CDLL(r"C:\BladeVMS\DeviceCommunication.dll")

api.PolyOpenUdpEthernetCommunication.argtypes = [
    C.POINTER(C.c_int), C.c_char_p, C.c_int
]
api.PolyOpenUdpEthernetCommunication.restype = C.c_int

api.PolyCloseCommunication.argtypes = [C.c_int]
api.PolyCloseCommunication.restype = None

api.PolyHasCommand.argtypes = [
    C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_bool)
]
api.PolyHasCommand.restype = C.c_int

api.PolySendGetInt16.argtypes = [
    C.c_int, C.c_int, C.c_int, C.c_int, C.POINTER(C.c_int16)
]
api.PolySendGetInt16.restype = C.c_int

api.PolySendSetInt16.argtypes = [
    C.c_int, C.c_int, C.c_int, C.c_int, C.c_int16
]
api.PolySendSetInt16.restype = C.c_int
```

项目中定义的常用常量：

```python
SENSOR_HEAD = 2
VELOCITY_DECODER = 7
SIGNAL_PROCESSING = 18

LASER_ON = 46
RANGE = 10
BANDWIDTH = 18
TRACKING_FILTER = 20
```

### 2. 打开和关闭通信

```python
handle = C.c_int()
code = api.PolyOpenUdpEthernetCommunication(
    C.byref(handle), b"192.168.106.90", 1500
)
if code != 0:
    raise RuntimeError(f"open failed: {code}")

try:
    # 在这里进行 Has/Get/Set 操作
    pass
finally:
    api.PolyCloseCommunication(handle.value)
```

项目使用 UDP 配置通信；SDK 也提供 `PolyOpenTcpEthernetCommunication`。设备地址、通信方式和超时必须与现场网络及固件能力匹配。打开通信成功只表示控制器响应了握手，不代表目标命令一定支持。

### 3. 检查命令支持

```python
supported = C.c_bool()
code = api.PolyHasCommand(
    handle.value, SENSOR_HEAD, 0, LASER_ON, C.byref(supported)
)
if code != 0:
    raise RuntimeError(f"capability check failed: {code}")
if not supported.value:
    raise RuntimeError("设备不支持激光控制命令")
```

如果需要枚举设备内部的全部逻辑设备和命令，可以使用控制器的 `DeviceList / 32` 和每个逻辑设备的 `CommandList / 34`。项目的正常业务路径不开放任意命令转发，而是采用固定的、经过校验的命令白名单。

### 4. 读取和写入整数型参数

```python
def get_int16(device, command):
    value = C.c_int16()
    check(api.PolySendGetInt16(
        handle.value, device, 0, command, C.byref(value)
    ))
    return value.value

def set_int16(device, command, value):
    check(api.PolySendSetInt16(
        handle.value, device, 0, command, C.c_int16(value)
    ))

laser = get_int16(SENSOR_HEAD, LASER_ON)
set_int16(SENSOR_HEAD, LASER_ON, 1)
if get_int16(SENSOR_HEAD, LASER_ON) != 1:
    raise RuntimeError("激光开启未读回确认")
```

整数型命令的值可能是布尔值、枚举索引、位置值、块大小或采样点数，不能仅根据 `int16` 类型推断含义。必须查看具体命令定义。

### 5. 读取列表型参数

量程、带宽和滤波器使用 item-list 接口：

```python
def item_list(device, command, available=False):
    buffer = C.create_string_buffer(8192)
    fn = (api.PolyItemListGetAvailableItems
          if available else api.PolyItemListGetCurrentItem)
    check(fn(handle.value, device, 0, command, buffer, len(buffer)))
    return [x.strip() for x in buffer.value.decode().split(",") if x.strip()]

current = item_list(VELOCITY_DECODER, RANGE)[0]
options = item_list(VELOCITY_DECODER, RANGE, available=True)

if "1 m/s" in options:
    check(api.PolyItemListSetCurrentItem(
        handle.value, VELOCITY_DECODER, 0, RANGE, b"1 m/s"
    ))
    if item_list(VELOCITY_DECODER, RANGE)[0] != "1 m/s":
        raise RuntimeError("速度量程读回不一致")
```

真实设备返回的字符串可能包含单位、前缀或不同的小数位。不要自行拼接字符串或把选项位置当成固定索引；应使用设备刚刚返回的完整选项值。

### 6. 读写浮点数和字符串

SDK 还提供以下高层接口：

| C API | 典型用途 |
|---|---|
| `PolySendGetFloat` / `PolySendSetFloat` | 模拟触发电平、ASE 参数等 |
| `PolySendGetInt32` / `PolySendSetInt32` | DAQ 块大小、预触发样本等 |
| `PolySendGetString` / `PolySendSetString` | 网络地址、名称、字符串状态 |
| `PolySendGetDevInfoRange` | 读取 `int16` 最小值和最大值 |
| `PolyLastCommunicationStatus` | 获取最近一次调用的可读错误消息 |

`GetDevInfo` 的返回形式不统一：有的命令返回最小/最大值，有的返回可用索引列表，有的必须带额外标签。应按命令头文件中的 payload 类型处理。

## 三、参数说明

### A. 激光、波长和聚焦

| 参数 | 命令 | 读写 | 含义 |
|---|---|---|---|
| 激光开关 | Sensor Head / `46` | 读写 | `0` 关闭，`1` 开启。控制的是测量激光状态。 |
| 激光信号强度 | Sensor Head / `66` | 只读 | 当前回波信号电平；项目根据设备返回的上下限换算百分比。 |
| 激光波长 | Controller 或 Sensor Head / `334` | 只读 | 标称波长，例如 `1550 nm`；不能通过该命令改变物理激光波长。 |
| 聚焦位置 | Sensor Head / `38` | 读写 | 聚焦执行机构位置，范围由设备返回；不一定等于米制距离。 |
| 自动聚焦 | Sensor Head / `64` | 读写 | `0` 停止，`1` 启动。启动前需要明确确认光路安全。 |
| 自动聚焦结果 | Sensor Head / `76` | 只读 | `0` 未找到焦点，`1` 找到焦点。 |
| 自动聚焦区域 | Sensor Head / `78` | 读写 | 限定自动聚焦搜索的上下界，减少搜索时间。 |
| 聚焦进度 | Sensor Head / `174` | 读、停止 | 查询是否正在聚焦；写入 `0` 可请求停止。 |
| 手动聚焦锁 | Sensor Head / `646` | 读写 | 锁定或解锁传感器头上的物理聚焦控制。 |
| 指示激光开关 | Sensor Head / `330` | 读写 | 某些 PSV-IR 类传感器的指示激光，不等同于测量激光。 |
| 指示激光功率 | Sensor Head / `342` | 读写 | 指示激光亮度档位；不能据此推断可调节测量激光功率。 |

照片中的 `1550 nm` 是波长信息，不是可通过软件任意设置的数值。项目已接入测量激光开关、自动聚焦和聚焦结果读取；聚焦位置、聚焦区域和指示激光参数尚未作为业务设置开放。

### B. 速度、位移和加速度量程

`Range / 10` 是不同解码器共用的量程命令，实际含义由 `deviceType` 决定：

| 解码器 | 逻辑设备 | 单位示例 | 备注 |
|---|---:|---|---|
| 速度 | `7` | `m/s`、`mm/s` | 项目已接入，照片中的 `1 m/s` 属于此类。 |
| 位移 | `9` | `m`、`mm`、`µm` | SDK 支持读取/设置列表，但项目尚未接入位移采集。 |
| 加速度 | `22` | `m/s²`、`g` | 是否可用受设备和带宽影响；项目尚未接入。 |

量程选择的基本原则：

- 量程过小：可能出现超量程，波形峰值被截断或标记无效。
- 量程过大：在相同数字输出位数下，幅值分辨率利用率可能降低。
- 量程必须覆盖预计最大值和瞬态峰值，不能只按平均振幅选择。
- 改变量程后必须重新读取 `HeadroomDigitalOut / 224` 和当前通道最大值，不能沿用旧换算系数。

相关只读或辅助命令：

| 参数 | 命令 | 含义 |
|---|---:|---|
| 最大加速度 | `686` | 当前解码器可提供的最大加速度信息，通常为字符串，只读。 |
| 最佳量程建议 | `688` | 设备给出的建议量程，只读。 |
| 最大速度量程 | `690` | 高通开启时的速度直流范围，和普通振动量程不是同一个概念。 |
| 自动量程 | `692` | 启动/停止自动量程过程。 |
| 数字输出余量 | `224` | 数字满刻度相对标称量程的系数，参与物理单位换算。 |

原厂示例使用当前量程字符串解析物理单位，再结合 `HeadroomDigitalOut` 和原始整数最大值计算缩放系数。项目的 `receiver.py` 也会在启动采集时重新读取速度量程和数字余量。

### C. 带宽和跟踪滤波

| 参数 | 命令 | 读写 | 含义 |
|---|---:|---|---|
| 解码器带宽 | `18` | 读写 | 允许保留的测量频率范围，例如照片中的 `20 kHz`。 |
| 跟踪滤波器 | `20` | 读写 | 多普勒解码跟踪范围档位，例如 `Medium`。不是转盘跟踪，也不是光斑自动跟踪。 |
| 测量模式 | `26` | 读写 | 解码器的工作模式，例如 `Velocity` 或设备提供的测试模式。 |

带宽和采样率必须区分：

- **带宽**决定设备测量链路允许通过的频率范围。
- **采样率**决定每秒输出多少个数字样本。
- 采样率高不能恢复已被带宽滤掉的频率成分。

跟踪滤波器的具体频率范围和响应时间不由 `Low/Medium/High` 这些名称直接给出，应读取设备返回的选项，并结合对应型号手册验证。SDK 只负责传输设置，不提供“Medium 一定适合某类叶片”的结论。

### D. 高通、低通和 ASE

| 参数 | 命令 | 读写 | 含义 |
|---|---:|---|---|
| 高通滤波档位 | `558` | 读写 | 抑制直流和低频成分；照片未显示，但项目已接入。 |
| 高通截止频率 | `594` | 只读 | 当前高通档位的约 `-3 dB` 截止频率。 |
| 高通通带频率 | `596` | 只读 | 当前高通档位设计通带频率。 |
| ASE 滤波开关 | `574` | 读写 | 开关设备提供的 ASE 滤波处理；项目已接入。 |
| ASE 参数 | `576` | 读写 | 带额外标签的浮点参数，例如 SDK 文档列出的 `RSSI_T`、`RSSI_S`、`RSSI_C`。 |
| 低通滤波档位 | `678` | 读写 | 抑制高频成分；项目尚未接入。 |
| 低通截止频率 | `680` | 只读 | 当前低通档位的约 `-3 dB` 截止频率。 |
| 低通通带频率 | `682` | 只读 | 当前低通档位设计通带频率。 |

高通会影响低频振动、速度积分得到的位移和相位关系。低通会影响高频冲击和高阶模态。参数修改后，报告和记录中应保存滤波设置快照，否则不同设置下的波形不具备直接可比性。

`ASE Filter` 不是普通的“平滑开关”。SDK 对其内部算法和参数的解释有限，调节 `576` 的额外标签参数前必须参考对应设备手册或厂家说明。

### E. 信号质量和解码器状态

| 参数 | 命令 | 含义 |
|---|---:|---|
| 传感器头信号强度 | `66` | 光学回波电平；不能写入。 |
| 解码器信号强度 | `676` | 解码器电平表；与传感器头 RSSI 不是同一数值。 |
| 超量程 | `572` | 当前样本是否超出量程；采集时应单独保存。 |
| 解码器可用 | `684` | 当前条件下解码器是否真正可用。命令存在不等于输出可用。 |
| 控制器状态 | `128` | 固件提供的状态信息。 |
| 温度 | `106` | 设备温度，只读。 |
| 激光小时计 | `180` | 激光运行时间和开关次数，只读或服务模式可写。 |

RSSI 适合表示回波质量，不是结构振动幅值，也不能单独判断叶片是否为同一片。项目将 RSSI 作为辅助质量信号保存，并保留缺失值和超量程状态。

### F. 位移清零和输出通道

| 参数 | 命令 | 含义 |
|---|---:|---|
| 输出激活 | `OutputActive / 796` | 在速度、位移、加速度输出之间选择一个活动解码器；切换可能停用其他输出。 |
| 位移清零可用 | `706` | 查询当前配置是否允许位移清零。某些高通设置会使它不可用。 |
| 位移清零 | `708` | 将位移解码器的当前值设为零。 |
| 位移清零模式 | `750` | 选择模拟或数字清零方式，具体选项由设备返回。 |

切换输出通道会改变数据单位、通道编号和换算方式。当前项目采集服务按速度通道 `m/s` 和 RSSI 通道 `%` 组织数据，不应在未同步修改数据解析与存储格式的情况下直接切换到位移或加速度输出。

### G. DAQ 采集和触发

| 参数 | 命令 | 读写 | 含义 |
|---|---:|---|---|
| 采样率 | `918` | 只读 | 当前信号采样率，单位 samples/s。不是带宽。 |
| 基础采样率 | `986` | 只读 | DAQ 基率，用于解释 RSSI 与速度样本的倍率关系。 |
| DAQ 模式 | `920` | 读写 | `Streaming` 连续流或 `Block` 分块模式。 |
| 块大小 | `922` | 读写 | Block 模式每块的基率样本数；Streaming 下无效。 |
| 块数量 | `924` | 读写 | Block 模式采集块数；`0` 表示持续传输；Streaming 下无效。 |
| 触发模式 | `926` | 读写 | `None`、`Extern`、`Intern`、`Analog` 等设备返回选项。 |
| 触发边沿 | `928` | 读写 | `Falling` 或 `Rising`。 |
| 门控触发 | `930` | 读写 | 用外部信号作为内部/模拟触发的门控。 |
| 预/后触发 | `932` | 读写 | 正数表示保留触发前样本，负数表示触发后样本。 |
| 模拟触发电平 | `934` | 读写 | 以最大幅值比例表示的模拟触发阈值。 |
| 活动通道 | `978` | 读写 | 选择速度、位移、加速度、RSSI、触发等通道；数量受设备带宽和固件约束。 |

项目当前使用连续采集模式，读取速度和 RSSI。`Block` 模式和硬件触发参数虽然由 SDK 定义，但没有被当前项目业务流程接入。项目的叶片进入/离开判断是软件层 RSSI 判定，不等同于 SDK 的硬件触发。

SDK 的数据采集调用通常是：

```text
PolyOpenDataAcquisition
    -> PolyStartDataAcquisition
    -> PolyReadData / PolyReadAvailableData
    -> PolyExtractedSampleCount
    -> PolyGetInt32Data / PolyGetOverrange
    -> PolyStopDataAcquisition
    -> PolyCloseDataAcquisition
```

原始整数必须结合当前解码器量程、`HeadroomDigitalOut`、通道最大值和单位进行换算。不要直接把原始 `int32` 当成 `m/s`。

## 四、用户配置和网络相关命令

SDK 还包含以下命令，但项目当前没有开放给普通业务界面：

| 类别 | 命令 | 说明 |
|---|---|---|
| 用户配置 | `LoadUserSettings / 566` | 载入用户配置档。 |
| 用户配置 | `SaveUserSettings / 570` | 保存当前配置到用户配置档。 |
| 上电配置 | `PowerUpSettings / 588` | 指定上电时载入的配置档。 |
| 上电聚焦 | `PowerUpFocusPosition / 590` | 指定上电聚焦位置；`-1` 表示上电自动聚焦。 |
| 写锁 | `WriteLock / 702` | 获取读写权限，避免多个客户端同时修改。 |
| 写锁超时 | `WriteLockTimeout / 704` | 写锁保持时间。客户端需持续通信，否则写锁可能失效。 |
| DAQ 目标地址 | `DestinationIPAddress / 90` | 指定设备把 UDP 数据发送到哪台主机。 |
| 设备地址 | `DeviceIPAddress / 578` | 设备自身网络地址，修改可能导致通信中断。 |
| DHCP | `DHCPClient / 672` | DHCP 开关。 |
| IQ 模式 | `IQMode / 1058` | 输出未解调的基带 IQ 原始信号；改变后通常需要重启。 |

网络、用户配置、上电配置、固件更新、重启和写锁属于设备级操作，不能与普通的“改变测量参数”混在一起。项目的 `device.py` 明确没有开放任意命令、网络修改或保存上电配置。

## 五、项目已经接入的设备接口

项目中的 `POST /api/field/device` 服务接口支持以下操作：

```json
{"deviceIp":"192.168.106.90","action":"read"}
```

读取配置会返回设备实际支持的字段和选项，不支持的字段不会填充假默认值。

当前允许修改的字段：

| 项目字段 | 设备 | 命令 | 类型 |
|---|---:|---:|---|
| `velocityRange` | `7` | `10` | 列表型 |
| `bandwidth` | `7` | `18` | 列表型 |
| `highPass` | `7` | `558` | 列表型 |
| `ase` | `7` | `574` | `0/1` 开关 |

当前只读字段：

| 项目字段 | 设备 | 命令 |
|---|---:|---:|
| `laser` | `2` | `46` |
| `focusPosition` | `2` | `38` |
| `signalLevel` | `2` | `66` |
| `autofocus` | `2` | `64` |
| `autofocusResult` | `2` | `76` |

修改请求示例：

```json
{
  "deviceIp": "192.168.106.90",
  "action": "set",
  "key": "bandwidth",
  "value": "20 kHz",
  "expected": "10 kHz",
  "confirmChange": true
}
```

服务会先读取当前值，确认 `expected` 仍然匹配，再写入目标值，最后重新读取核对。采集中禁止读取配置和修改设备参数。激光开关、自动聚焦必须单独提供 `confirmLaser: true`，并且异常时需要现场确认激光状态。

## 六、错误处理

每一次 C API 调用都必须检查返回码。常见错误如下：

| 错误 | 含义 | 排查方向 |
|---:|---|---|
| `0` | 成功 | 继续读取返回值 |
| `5` | 不支持的命令/属性 | 先 `PolyHasCommand`，确认设备型号和固件 |
| `7` | 写入值非法或越界 | 重新读取 `GetDevInfo` / `GetValueList` |
| `11` | 逻辑设备未安装 | 确认设备类型、通道和许可证 |
| `14` | 设备未准备好 | 检查当前工作模式、采集状态和激光状态 |
| `15` | 设备无响应 | 检查 IP、网卡、网络隔离和设备连接 |
| `18` | 激光被禁用 | 检查安全开关、传感器头和设备状态 |
| `25` | 写锁失败 | 关闭其他控制程序，获取并维持写锁 |
| `2008` | SDK 通信超时 | 检查设备是否被其他客户端占用或断网 |
| `2009` | 返回格式无效 | 确认 SDK DLL 与设备固件匹配 |

发生写入超时或读回不一致时，不能把操作当成成功。应重新读取设备配置；涉及激光的异常必须在现场使用设备控制界面或物理开关确认。

## 七、现场使用建议

1. 先停止采集，再读取当前配置并保存快照。
2. 修改前记录设备型号、传感器头、波长、量程、带宽、滤波器和采样率。
3. 只从设备返回的选项中选择值，不手写命令索引或假设固定档位。
4. 修改一个参数后立即读回；不要一次连续修改多个参数而不验证。
5. 改变量程、带宽或输出通道后，重新获取采样率、通道最大值、余量系数和滤波器截止频率。
6. 采集记录中保存完整的设备配置快照，否则后续无法判断两次波形差异来自结构变化还是参数变化。
7. 任何激光开启、自动聚焦、位移清零和输出通道切换，都要确认现场人员、目标和光路安全。
8. 不要在原厂控制软件、项目客户端和其他调试程序之间并行写入同一台设备。

## 八、与照片参数的对应关系

| 照片显示 | SDK 对应 | 当前项目 |
|---|---|---|
| 传感器头 `VFX-1-150` | 设备名称/传感器信息命令 | 设备型号需现场读取确认 |
| 激光 `开` | Sensor Head `46` | 已接入读写 |
| 波长 `1550 nm` | `334` | 只读信息 |
| 带宽 `20 kHz` | Velocity Decoder `18` | 已接入读写 |
| 跟踪滤波器 `Medium` | Velocity Decoder `20` | SDK 支持，项目未接入 |
| 速度量程 `1 m/s` | Velocity Decoder `10` | 已接入读写 |
| 位移量程 `10 mm` | Displacement Decoder `10` | SDK 定义，项目未接入 |
| 加速度量程 `1×10³ m/s²` | Acceleration Decoder `10` 及相关能力命令 | 需实机确认，项目未接入 |

照片中的报错 `Device not responding` / `Timeout` 属于通信层问题，不能通过改变量程或滤波器解决。应优先检查控制器 IP、网卡、UDP/TCP 选择、设备是否被其他程序占用、设备是否处于更新/重启状态，以及 SDK DLL 与设备固件是否匹配。

## 九、源码和进一步阅读

- 原厂命令定义：`vendor/polytec/source/DeviceCommunication-2021-source.zip` 内的 `include/IO/DeviceCommunication/PTCDeviceCommand.h`
- 原厂设备和命令发现说明：压缩包内 `doc/resources/002_DeviceTypesAndCommands.md`
- 原厂采集配置示例：压缩包内 `examples/C++/DataAcquisition/GetConfig.cpp`
- 项目设备配置：[`services/acquisition/blade_acquisition/device.py`](../services/acquisition/blade_acquisition/device.py)
- 项目采集与单位换算：[`services/acquisition/blade_acquisition/receiver.py`](../services/acquisition/blade_acquisition/receiver.py)
- macOS SDK 构建与验证说明：[`docs/MAC_SDK_BUILD.md`](MAC_SDK_BUILD.md)

本文描述的是 SDK 和项目代码中已确认的能力，不替代具体 VFX/IVS 型号的硬件手册、激光安全规程和现场验收记录。

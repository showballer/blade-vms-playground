# 转盘点位定位与停止反馈排查

轴反馈 flags 与驱动限位标志 limitFlags 属于不同字段，不能混用位定义。

| 轴 flags | 含义 | 上位机处理 |
| --- | --- | --- |
| `0x10` | 停止待确认 | 继续读取；不能凭停止命令 ACK 或零转速启动下一点 |
| `0x20` | 点位定位运动中 | 等待完成；该位本身不是故障 |
| `0x01` | 角度参考有效 | 定位前必须有效，并校验参考签名未变化 |

换点前对短暂的运动、停止待确认最多等待 5 秒，可取消。进入等待后，需要连续两个完整的双轴反馈都确认停稳，才允许进入后续位置与参考检查。真实轴故障、驱动报警和活动限位仍中断；不自动清故障或重发运动。等待不能延长反馈定位原有的总超时。

运动完成必须同时满足两轴到达目标容差、零转速、`flags & 0x30 == 0`，并通过新鲜直接反馈及参考、保护检查。缓存的零速样本不能单独证明到位。当前 SDK 没有 `wait_for_axes()`，由服务的有界反馈循环执行对应检查。

`MotorController.stop(wait=True)` 只发送一次停止命令，并等待连续两次零转速、非定位运动中、非停止待确认的轴反馈。它不会清除锁存故障；故障仍由运动前检查阻止后续动作。

## 保存现场诊断日志

在启动桌面客户端前设置 `BLADE_TURNTABLE_TIMING_LOG` 为可写的绝对文件路径，例如 macOS：

```sh
BLADE_TURNTABLE_TIMING_LOG=/tmp/blade-turntable.jsonl npm run desktop
```

Windows PowerShell（先创建日志目录）：

```powershell
$env:BLADE_TURNTABLE_TIMING_LOG = 'C:\BladeLogs\turntable.jsonl'
npm run desktop
```

每条日志为一行 JSON。`drive_internal` 的 `position_observed` 事件按轴保留目标角度、实测角度、转速、数值及十六进制 flags、guardFault、alarmCode、source、sampleAgeMs，以及包含主机读取消耗的反馈年龄。命令、STOP、等待反馈均带时间戳，便于与下位机日志对齐。没有该字段的旧反馈接口不会伪造来源或采样年龄。

定位失败证据保留 `lastMotionCommand`、`firstAbnormalReadings` 和停止操作记录，避免停止后正常读数覆盖第一次异常。日志默认关闭；日志写入失败不改变设备操作结果。

页面“上次采集异常”保留上次任务失败原因。设备是否恢复，应以“转盘状态 → 重新检查”的成功读回为准；重新检查不会续跑采集或清除故障。

# Point handoff latency

The Mac and Windows clients share this acquisition service. Ordinary telemetry
can yield to a blade-departure event between completed device transactions;
an in-flight transaction is neither abandoned nor replayed. TCP replies wake
the reader on socket readiness rather than a fixed 5 ms polling interval.

For native `0x19` positioning, a handoff may reuse a complete, validated pair of
observations from the same station and motor owner for at most 0.5 seconds.
Incomplete or expired observations require a fresh full preflight. The SDK
still checks fresh joint position/alarm feedback and the moving axis's
reference immediately before sending a target. Buffered legacy positioning
does not reuse this native preflight cache.

Arrival still requires both axes within 0.5 degrees, zero reported speed, and
direct source-0 feedback. The subsequent independent status check can reuse
only the alarm already present in that direct observation, with sample age
plus elapsed host observation time bounded to 250 ms. Speed/run/limit flags,
references and guards are independently read; an expired or cached alarm
observation falls back to the full status read. A checked arrival pair can
seed the immediately following station's bounded preflight cache.

Laser state is read from the actual device at every boundary. If it is already
on, the redundant ON write is omitted. A real OFF state is enabled and read
back; failed or invalid readbacks do not authorize the next step. Moving
samples are still excluded from the stationary point record.

## Validation

On 2026-10-23 the final version completed three Mac hardware runs: 24 complete
records and 21 moves with a next point. The final point of each run had no
next-point movement and was excluded from handoff timing. Speed, motion
profile, point coordinates, RSSI thresholds and arrival tolerance were held
constant; firmware and hardware references were not changed.

| Host-observed timing | Before, median (15 moves) | After, median (21 moves) |
| --- | ---: | ---: |
| Departure confirmed to target command sent | 461 ms | 292 ms |
| Direct stopped feedback to final arrival check | 211 ms | 151 ms |
| Departure confirmed to final arrival | 2.816 s | 2.484 s |

The longest departure dispatch delay fell from 232 ms to 59 ms. Final arrival
checks used six requests instead of eight. A complete preflight refresh still
produced one 724 ms command-dispatch sample, exceeding the previous maximum
of 639 ms; the long tail is not eliminated. Sequential runs include controller,
feedback-sampling and transport variation, so total-time improvement should
not be interpreted as a deterministic software-only saving.

Mac dylib and Windows DLL interface fixtures cover the shared code. Windows
hardware and a rebuilt Windows installer were not validated in this run.
Focused tests are in `test_handoff_latency.py`, `test_drive_position_test.py`,
`test_station_session.py` and `test_tcp_transport.py`.

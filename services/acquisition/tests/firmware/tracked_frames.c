/* SDK bytes -> real STM32 parser -> real command/guard/point controller.
 * The vendor host fixture replaces only the bus and motor; no board I/O. */
#define main vendor_limits_main
#include "test_limits.c"
#undef main
#include "pc_protocol.h"
#include "sdk_frames.h"

static pc_protocol_t parser;

static void setup_sdk_axis(void)
{
    memset(motors, 0, sizeof(motors));
    memset(forced, 0, sizeof(forced));
    memset(current_mode, 0, sizeof(current_mode));
    memset(last_speed, 0, sizeof(last_speed));
    memset(speed_parameters, 0, sizeof(speed_parameters));
    memset(forced_speed, 0, sizeof(forced_speed));
    now=1000U; fail_reads=fail_stop=reject_speed_source=mapped_speed_input=0U;
    status_follows_setpoint=1U;
    motors[0].slave_id=1U; motors[1].slave_id=2U;
    motors[0].bus=motors[1].bus=&bus;
    feedback_mode[0]=feedback_mode[1]=3U;
    Command_Manager_Init(&manager, &motors[0], &motors[1], NULL);
    /* Pitch dual-limit physical coordinates increase when raw counts decrease. */
    manager.guard[0].zero_valid=1U;
    manager.guard[0].reference_angle=0;
    manager.guard[0].angle_sign=-1;
    manager.guard[0].ppr=10000U;
    PC_Protocol_Init(&parser, Command_Process, &manager);
}

static void send_sdk(const uint8_t *frame, unsigned size)
{
    PC_Protocol_Input(&parser, frame, (uint16_t)size);
    if (reply!=PC_STATUS_SUCCESS) fprintf(stderr,"SDK command 0x%02x rejected: %u fault=%u phase=%u stop=%u continuous=%u rpm=%d dual_pending=%u\n",
        frame[4],reply,manager.guard[0].fault,manager.guard[0].phase,manager.guard[0].stop_pending,
        manager.continuous_active[0],motors[0].status.speed_raw,manager.guard[0].dual_pending);
    assert(reply==PC_STATUS_SUCCESS);
}

static void tick_sdk_axis(void)
{
    now+=50U;
    motors[0].status.position+=(int32_t)last_speed[0]*10000/1200;
    motors[0].status.speed_raw=last_speed[0];
    Command_Manager_Task(&manager);
}

static int32_t physical_angle(void)
{
    int32_t angle=0;
    assert(AxisGuard_Angle(&manager.guard[0], motors[0].status.position, 3U, 10000U, 50U, 1U, &angle));
    return angle;
}

int main(void)
{
    setup_sdk_axis();
    unsigned old_triggers=triggers[0];
    send_sdk(sdk_up, sizeof(sdk_up));
    assert(manager.point_active[0] && manager.point_target[0]==-2778);
    tick_sdk_axis();
    assert(last_speed[0]<0); /* Physical +2 degrees is raw negative velocity. */
    for (unsigned n=0; n<500U && manager.point_active[0]; ++n) tick_sdk_axis();
    assert(!manager.point_active[0] && !last_speed[0] && !manager.guard[0].fault);
    int32_t angle=physical_angle(); assert(angle>=1960 && angle<=2040);

    send_sdk(sdk_stop, sizeof(sdk_stop));
    int32_t stopped=motors[0].status.position;
    send_sdk(sdk_down, sizeof(sdk_down));
    assert(manager.point_target[0]==stopped+278);
    tick_sdk_axis(); assert(last_speed[0]>0); /* Physical -0.2 reverses. */
    for (unsigned n=0; n<500U && manager.point_active[0]; ++n) tick_sdk_axis();
    assert(!manager.point_active[0] && !last_speed[0] && !manager.guard[0].fault);
    int32_t delta=physical_angle()-angle; assert(delta>=-240 && delta<=-160);
    assert(triggers[0]==old_triggers); /* Never trigger or resume a P4 segment. */
    assert(manager.guard[0].zero_valid && manager.guard[0].origin==0);
    manager.guard[0].dual_enabled=1U;
    manager.guard[0].dual_valid=3U;
    manager.guard[0].active_high=0U;
    manager.guard[0].dual_channel[0]=2U; manager.guard[0].dual_channel[1]=0U;
    manager.guard[0].dual_angle[0]=-29000; manager.guard[0].dual_angle[1]=35000;
    /* Normally-closed dual sensors are released at raw high, not raw zero. */
    for (unsigned n=0; n<30U; ++n) Command_Manager_SampleInputs(&manager, 5U);
    for (unsigned n=0; n<2U; ++n)
        manager.guard[0].dual_seen[n]=AxisGuard_Trips(&manager.guard_inputs,&manager.guard[0],manager.guard[0].dual_channel[n]);
    manager.guard[0].minimum=-29000; manager.guard[0].maximum=35000;
    manager.guard[0].soft_on=1U;
    manager.guard[0].fault=GUARD_EXECUTION;
    send_sdk(sdk_clear_execution, sizeof(sdk_clear_execution));
    assert(!manager.guard[0].fault && manager.guard[0].zero_valid);
    assert(manager.guard[0].dual_enabled && manager.guard[0].origin==0);
    assert(manager.guard[0].minimum==-29000 && manager.guard[0].maximum==35000);
    manager.guard[1].zero_valid=1U; manager.guard[1].origin=1234;
    send_sdk(sdk_clear_reference, sizeof(sdk_clear_reference));
    assert(!manager.guard[0].zero_valid && manager.guard[0].dual_enabled);
    assert(manager.guard[1].zero_valid && manager.guard[1].origin==1234);
    assert(!manager.point_active[0] && !last_speed[0]);
    assert(triggers[0]==old_triggers);

    /* Diagnostic reproduction, not a precision acceptance test: the real
       point controller assumes it can refresh its speed command promptly.
       With the measured P2 distance/RPM and a blocking command interval,
       even an ideal instantaneous drive can pass the target before its next
       update. Keep vendor code untouched; only the test motor clock advances. */
    setup_sdk_axis();
    send_sdk(sdk_fast_up, sizeof(sdk_fast_up));
    tick_sdk_axis();
    int16_t moving_rpm=last_speed[0];
    assert(moving_rpm<0);
    now+=250U;
    motors[0].status.position+=(int32_t)((int64_t)moving_rpm*10000*250/60000);
    motors[0].status.speed_raw=moving_rpm;
    int32_t overshoot=physical_angle()-3679;
    assert(overshoot>500); /* Platform's 0.5 degree envelope must still stop. */
    printf("Point-loop starvation reproduction: 250 ms gap, %.3f deg past target\n",
           overshoot/1000.0);
    send_sdk(sdk_stop, sizeof(sdk_stop));
    assert(!manager.point_active[0] && !last_speed[0]);
    puts("SDK wire -> firmware: signed moves, stop/reverse, execution clear and pitch-only reference reset passed");
    return 0;
}

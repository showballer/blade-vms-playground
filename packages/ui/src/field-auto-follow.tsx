"use client";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Crosshair, Hand, LoaderCircle, Plus, RefreshCw, Route, StepForward, Trash2 } from "lucide-react";
import { Button, CustomSelect } from "./common";
import { FieldLaserControl } from "./field-device";
import { FieldTurntableManual } from "./field-turntable";
import { FieldDriveProfile, driveProfileFastPreset } from "./field-drive-profile";
import { FieldTurntableOriginControl, type FieldOriginReturnMotion } from "./field-turntable-origin-control";
import { matchingWorkOrigin, workOriginForPlanning, toWorkAngle, readSavedWorkOrigins, revalidateWorkOrigin, recoverCalculatedWorkOrigin, workOriginStorageKey, type FieldWorkOrigin } from "./field-turntable-origin";
import type { FieldCaptureRoute, FieldAutoCaptureTarget } from "./field-capture-route";
import type { FieldPositionedStation } from "./field-route-position";
import { planAutoFollow, manualBladeRotationWaitSeconds, type AutoFollowAnchor, type AutoFollowDraft, type AutoFollowPlan } from "./field-auto-follow-plan";
import { planSegmentedFollow, readSegmentSettings, segmentedDefaults, segmentedPairStepDeg, segmentedStorageKey, type SegmentSettings } from "./field-segmented-plan";
import { turntableAxisLimitsError, turntablePointMotionError, turntableReferenceSignature } from "./field-turntable-points";
import { isTurntablePort, normalizeTurntablePort } from "./field-turntable-port";
import { fieldIsActive, fieldTurntableMotionMode, validateFieldConfig, type FieldAxisFeedback, type FieldConfig, type FieldRequestOptions, type FieldStatus } from "./field-types";

import { autoFollowStorageKey as storageKey, defaultAutoFollowSurvey, readAutoFollowSurvey, generateAutoFollowBladePoints, surveyDraft, selectSurveyTarget, surveyIdentityErrors, autoFollowTargetKey, type AutoFollowSurvey, type AutoFollowSettings, type AutoFollowPoint, type AutoFollowBlade } from "./field-auto-follow-config";
const numberText = (value: number | undefined | null, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请检查设备状态";
type Props = {
  config: FieldConfig; onConfig: React.Dispatch<React.SetStateAction<FieldConfig>>;
  status: FieldStatus | null; disabled: boolean; pollUnavailable?: boolean;
  request: <T>(options: FieldRequestOptions) => Promise<T>;
  onStatus: (status: FieldStatus) => void; onRecords: () => void; onService: () => void;
  onOperationBusy?: (busy: boolean) => void;
  onAcquisition?: () => void; onRoute?: (route: FieldCaptureRoute) => void;
  autoTargetKey?: string; onAutoTarget?: (key: string) => void;
  visible?: boolean; connectionPort?: string;
  routeMode?: "manual" | "auto" | "segmented"; onRouteMode?: (mode: "manual" | "auto" | "segmented") => void;
  onPositionTarget?: (key: string, azimuthDeg?: number) => void;
  positionedStation?: FieldPositionedStation;
  workOrigin?: FieldWorkOrigin | null; opticalOrigin?: FieldWorkOrigin | null; opticalOriginRequired?: boolean; onPortChange?: (port: string) => void;
};

export const opticalOriginRequiredKey = "blade-turntable-optical-origin-required-v1";
export function autoFollowOpticalOriginError(required: boolean, calibrated: boolean, origin: FieldWorkOrigin | null): string {
  return required && !calibrated && !origin ? "公共光学零点需重新设置：请将激光调至水平并正对叶轮中线，再点击设置归零" : "";
}
export function autoFollowPointLengthError(radiusM: number, lengthM?: number): string {
  return Number.isFinite(lengthM) && lengthM! > 0 && radiusM > lengthM! + 1e-12
    ? "测点超出叶尖，请检查距转轴中心的距离和叶片长度" : "";
}

type AutoFollowCollection = { collectionId: string; collectionContext: string };
const emptyCollection = (): AutoFollowCollection => ({ collectionId: "", collectionContext: "" });
export function autoFollowCollectionContext(config: FieldConfig, _bladeId?: string): string {
  const context = ["wind-turbine-v2", config.name, config.object, config.turbine.trim() || config.name.trim(), config.deviceIp];
  // Empty legacy farm values keep their existing task identity.
  if (config.windFarm?.trim()) context.push("windFarm", config.windFarm);
  return JSON.stringify(context.map(value => value.trim().normalize("NFC")));
}
export function autoFollowCollection(previous: AutoFollowCollection, context: string,
  makeId = () => globalThis.crypto.randomUUID().replaceAll("-", "")): AutoFollowCollection {
  return previous.collectionContext === context && previous.collectionId.length === 32 && /^[a-f0-9]{32}$/.test(previous.collectionId)
    ? previous : { collectionId: makeId(), collectionContext: context };
}
/** Persist editable values and collection identity; never persist a device anchor. */
export function readAutoFollowDraft(raw: string | null): { draft: AutoFollowDraft; port: string } & AutoFollowCollection {
  const survey = readAutoFollowSurvey(raw);
  return { draft: surveyDraft(survey), port: survey.port, collectionId: survey.collectionId, collectionContext: survey.collectionContext };
}

export function autoFollowAnchorKey(draft: AutoFollowDraft, port: string): string {
  const selected = draft.points.find(point => point.id === draft.activePointId);
  return JSON.stringify([port, draft.distanceM, draft.hubHeightDeltaM, draft.direction, draft.axis1Sign, draft.axis2Sign, draft.activePointId, selected?.radiusM, draft.pitchAngleScale === undefined ? 1 : draft.pitchAngleScale, draft.yawAngleScale === undefined ? 1 : draft.yawAngleScale]);
}

function axisReadiness(value: FieldAxisFeedback | undefined, axis: 1 | 2): string {
  if (!value || value.fault !== 0 || value.motor_rpm !== 0 || !Number.isInteger(value.flags) || (value.flags & 16) !== 0) return `轴${axis}未确认静止且无故障`;
  return turntableAxisLimitsError(value, axis);
}

export function autoFollowAnchorFromStatus(status: FieldStatus, port: string, radiusM: number, pointId: string): AutoFollowAnchor {
  if (status.turntable?.port !== port) throw new Error("读取结果的串口与当前设置不一致，请重新读取");
  if (status.turntableWarning) throw new Error(status.turntableWarning);
  const axes = status.turntable.feedback?.axes;
  const signature = turntableReferenceSignature(axes);
  if (!signature) throw new Error("两轴参考位无效，请先在手动控制中建立参考位");
  for (const axis of [1, 2] as const) {
    const invalid = axisReadiness(axes?.[String(axis)], axis);
    if (invalid) throw new Error(invalid);
  }
  return { port, referenceSignature: signature, radiusM, pointId, axis1AngleDeg: axes!["1"].output_angle_deg!, axis2AngleDeg: axes!["2"].output_angle_deg! };
}

export function autoFollowBlockers(config: FieldConfig, status: FieldStatus | null, plan: AutoFollowPlan, anchor: AutoFollowAnchor | null, port: string): string[] {
  const errors = [...plan.errors];
  const invalid = validateFieldConfig({ ...config, turntable: undefined });
  if (invalid) errors.push(invalid);
  if (!status || status.service.state !== "ready") errors.push("采集服务尚未就绪");
  else if (!status.service.dllConfigured) errors.push("请在设备与服务中配置采集驱动");
  if (status?.deviceWarning) errors.push(status.deviceWarning);
  if (status?.turntableWarning) errors.push(status.turntableWarning);
  if (!isTurntablePort(port)) errors.push("请在转盘状态中配置连接并读取反馈");
  if (anchor) {
    const axes = status?.turntable?.port === port ? status.turntable.feedback?.axes : undefined;
    for (const axis of [1, 2] as const) {
      const invalidAxis = axisReadiness(axes?.[String(axis)], axis);
      if (invalidAxis) errors.push(invalidAxis);
    }
    const invalidPoint = plan.points.map(point => turntablePointMotionError(point, axes, port)).find(Boolean);
    if (invalidPoint) errors.push(invalidPoint);
  }
  return [...new Set(errors)];
}

export function FieldTurntableWorkspace(props: Props) {
  const [localMode, setMode] = useState<"manual" | "auto" | "segmented">("manual");
  const mode = props.routeMode || localMode;
  const [autoBusy, setAutoBusy] = useState(false), [originBusy, setOriginBusy] = useState(false), [profileBusy, setProfileBusy] = useState(false);
  const savedOrigins = () => { try { return readSavedWorkOrigins(localStorage.getItem(workOriginStorageKey)); } catch { return readSavedWorkOrigins(null); } };
  const [workOrigin, setWorkOrigin] = useState<FieldWorkOrigin | null>(() => savedOrigins().work);
  const [opticalOrigin, setOpticalOrigin] = useState<FieldWorkOrigin | null>(() => savedOrigins().optical);
  const [originRequired, setOriginRequired] = useState(false);
  const opticalOriginRequired = originRequired || props.opticalOriginRequired === true;
  const [selectedPorts, setSelectedPorts] = useState({ manual: "", auto: "" });
  const [returnMotion, setReturnMotion] = useState<FieldOriginReturnMotion>(() => {
    let settings;
    try { settings = readAutoFollowSurvey(localStorage.getItem(storageKey)).settings; }
    catch { settings = defaultAutoFollowSurvey().settings; }
    return { speedRpm: settings.maxMoveRpm, maxMoveAccelerationDegS2: settings.maxMoveAccelerationDegS2, followErrorLimitDeg: settings.followErrorLimitDeg };
  });
  const busyChanged = useCallback((value: boolean) => setAutoBusy(value), []);
  const manualPortChanged = useCallback((port: string) => setSelectedPorts(previous => previous.manual === port ? previous : { ...previous, manual: port }), []);
  const autoPortChanged = useCallback((port: string) => setSelectedPorts(previous => previous.auto === port ? previous : { ...previous, auto: port }), []);
  const activePort = props.connectionPort || selectedPorts[mode === "manual" ? "manual" : "auto"];
  useEffect(() => { props.onPortChange?.(activePort); }, [activePort, props.onPortChange]);
  const originCheck = useRef("");
  const originLive = useRef({ activePort, status: props.status, workOrigin, opticalOrigin });
  originLive.current = { activePort, status: props.status, workOrigin, opticalOrigin };
  const originMounted = useRef(false);
  useEffect(() => { originMounted.current = true; return () => { originMounted.current = false; }; }, []);
  useEffect(() => {
    try { if (localStorage.getItem(opticalOriginRequiredKey) === "true") setOriginRequired(true); }
    catch { /* A successful zero still stays required for this session. */ }
  }, []);
  useEffect(() => { props.onOperationBusy?.(autoBusy || originBusy || profileBusy); return () => props.onOperationBusy?.(false); }, [autoBusy, originBusy, profileBusy, props.onOperationBusy]);
  useEffect(() => {
    try { localStorage.setItem(workOriginStorageKey, JSON.stringify({ version: 1, work: workOrigin, optical: opticalOrigin })); }
    catch { /* Keep the coordinates in memory when storage is unavailable. */ }
  }, [workOrigin, opticalOrigin]);
  useEffect(() => {
    // Motion marks its pending stop as a warning. That temporarily blocks new
    // commands; it must not erase the saved coordinate offset.
    if (workOrigin || opticalOrigin) return;
    const recovered = recoverCalculatedWorkOrigin(props.status);
    if (recovered) { setWorkOrigin(recovered); setOpticalOrigin(recovered); setOriginRequired(true); }
  }, [props.status, workOrigin, opticalOrigin]);
  useEffect(() => {
    const saved = opticalOrigin || workOrigin;
    if (!saved || activePort !== saved.port || props.disabled || autoBusy || originBusy || profileBusy ||
        !props.status || props.status.service.state !== "ready" || fieldIsActive(props.status) || props.status.deviceBusy || props.status.turntableBusy ||
        !saved.verificationRequired && saved.generation === props.status.service.generation) return;
    const observedAt = props.status.turntable?.port === activePort ? props.status.turntable.feedback?.observedAt : undefined;
    if (observedAt !== undefined && Date.now() / 1000 - observedAt >= 0 && Date.now() / 1000 - observedAt <= .5) {
      try {
        const verified = revalidateWorkOrigin(saved, props.status, activePort);
        setOpticalOrigin(verified); if (workOrigin) setWorkOrigin(verified);
        return;
      } catch { /* A failed fresh check never replaces the saved coordinates. */ }
    }
    if (props.visible === false) return; // Hidden configuration may accept a fresh result, never initiate a background probe.
    const key = JSON.stringify([saved, props.status.service.generation, activePort]);
    if (originCheck.current === key) return;
    originCheck.current = key;
    void props.request<FieldStatus>({ action: "turntable", request: { action: "probe", port: activePort, axis: 1 } }).then(checked => {
      const latest = originLive.current;
      if (!originMounted.current || latest.activePort !== activePort || latest.status?.service.generation !== checked.service.generation ||
          JSON.stringify(latest.opticalOrigin || latest.workOrigin) !== JSON.stringify(saved) || fieldIsActive(latest.status)) return;
      const verified = revalidateWorkOrigin(saved, checked, activePort);
      props.onStatus(checked); setOpticalOrigin(verified);
      if (workOrigin) setWorkOrigin(verified);
    }).catch(() => { /* Coordinates remain saved; manual return can retry the fresh probe and explain any error. */ });
  }, [activePort, props.visible, props.disabled, props.status?.service.generation, props.status?.service.state,
    props.status?.state, props.status?.deviceBusy, props.status?.turntableBusy, props.status?.turntable?.feedback?.observedAt, workOrigin, opticalOrigin, autoBusy, originBusy, profileBusy]);
  const id = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const editingLocked = props.disabled || autoBusy || profileBusy || fieldIsActive(props.status) || !!props.status?.deviceBusy;
  const baseLocked = editingLocked || !!props.status?.turntableBusy;
  const locked = baseLocked || originBusy;
  const selectMode = (next: "manual" | "auto" | "segmented") => { if (!locked) { setMode(next); props.onRouteMode?.(next); } };
  return <div className="field-turntable-workspace field-servo-ui">
    <FieldTurntableOriginControl port={activePort} deviceIp={props.config.deviceIp} status={props.status} disabled={editingLocked || !originBusy && !!props.status?.turntableBusy} origin={workOrigin} opticalOrigin={opticalOrigin} opticalOriginRequired={opticalOriginRequired} returnMotion={returnMotion}
      request={props.request} onVerifiedOrigin={origin => { setOpticalOrigin(origin); if (workOrigin) setWorkOrigin(origin); }} onOrigin={origin => {
        setWorkOrigin(origin);
        if (origin) {
          setOpticalOrigin(origin); setOriginRequired(true);
          try { localStorage.setItem(opticalOriginRequiredKey, "true"); } catch { /* Keep the session fail-closed even if persistence is unavailable. */ }
        }
      }} onStatus={props.onStatus} onBusy={setOriginBusy} />
    {mode !== "segmented" && <FieldDriveProfile port={activePort} status={props.status} disabled={props.disabled || autoBusy || originBusy || !!props.pollUnavailable}
      request={props.request} onStatus={props.onStatus} onBusy={setProfileBusy} />}
    <div className="field-view-tabs field-turntable-mode-tabs" data-active={mode} role="tablist" aria-label="转盘作业方式">
      {(["manual", "auto", "segmented"] as const).map((value, index) => <button key={value} ref={node => { tabs.current[index] = node; }} type="button" role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value === "manual" ? "manual" : "calculated"}-panel`} aria-selected={mode === value} tabIndex={mode === value ? 0 : -1} disabled={locked} onClick={() => selectMode(value)} onKeyDown={event => {
        if (locked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
        selectMode((["manual", "auto", "segmented"] as const)[next]); tabs.current[next]?.focus();
      }}>{value === "manual" ? <Hand size={16} /> : value === "auto" ? <Route size={16} /> : <StepForward size={16} />}{value === "manual" ? "手动控制" : value === "auto" ? "自动跟随" : "分段采集"}</button>)}
    </div>
    <div hidden={mode !== "manual"} role="tabpanel" id={`${id}-manual-panel`} aria-labelledby={`${id}-manual-tab`}><FieldLaserControl deviceIp={props.config.deviceIp} status={props.status} disabled={props.disabled || autoBusy || originBusy || profileBusy} request={props.request} /><FieldTurntableManual status={props.status} disabled={props.disabled || autoBusy || originBusy || profileBusy} request={props.request} onBusy={busyChanged} onStatus={props.onStatus} onRoute={props.onRoute} onAcquisition={props.onAcquisition} workOrigin={workOrigin} connectionPort={props.connectionPort} onPortChange={manualPortChanged} positionedStation={props.positionedStation} /></div>
    <div hidden={mode === "manual"} role="tabpanel" id={`${id}-calculated-panel`} aria-labelledby={`${id}-${mode === "segmented" ? "segmented" : "auto"}-tab`}><FieldAutoFollow {...props} routeMode={mode} disabled={props.disabled || originBusy || profileBusy} workOrigin={workOrigin} opticalOrigin={opticalOrigin} opticalOriginRequired={opticalOriginRequired} onPortChange={autoPortChanged} visible={props.visible !== false && mode !== "manual"} onBusy={busyChanged} onReturnMotion={setReturnMotion} /></div>
  </div>;
}

export function FieldAutoFollow({ config, onConfig, status, disabled, pollUnavailable = false, request, onStatus, onRecords, onService, onBusy, onRoute, onAcquisition, autoTargetKey, onAutoTarget, visible = true, workOrigin, opticalOrigin, opticalOriginRequired = false, onPortChange, onReturnMotion, connectionPort, routeMode, onPositionTarget, positionedStation }: Props & { onBusy?: (busy: boolean) => void; onReturnMotion?: (motion: FieldOriginReturnMotion) => void }) {
  const [survey, setSurvey] = useState<AutoFollowSurvey>(defaultAutoFollowSurvey);
  const segmented = routeMode === "segmented";
  const [segment, setSegment] = useState<SegmentSettings>({ ...segmentedDefaults });
  const [segmentStarts, setSegmentStarts] = useState<Record<string, number>>({});
  const completedSegmentSession = useRef(status?.pointCycle?.state === "complete" ? status.pointCycle.sessionId : undefined);
  const observedSegment = useRef<{ sessionId: string; context: string } | null>(null);
  const appliedPositionSequence = useRef(0);
  const [loaded, setLoaded] = useState(false), [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [anchors, setAnchors] = useState<Record<string, { value: AutoFollowAnchor; fingerprint: string; generation?: number }>>({});
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [portsBusy, setPortsBusy] = useState(false), [portsError, setPortsError] = useState("");
  const portsEntered = useRef(false), portRequest = useRef(0), portEdited = useRef(0);
  const operation = useRef(0), generation = useRef<number | undefined>(status?.service.generation);
  const alive = useRef(false), latestGeneration = useRef(status?.service.generation);
  latestGeneration.current = status?.service.generation;
  // pointCycle is retained as last-run history. Only the current service/receiver
  // owner may lock editing, not a stale phase from a finished or failed run.
  const active = fieldIsActive(status), cycleRunning = active && !!status?.pointCycle && !["complete", "cancelled", "error"].includes(status.pointCycle.state);
  const locked = disabled || !!pending || profileBusy || active || cycleRunning || !!status?.deviceBusy || !!status?.turntableBusy;
  const latestLocked = useRef(locked); latestLocked.current = locked;
  const port = connectionPort || survey.port, draft = useMemo(() => surveyDraft(survey), [survey]);
  const currentOrigin = matchingWorkOrigin(workOrigin, status, port);
  const savedOpticalOrigin = opticalOrigin === undefined ? workOrigin : opticalOrigin;
  const verifiedOrigin = matchingWorkOrigin(savedOpticalOrigin, status, port);
  const commonOrigin = verifiedOrigin || workOriginForPlanning(savedOpticalOrigin, port);
  useEffect(() => { onPortChange?.(port); }, [port, onPortChange]);
  const blade = survey.blades.find(item => item.id === survey.selectedBladeId);
  const currentPoint = blade?.points.find(point => point.id === survey.selectedPointId);
  const selectedKey = autoFollowTargetKey(survey.selectedBladeId, survey.selectedPointId);
  const motionMode = fieldTurntableMotionMode(status?.turntable, port);
  const context = autoFollowCollectionContext(config);
  const fingerprintFor = (one: AutoFollowDraft, bladeKey: string) => JSON.stringify([autoFollowAnchorKey(one, port), one.bladeId, bladeKey, context]);
  const usableAnchor = (one: AutoFollowDraft, bladeKey: string, pointId: string) => {
    const stored = anchors[autoFollowTargetKey(bladeKey, pointId)];
    return stored && stored.fingerprint === fingerprintFor(one, bladeKey) && stored.generation === status?.service.generation ? stored : null;
  };
  const currentCalibration = usableAnchor(draft, survey.selectedBladeId, survey.selectedPointId);
  const anchor = currentCalibration?.value || null;
  const originError = autoFollowOpticalOriginError(opticalOriginRequired, !!anchor, commonOrigin);
  const lengthError = autoFollowPointLengthError(currentPoint?.radiusM ?? NaN, blade?.lengthM);
  const segmentFor = (key: string): SegmentSettings => ({ ...segment, startAzimuthDeg: segmentStarts[key] ?? 0 });
  const autoPlan = useMemo(() => planAutoFollow(draft, anchor, motionMode, port, commonOrigin), [draft, anchor, motionMode, port, commonOrigin]);
  const segmentPlan = useMemo(() => planSegmentedFollow(draft, segmentFor(selectedKey), anchor, motionMode, port, commonOrigin), [draft, segment, segmentStarts, selectedKey, anchor, motionMode, port, commonOrigin]);
  const plan = segmented ? segmentPlan : autoPlan;
  const identityErrors = useMemo(() => surveyIdentityErrors(survey), [survey]);
  const blockers = [...new Set([...identityErrors, ...autoFollowBlockers(config, status, plan, anchor, port), ...(originError ? [originError] : []), ...(lengthError ? [lengthError] : [])])];
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current += 1; portRequest.current += 1; }; }, []);
  useEffect(() => {
    const savedSurvey = readAutoFollowSurvey(localStorage.getItem(storageKey));
    setSurvey(savedSurvey);
    const raw = localStorage.getItem(segmentedStorageKey);
    const restoredSegment = readSegmentSettings(raw, savedSurvey.settings.stepDeg);
    setSegment(restoredSegment);
    try {
      const saved = JSON.parse(raw || "null");
      if (saved?.starts && typeof saved.starts === "object" && !Array.isArray(saved.starts) &&
          !(restoredSegment.pointsPerStart === 2 && saved.stepDeg !== segmentedPairStepDeg)) {
        setSegmentStarts(Object.fromEntries(Object.entries(saved.starts).filter((entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] < 360 && entry[1] % restoredSegment.stepDeg === 0)));
      }
    } catch { /* A malformed draft does not restore a running task. */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(segmentedStorageKey, JSON.stringify({ ...segment, starts: segmentStarts })); }
    catch { /* Keep editable state in memory. */ }
  }, [loaded, segment, segmentStarts]);
  useEffect(() => {
    if (loaded) onReturnMotion?.({ speedRpm: survey.settings.maxMoveRpm,
      maxMoveAccelerationDegS2: survey.settings.maxMoveAccelerationDegS2, followErrorLimitDeg: survey.settings.followErrorLimitDeg });
  }, [loaded, survey.settings.maxMoveRpm, survey.settings.maxMoveAccelerationDegS2, survey.settings.followErrorLimitDeg, onReturnMotion]);
  useEffect(() => {
    if (!loaded) return;
    try {
      const saved = readAutoFollowSurvey(localStorage.getItem(storageKey));
      localStorage.setItem(storageKey, JSON.stringify({ ...survey, collectionId: saved.collectionId, collectionContext: saved.collectionContext }));
    } catch { /* Saving editable configuration never persists hardware calibration. */ }
  }, [loaded, survey]);
  useEffect(() => { onBusy?.(!!pending || profileBusy); return () => onBusy?.(false); }, [pending, profileBusy, onBusy]);
  useEffect(() => {
    if (!visible) { portsEntered.current = false; portRequest.current += 1; setPortsBusy(false); return; }
    if (!loaded || locked || connectionPort || portsEntered.current) return;
    portsEntered.current = true;
    void refreshPorts();
  }, [visible, loaded, locked]);
  useEffect(() => {
    if (autoTargetKey && !locked) setSurvey(previous => selectSurveyTarget(previous, autoTargetKey));
  }, [autoTargetKey, locked]);
  useEffect(() => {
    const next = status?.service.generation;
    if (next !== undefined && generation.current !== undefined && next !== generation.current) {
      operation.current += 1; setPending(""); setAnchors({}); portRequest.current += 1; setPortsBusy(false);
    }
    if (next !== undefined) generation.current = next;
    if (status?.turntable?.port === port && status.turntable.feedback?.axes) {
      const signature = turntableReferenceSignature(status.turntable.feedback.axes);
      setAnchors(previous => Object.values(previous).some(item => item.value.referenceSignature !== signature)
        ? Object.fromEntries(Object.entries(previous).filter(([, item]) => item.value.referenceSignature === signature)) : previous);
    }
  }, [status, port]);
  useEffect(() => {
    const valid = new Map(survey.blades.flatMap(one => one.points.map(point => [autoFollowTargetKey(one.id, point.id), fingerprintFor(surveyDraft(survey, one.id, point.id), one.id)] as const)));
    setAnchors(previous => Object.entries(previous).some(([key, item]) => valid.get(key) !== item.fingerprint)
      ? Object.fromEntries(Object.entries(previous).filter(([key, item]) => valid.get(key) === item.fingerprint)) : previous);
  }, [survey, context]);
  const { targets, segmentTargets } = useMemo(() => {
    const buildTargets = (useSegments: boolean): FieldAutoCaptureTarget[] => survey.blades.flatMap(one => one.points.map(point => {
      const oneDraft = surveyDraft(survey, one.id, point.id), calibration = usableAnchor(oneDraft, one.id, point.id);
      const targetKey = autoFollowTargetKey(one.id, point.id);
      const onePlan = useSegments
        ? planSegmentedFollow(oneDraft, segmentFor(targetKey), calibration?.value || null, motionMode, port, commonOrigin)
        : planAutoFollow(oneDraft, calibration?.value || null, motionMode, port, commonOrigin);
      const pointOriginError = autoFollowOpticalOriginError(opticalOriginRequired, !!calibration, commonOrigin);
      const rootRadiusM = 0;
      const bladeLengthM = Number.isFinite(one.lengthM) && one.lengthM! > 0 && one.lengthM! <= 1000 ? one.lengthM : undefined;
      const lengthError = autoFollowPointLengthError(point.radiusM, one.lengthM);
      const dimensions = { rootRadiusM, ...(bladeLengthM !== undefined ? { bladeLengthM } : {}) };
      const pointCycle = onePlan.pointCycle ? { ...onePlan.pointCycle,
        points: onePlan.pointCycle.points.map(item => ({ ...item, ...dimensions })),
        ...(onePlan.pointCycle.segmentStations ? { segmentStations: onePlan.pointCycle.segmentStations.map(item => ({ ...item, ...dimensions })) } : {}),
        ...(onePlan.pointCycle.nextWaitPoint ? { nextWaitPoint: { ...onePlan.pointCycle.nextWaitPoint, ...dimensions } } : {}),
      } : null;
      return { key: targetKey, bladeKey: one.id, bladeId: one.name.trim(), pointId: point.id,
        pointName: point.name.trim(), radiusM: point.radiusM, ...dimensions, stations: onePlan.stationsPerPoint, cycles: useSegments ? 1 : oneDraft.cycles,
        route: { kind: useSegments ? "segmented" : "auto", name: `叶片 ${one.name.trim()} · ${point.name.trim()}`, pointNames: onePlan.points.map(item => item.name),
          cycle: identityErrors.length || pointOriginError || lengthError ? null : pointCycle,
          errors: [...new Set([...identityErrors, ...onePlan.errors, ...(pointOriginError ? [pointOriginError] : []), ...(lengthError ? [lengthError] : [])])], generation: calibration?.generation ?? commonOrigin?.generation,
          ...(!calibration && commonOrigin && !verifiedOrigin ? { verifyReferenceAtStart: true as const } : {}),
          ...(!calibration && !commonOrigin ? { referenceMode: "read_at_start" as const } : {}) } as FieldCaptureRoute };
    }));
    return { targets: buildTargets(false), segmentTargets: buildTargets(true) };
  }, [survey, segment, segmentStarts, anchors, motionMode, port, context, status?.service.generation, commonOrigin, verifiedOrigin, opticalOriginRequired]);
  const segmentRunContext = JSON.stringify([context, port, status?.service.generation, survey.settings, survey.heights, survey.blades,
    segment.pointsPerStart, segment.stepDeg]);
  useEffect(() => {
    const cycle = status?.pointCycle;
    if (!loaded || cycle?.executionMode !== "manual_segments" || !cycle.sessionId) return;
    const terminal = ["complete", "error", "cancelled"].includes(cycle.state);
    if (!terminal) {
      // Only a live session observed by this editor may advance its draft.
      // Old snapshots and mounting after a finished run must not move a cursor.
      if (fieldIsActive(status) && cycle.port === port && cycle.segmentStepDeg === segment.stepDeg &&
          observedSegment.current?.sessionId !== cycle.sessionId)
        observedSegment.current = { sessionId: cycle.sessionId, context: segmentRunContext };
      return;
    }
    if (cycle.sessionId === completedSegmentSession.current) return;
    completedSegmentSession.current = cycle.sessionId;
    const observed = observedSegment.current;
    observedSegment.current = null;
    if (cycle.state !== "complete" || !cycle.waitingPoint || observed?.sessionId !== cycle.sessionId ||
        observed.context !== segmentRunContext || cycle.port !== port || cycle.segmentStepDeg !== segment.stepDeg) return;
    const next = cycle.waitingPoint;
    const target = segmentTargets.find(item => item.bladeId === next.bladeId && item.pointId === next.radialPointId);
    const expected = target?.route.cycle?.nextWaitPoint;
    if (!expected || expected.azimuthDeg !== next.azimuthDeg || (["axis1AngleDeg", "axis2AngleDeg"] as const).some(key =>
        !Number.isFinite(next[key]) || Math.abs(next[key] - expected[key]) > 1e-6)) return;
    setSegmentStarts(previous => ({ ...previous, [target!.key]: next.azimuthDeg! }));
  }, [loaded, status, segmentRunContext, segment.stepDeg, port, segmentTargets]);
  useEffect(() => {
    if (!loaded || locked || !positionedStation || positionedStation.kind !== "segmented" ||
        positionedStation.sequence <= appliedPositionSequence.current) return;
    appliedPositionSequence.current = positionedStation.sequence;
    if (positionedStation.port !== port || positionedStation.generation !== status?.service.generation) return;
    const target = segmentTargets.find(item => item.key === positionedStation.targetKey);
    const station = target?.route.cycle?.segmentStations?.find(item => item.pointId === positionedStation.pointId);
    if (!target || !station || station.azimuthDeg !== positionedStation.azimuthDeg || !Number.isFinite(station.azimuthDeg)) return;
    setSegmentStarts(previous => ({ ...previous, [target.key]: station.azimuthDeg! }));
    setSurvey(previous => selectSurveyTarget(previous, target.key));
    onAutoTarget?.(target.key);
    setError(""); setNotice("");
  }, [loaded, locked, positionedStation, port, status?.service.generation, segmentTargets, onAutoTarget]);
  const selectedTarget = targets.find(item => item.key === selectedKey);
  const selectedSegmentTarget = segmentTargets.find(item => item.key === selectedKey);
  const captureRoute: FieldCaptureRoute = useMemo(() => ({ ...(selectedTarget?.route || { kind: "auto", name: "自动跟随路线", pointNames: [], cycle: null, errors: ["请添加叶片和测点"] }), targets, selectedTargetKey: selectedKey }), [selectedTarget, targets, selectedKey]);
  const segmentRoute: FieldCaptureRoute = useMemo(() => ({ ...(selectedSegmentTarget?.route || { kind: "segmented", name: "分段采集路线", pointNames: [], cycle: null, errors: ["请添加叶片和测点"] }), targets: segmentTargets, selectedTargetKey: selectedKey }), [selectedSegmentTarget, segmentTargets, selectedKey]);
  const captureRouteKey = useMemo(() => JSON.stringify(captureRoute), [captureRoute]);
  const segmentRouteKey = useMemo(() => JSON.stringify(segmentRoute), [segmentRoute]);
  useEffect(() => { if (loaded) onRoute?.(captureRoute); }, [loaded, captureRouteKey, onRoute]);
  useEffect(() => { if (loaded) onRoute?.(segmentRoute); }, [loaded, segmentRouteKey, onRoute]);
  async function refreshPorts() {
    if (latestLocked.current) return;
    const epoch = ++portRequest.current, revision = portEdited.current, requestedGeneration = latestGeneration.current;
    setPortsBusy(true); setPortsError("");
    try {
      const result = await request<{ ports: { port: string; description: string }[] }>({ action: "turntablePorts" });
      if (!alive.current || epoch !== portRequest.current || requestedGeneration !== latestGeneration.current) return;
      const available = (result.ports || []).filter(item => isTurntablePort(item.port) && !/^\/dev\/cu\.(?:Bluetooth|debug-console)/i.test(item.port));
      setPorts(available);
      if (!latestLocked.current && revision === portEdited.current && available.length === 1) setSurvey(previous =>
        available.some(item => item.port === previous.port) ? previous : { ...previous, port: normalizeTurntablePort(available[0].port) });
      if (!available.length) setPortsError("未发现转盘串口，请连接设备后刷新");
    } catch (cause) { if (alive.current && epoch === portRequest.current) setPortsError(messageOf(cause)); }
    finally { if (alive.current && epoch === portRequest.current) setPortsBusy(false); }
  }
  function editSegment(patch: Partial<SegmentSettings>) {
    if (locked) return;
    const next = { ...segment, ...patch };
    if (next.pointsPerStart === 2) next.stepDeg = segmentedPairStepDeg;
    setSegment(next);
    if (next.stepDeg !== segment.stepDeg) setSegmentStarts({});
    setError(""); setNotice("");
  }
  function editSettings(patch: Partial<AutoFollowSettings>) { if (!locked) { setSurvey(previous => ({ ...previous, settings: { ...previous.settings, ...patch } })); setError(""); setNotice(""); } }
  function editHeight(key: "hubHeightM" | "laserHeightM", value: string) {
    if (locked) return;
    setSurvey(previous => ({ ...previous, heights: { hubHeightM: previous.heights?.hubHeightM ?? NaN,
      laserHeightM: previous.heights?.laserHeightM ?? NaN, [key]: value === "" ? NaN : Number(value) } }));
    setError(""); setNotice("");
  }
  function editBlade(patch: Partial<Pick<AutoFollowBlade, "lengthM" | "rootReservePercent" | "tipReservePercent">>) {
    if (locked) return;
    setSurvey(previous => ({ ...previous, blades: previous.blades.map(item => item.id === previous.selectedBladeId ? { ...item, ...patch } : item) }));
    setGenerationError("");
  }
  function generatePoints() {
    if (locked || !blade) return;
    try {
      const points = generateAutoFollowBladePoints(blade.lengthM ?? NaN, blade.rootReservePercent ?? 10, blade.tipReservePercent ?? 10);
      setSurvey(previous => ({ ...previous, blades: previous.blades.map(item => item.id === blade.id ? { ...item, points } : item), selectedPointId: points[0].id }));
      onAutoTarget?.(autoFollowTargetKey(blade.id, points[0].id));
      setGenerationError(""); setError(""); setNotice("");
    } catch (cause) { setGenerationError(messageOf(cause)); }
  }
  function editPoint(patch: Partial<AutoFollowPoint>, pointId: string) {
    if (locked) return;
    setSurvey(previous => ({ ...previous, blades: previous.blades.map(item => item.id === previous.selectedBladeId
      ? { ...item, points: item.points.map(point => point.id === pointId ? { ...point, ...patch } : point) } : item) }));
    setError(""); setNotice("");
  }
  function selectTarget(bladeId: string, pointId: string) {
    if (locked) return;
    const key = autoFollowTargetKey(bladeId, pointId);
    setSurvey(previous => selectSurveyTarget(previous, key)); onAutoTarget?.(key); setError(""); setNotice(""); setGenerationError("");
  }
  async function readAnchor(pointId: string) {
    const point = blade?.points.find(item => item.id === pointId);
    if (locked || !isTurntablePort(port) || !blade || !point || !Number.isFinite(point.radiusM) || point.radiusM <= 0) return;
    const oneDraft = surveyDraft(survey, blade.id, pointId), key = autoFollowTargetKey(blade.id, pointId);
    const epoch = ++operation.current, fingerprint = fingerprintFor(oneDraft, blade.id), requestedGeneration = latestGeneration.current;
    selectTarget(blade.id, pointId);
    setPending(`calibrate:${key}`); setError(""); setNotice("");
    setAnchors(previous => { const next = { ...previous }; delete next[key]; return next; });
    try {
      const next = await request<FieldStatus>({ action: "turntable", request: { action: "probe", port, axis: 1 } });
      if (!alive.current || epoch !== operation.current) return;
      if (requestedGeneration !== latestGeneration.current || requestedGeneration !== next.service.generation) throw new Error("采集服务已变化，请重新校准当前测点。");
      onStatus(next);
      const value = autoFollowAnchorFromStatus(next, port, point.radiusM, point.id);
      setAnchors(previous => ({ ...previous, [key]: { value, fingerprint, generation: next.service.generation } }));
      setNotice(`叶片 ${blade.name} · ${point.name} 首个点位已记录。整圈点位将使用该位置的角度修正；请核对实际瞄准的是此测点。`);
    } catch (cause) { if (epoch === operation.current) setError(messageOf(cause)); }
    finally { if (epoch === operation.current) setPending(""); }
  }
  const numeric = (label: string, key: keyof AutoFollowSettings, min: number, max: number, step: number) => <label>{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={Number.isFinite(survey.settings[key]) ? String(survey.settings[key]) : ""} disabled={locked} onChange={event => editSettings({ [key]: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>;
  return <div className="field-auto-follow field-servo-ui">
    <section className="field-card"><div className="field-section-heading"><div><h2>{segmented ? "分段采集配置" : "自动跟随配置"}</h2><p>{config.turbine || config.name || "请先在数据采集填写风机任务"}</p></div><Button type="button" variant="ghost" disabled={locked} onClick={onAcquisition}>前往数据采集</Button></div>
      <div className="field-auto-core field-auto-survey-core">{numeric("叶轮每圈时间 · s", "periodSeconds", 0, 3600, .5)}{segmented ? <>
        <label>每次开始采集<CustomSelect aria-label="每次开始采集" value={segment.pointsPerStart} disabled={locked} onChange={event => editSegment({ pointsPerStart: Number(event.target.value) as 1 | 2 })}><option value={1}>单点采集</option><option value={2}>两点采集</option></CustomSelect></label>
        <label>圆周移动间隔<CustomSelect aria-label="圆周移动间隔" value={segment.stepDeg} disabled={locked || segment.pointsPerStart === 2} onChange={event => editSegment({ stepDeg: Number(event.target.value) })}>{(segment.pointsPerStart === 2 ? [segmentedPairStepDeg] : [180, 120, 90, 60, 45, 30, 22.5]).map(value => <option key={value} value={value}>{value}° · 一圈 {360 / value} 个点位{segment.pointsPerStart === 2 ? "（固定）" : ""}</option>)}</CustomSelect></label>
      </> : <><label>圆周点位间隔<CustomSelect aria-label="圆周点位间隔" value={draft.stepDeg} disabled={locked} onChange={event => editSettings({ stepDeg: Number(event.target.value) })}>{[180, 120, 90, 60, 45, 30, 22.5, ...(draft.stepDeg < 22.5 ? [draft.stepDeg] : [])].map(value => <option key={value} value={value}>{value}° · {360 / value} 个点位{value < 22.5 ? "（超过预存上限，请调整）" : ""}</option>)}</CustomSelect></label>{numeric("每个测点采集轮数", "cycles", 1, 100, 1)}</>}</div>
      <details className="field-auto-setup"><summary>测量与连接设置 <span>距离、离地高度与设备连接</span></summary>
        <div className="field-auto-grid">{numeric("设备至叶轮平面 · m", "distanceM", .001, 10000, .01)}<label>激光出射点离地高度 · m<input aria-label="激光出射点离地高度 · m" type="number" min={0} max={10000} step={.01} placeholder="填写出射点的实际高度" value={Number.isFinite(survey.heights?.laserHeightM) ? survey.heights?.laserHeightM : ""} disabled={locked} onChange={event => editHeight("laserHeightM", event.target.value)} /></label><label>叶轮旋向<CustomSelect aria-label="叶轮旋向" value={draft.direction} disabled={locked} onChange={event => editSettings({ direction: event.target.value as AutoFollowDraft["direction"] })}><option value="clockwise">顺时针</option><option value="counterclockwise">逆时针</option></CustomSelect></label></div>
        <div className="field-auto-heights">
          <div className="field-auto-height-result"><span>{survey.heights ? "风机旋转中心与激光高差（自动）" : "原有风机旋转中心与激光高差"}</span><output aria-label="风机旋转中心与激光高差">{numberText(draft.hubHeightDeltaM, 3)} m</output></div>
          <details className="field-auto-hub-height"><summary>风机旋转中心高度 <span>{Number.isFinite(survey.heights?.hubHeightM) ? `${numberText(survey.heights?.hubHeightM, 3)} m` : "首次设置"}</span></summary><label>风机旋转中心离地高度 · m<input aria-label="风机旋转中心离地高度 · m" type="number" min={0} max={10000} step={.01} value={Number.isFinite(survey.heights?.hubHeightM) ? survey.heights?.hubHeightM : ""} disabled={locked} onChange={event => editHeight("hubHeightM", event.target.value)} /></label></details>
          <p className="field-subtext">{survey.heights ? "高差 = 风机旋转中心离地高度 − 激光出射点离地高度。风机旋转中心高度在安装位置变化时调整。" : "补充风机旋转中心高度和激光出射点高度后，自动计算高差。"}</p>
        </div>
        <div className="field-auto-grid"><label>采集设备 IP<input aria-label="自动跟随设备 IP" value={config.deviceIp} disabled={locked} onChange={event => onConfig(previous => ({ ...previous, deviceIp: event.target.value }))} /></label><label>本机设备网卡 IP<input aria-label="自动跟随本机 IP" value={config.hostIp} disabled={locked} onChange={event => onConfig(previous => ({ ...previous, hostIp: event.target.value }))} /></label><label>{connectionPort ? "转盘连接" : "转盘串口"}<div className="field-auto-port-control"><input aria-label="自动跟随转盘串口" readOnly={!!connectionPort} list="field-auto-ports" value={port} disabled={locked} placeholder="选择设备串口" onChange={event => { portEdited.current += 1; setSurvey(previous => ({ ...previous, port: normalizeTurntablePort(event.target.value) })); }} />{!connectionPort && <Button type="button" variant="ghost" aria-label="刷新转盘串口" title="刷新串口" disabled={locked || portsBusy} onClick={() => void refreshPorts()}>{portsBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</Button>}</div><datalist id="field-auto-ports">{ports.map(item => <option value={item.port} key={item.port}>{item.description}</option>)}</datalist></label></div>
        {portsError && <p className="field-subtext" role="status">{portsError}</p>}
      </details>
      <div className="field-auto-points-heading"><h3>叶片与测点</h3><Button type="button" disabled={locked || survey.blades.length >= 12} onClick={() => {
        const id = globalThis.crypto.randomUUID(), pointId = globalThis.crypto.randomUUID(), used = new Set(survey.blades.map(item => item.name.trim()));
        let number = 1; while (used.has(String(number))) number++;
        setSurvey(previous => ({ ...previous, blades: [...previous.blades, { id, name: String(number), points: [{ id: pointId, name: "P1", radiusM: NaN }] }], selectedBladeId: id, selectedPointId: pointId }));
        onAutoTarget?.(autoFollowTargetKey(id, pointId));
      }}><Plus size={14} />添加叶片</Button></div>
      <div className="field-auto-blade-choices" role="group" aria-label="配置叶片">{survey.blades.map(item => <button type="button" className="field-auto-blade-choice" aria-pressed={item.id === survey.selectedBladeId} disabled={locked} key={item.id} onClick={() => selectTarget(item.id, item.points[0]?.id || "")}><strong>叶片 {item.name || "未命名"}</strong><span>{item.points.length} 个测点</span></button>)}</div>
      {blade && <><div className="field-auto-blade-editor"><label>叶片编号<input aria-label="目标叶片编号" maxLength={80} value={blade.name} disabled={locked} onChange={event => setSurvey(previous => ({ ...previous, blades: previous.blades.map(item => item.id === blade.id ? { ...item, name: event.target.value } : item) }))} /></label><Button type="button" variant="ghost" disabled={locked || survey.blades.length <= 1} onClick={() => {
        const blades = survey.blades.filter(item => item.id !== blade.id), first = blades[0];
        setSurvey(previous => ({ ...previous, blades, selectedBladeId: first.id, selectedPointId: first.points[0]?.id || "" }));
        onAutoTarget?.(autoFollowTargetKey(first.id, first.points[0]?.id || ""));
      }}><Trash2 size={14} />移除当前叶片</Button><Button type="button" disabled={locked || blade.points.length >= 40} onClick={() => {
        const id = globalThis.crypto.randomUUID(), used = new Set(blade.points.map(point => point.name));
        let index = 1; while (used.has(`P${index}`)) index++;
        setSurvey(previous => ({ ...previous, blades: previous.blades.map(item => item.id === blade.id ? { ...item, points: [...item.points, { id, name: `P${index}`, radiusM: NaN }] } : item), selectedPointId: id }));
        onAutoTarget?.(autoFollowTargetKey(blade.id, id));
      }}><Plus size={14} />添加测点</Button></div>
      <div className="field-auto-point-generator">
        <div className="field-auto-generator-controls">
          <label>叶片长度 · m<input aria-label="叶片长度 · m" type="number" min={.001} max={1000} step={.01} placeholder="风机转轴中心到叶尖的距离" value={Number.isFinite(blade.lengthM) ? blade.lengthM : ""} disabled={locked} onChange={event => editBlade({ lengthM: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
          <label>叶根预留 · %<input aria-label="叶根预留 · %" type="number" min={0} max={99.99} step={.1} value={Number.isFinite(blade.rootReservePercent ?? 10) ? blade.rootReservePercent ?? 10 : ""} disabled={locked} onChange={event => editBlade({ rootReservePercent: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
          <label>叶尖预留 · %<input aria-label="叶尖预留 · %" type="number" min={0} max={99.99} step={.1} value={Number.isFinite(blade.tipReservePercent ?? 10) ? blade.tipReservePercent ?? 10 : ""} disabled={locked} onChange={event => editBlade({ tipReservePercent: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
          <Button type="button" disabled={locked} onClick={generatePoints}>生成5个测点</Button>
        </div>
        <p className="field-subtext">叶片长度从风机转轴中心量到叶尖。在两端预留后的区间内等分生成5个测点，各点距离仍可手动修改。重新生成会替换当前测点配置，已保存记录保留。</p>
        {generationError && <p className="field-error" role="alert">{generationError}</p>}
      </div>
      <div className="field-auto-points" role="radiogroup" aria-label="本次采集测点">{blade.points.map((point, index) => {
        const pointDraft = surveyDraft(survey, blade.id, point.id), calibration = usableAnchor(pointDraft, blade.id, point.id);
        const key = autoFollowTargetKey(blade.id, point.id);
        const segmentedPointPlan = segmented ? planSegmentedFollow(pointDraft, segmentFor(key), calibration?.value || null, motionMode, port, commonOrigin) : null;
        const pointPlan = segmentedPointPlan || planAutoFollow(pointDraft, calibration?.value || null, motionMode, port, commonOrigin), start = pointPlan.points[0];
        const calculatedStart = calibration ? planAutoFollow(pointDraft, null, motionMode, port, commonOrigin).points[0] : null;
        return <div className="field-auto-point" data-selected={point.id === survey.selectedPointId} key={point.id || index}>
          <input className="field-auto-point-choice" type="radio" name="auto-follow-point" aria-label={`选择测点${index + 1}`} checked={point.id === survey.selectedPointId} disabled={locked} onChange={() => selectTarget(blade.id, point.id)} />
          <label>测点名称<input aria-label={`测点${index + 1}名称`} value={point.name} maxLength={80} disabled={locked} onChange={event => editPoint({ name: event.target.value }, point.id)} /></label>
          <label>距风机旋转中心 · m<input aria-label={`测点${index + 1}半径`} type="number" min={.001} max={1000} step={.01} placeholder="填写实测距离" value={Number.isFinite(point.radiusM) ? point.radiusM : ""} disabled={locked} onChange={event => editPoint({ radiusM: event.target.value === "" ? NaN : Number(event.target.value) }, point.id)} /></label>
          <Button type="button" variant="ghost" aria-label={`移除测点${index + 1}`} disabled={locked || blade.points.length <= 1} onClick={() => {
            const points = blade.points.filter(item => item.id !== point.id), selected = point.id === survey.selectedPointId ? points[0].id : survey.selectedPointId;
            setSurvey(previous => ({ ...previous, blades: previous.blades.map(item => item.id === blade.id ? { ...item, points } : item), selectedPointId: selected }));
            onAutoTarget?.(autoFollowTargetKey(blade.id, selected));
          }}><Trash2 size={15} /></Button>
          <div className="field-auto-point-tools"><span className="field-auto-point-angle">{segmented ? `本段起点 ${segmentFor(key).startAzimuthDeg}°：` : "首个点位："}俯仰 {numberText(toWorkAngle(start?.axis1AngleDeg, 1, currentOrigin), 3)}° · 水平 {numberText(toWorkAngle(start?.axis2AngleDeg, 2, currentOrigin), 3)}°</span>{calibration && <span className="field-badge green">已记录首个点位</span>}<div className="field-auto-point-buttons"><Button type="button" disabled={locked || !isTurntablePort(port) || !Number.isFinite(point.radiusM) || point.radiusM <= 0} aria-label={`校准测点${index + 1}`} onClick={() => void readAnchor(point.id)}><Crosshair size={14} />{pending === `calibrate:${key}` ? "读取中…" : segmented ? "校准0°点" : "校准"}</Button>{calibration && <Button type="button" variant="ghost" disabled={locked} aria-label={`恢复测点${index + 1}计算角度`} onClick={() => setAnchors(previous => { const next = { ...previous }; delete next[key]; return next; })}>恢复计算</Button>}</div>{calibration && calculatedStart && <span className="field-auto-point-offset field-auto-point-angle" aria-label={`测点${index + 1}整圈修正量`}>整圈角度修正：俯仰 {numberText(calibration.value.axis1AngleDeg - calculatedStart.axis1AngleDeg, 3)}° · 水平 {numberText(calibration.value.axis2AngleDeg - calculatedStart.axis2AngleDeg, 3)}°</span>}</div></div>;
      })}</div></>}
      <p className="field-subtext">校准前，将测点放在旋转中心正下方并瞄准；未校准时按尺寸计算。</p>
      <div className="field-inline-help"><label><input type="checkbox" aria-label="测试：未停稳时判定叶片" checked={survey.settings.diagnosticDetectBeforeSettled === true} disabled={locked} onChange={event => editSettings({ diagnosticDetectBeforeSettled: event.target.checked })} /> 测试：未停稳时判定叶片</label>{survey.settings.diagnosticDetectBeforeSettled && <label>未停稳判定角度范围<CustomSelect aria-label="未停稳判定角度范围" value={survey.settings.diagnosticAngleWindowDeg ?? 0} disabled={locked} onChange={event => editSettings({ diagnosticAngleWindowDeg: Number(event.target.value) })}>{[.5, 1, 2, 3, 5, 10].map(value => <option key={value} value={value}>±{value}°</option>)}<option value={0}>不限制角度</option></CustomSelect></label>}<p>{(survey.settings.diagnosticAngleWindowDeg ?? 0) > 0 ? `两轴进入目标 ±${survey.settings.diagnosticAngleWindowDeg}° 范围后开始判定` : "不限制距目标的角度，移动途中即判定"}，跳过初段扰动过滤；进入20 ms、离开30 ms沿用下方设置。提前判定的经过会保留，当前运动结束后再换点。仅用于流程测试，记录标记为诊断数据。</p></div>
      <details className="field-auto-setup"><summary>叶片进入与离开判定 <span>使用 RSSI 回波</span></summary><div className="field-auto-grid">{!plan.manualRotation && numeric("单站最多等待 · 圈", "waitRevolutions", 1, 10, 1)}{numeric("进入回波波动阈值 · 百分点", "rssiEnterSpread", .1, 100, .1)}{numeric("离开回波波动阈值 · 百分点", "rssiExitSpread", 0, 99.9, .1)}{numeric("进入确认时间 · ms", "rssiEnterConfirmMs", 10, 1000, 10)}{numeric("离开确认时间 · ms", "rssiConfirmMs", 10, 1000, 10)}</div></details>
      <details className="field-auto-setup field-auto-turntable-setup" open={segmented}><summary>转盘安装设置 <span>{segmented ? "移动速度与驱动加减速" : "安装或接线变化时调整"}</span></summary><div className="field-auto-grid"><label>俯仰轴方向<CustomSelect aria-label="俯仰轴方向" value={draft.axis1Sign} disabled={locked} onChange={event => editSettings({ axis1Sign: Number(event.target.value) as 1 | -1 })}><option value={1}>抬高瞄准点时角度增加</option><option value={-1}>抬高瞄准点时角度减小</option></CustomSelect></label><label>水平轴方向<CustomSelect aria-label="水平轴方向" value={draft.axis2Sign} disabled={locked} onChange={event => editSettings({ axis2Sign: Number(event.target.value) as 1 | -1 })}><option value={1}>向右瞄准时角度增加</option><option value={-1}>向右瞄准时角度减小</option></CustomSelect></label>{numeric("俯仰角校正系数", "pitchAngleScale", .5, 1.5, .000001)}{numeric("水平角校正系数", "yawAngleScale", .5, 1.5, .000001)}{numeric(segmented ? "点位移动速度 · rpm" : "两轴换点转速上限 · rpm", "maxMoveRpm", .02, 10, .02)}{motionMode !== "drive_internal" && numeric(segmented ? "旧轨迹加速度上限 · °/s²" : "换点加速度上限 · °/s²", "maxMoveAccelerationDegS2", .1, 120, .1)}{numeric(motionMode === "drive_internal" ? "运动中行程误差上限 · °" : "运动中跟随误差上限 · °", "followErrorLimitDeg", .5, 10, .05)}</div>
        <p className="field-subtext">1表示不校正。按当前安装实测填写，所有测点共用；仅调整计算角度，不改变作业原点和测点半径。校正后先验证P1，再验证其他测点。</p>
        {segmented && <>
          <FieldDriveProfile port={port} status={status} disabled={disabled || !!pending || pollUnavailable}
            request={request} onStatus={onStatus} onBusy={setProfileBusy} expanded
            onFastPreset={() => editSettings({ maxMoveRpm: driveProfileFastPreset.speedRpm })} />
        </>}
      </details>
    </section>
      {blockers.length > 0 && !cycleRunning && <div className="field-auto-blockers" role="status"><strong>当前测点还需完成</strong><ul>{blockers.map(item => <li key={item}>{item}</li>)}</ul></div>}
      {error && <p className="field-error" role="alert">{error}</p>}{notice && <p className="field-success" role="status">{notice}</p>}

  </div>;
}

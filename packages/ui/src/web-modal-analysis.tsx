"use client";
import React, {useCallback} from 'react';
import {api} from './api';
import {FieldModalWorkspace} from './field-modal-workspace';
import type {FieldRequestOptions} from './field-types';

const noRecordings: never[] = [];
const noCapture = () => {};

/** Match the desktop bridge contract while Web jobs run asynchronously. */
export async function webModalRequest<T>(options: FieldRequestOptions): Promise<T> {
  if (options.action !== 'formalModal') throw Error('此页面仅支持模态分析操作');
  const {operation, parameters = {}} = options.request as any;
  const send = (body: any) => api<any>('measurements/formal-modal', 'POST', body);
  if (operation === 'catalog' || operation === 'preview' || operation === 'import')
    return send({action: operation, ...parameters});
  if (operation === 'start') {
    let state = await send({action: 'start', ...parameters});
    const deadline = Date.now() + 240_000;
    while (state.status === 'running' || state.status === 'queued') {
      if (Date.now() > deadline) throw Error('分析仍在进行，请刷新批次查看结果');
      await new Promise(resolve => setTimeout(resolve, 500));
      state = await send({action: 'status', id: state.id});
    }
    if (state.status !== 'complete') throw Error(state.error || '模态分析未完成');
    return {job: state, result: state.result} as T;
  }
  if (operation === 'result') {
    const state = await send({action: 'result', id: parameters.jobId});
    return {job: state, result: state.result} as T;
  }
  throw Error('不支持的模态操作');
}

export function WebModalAnalysis({canWrite}: {canWrite: boolean}) {
  const request = useCallback(webModalRequest, []);
  return <FieldModalWorkspace view="analysis" recordings={noRecordings} request={request}
    onStartCapture={noCapture} canAnalyze={canWrite} allowImport />;
}

type RecordSummary = { recording_id: string; representative?: string };
type Options = {
  records: RecordSummary[];
  jobId: string;
  web: boolean;
  representativeOnly: boolean;
  current: () => boolean;
  request: (body: any) => Promise<any>;
  onBatch: (details: Record<string, any>) => void;
};

// A Web batch shares one Python reader instead of starting a process for every
// record. Keep batches bounded for payload size, cancellation and progressive UI.
export async function loadAnalysisDetails(options: Options) {
  const loaded: Record<string, any> = {};
  const size = options.web ? 5 : 1;
  for (let start = 0; start < options.records.length; start += size) {
    if (!options.current()) return;
    const batch = options.records.slice(start, start + size);
    const selections = batch.map(r => ({ recordingId: r.recording_id,
      ...(options.representativeOnly && r.representative ? { segmentId: r.representative } : {}) }));
    try {
      const response = await options.request(options.web
        ? { action: 'details', jobId: options.jobId, selections }
        : { action: 'result', jobId: options.jobId, ...selections[0] });
      if (!options.current()) return;
      Object.assign(loaded, options.web ? response.details : { [batch[0].recording_id]: response.detail });
    } catch (error) {
      if (!options.current()) return;
      for (const record of batch) loaded[record.recording_id] = { segments: [], message: (error as Error).message };
    }
    options.onBatch({ ...loaded });
  }
}

/** Indoor 1102 trial: retain entry/debounce and tolerate the noisier background. */
export const rssiDraftDefaults = {
  rssiEnterSpread: 8, rssiExitSpread: 4, rssiEnterConfirmMs: 20, rssiConfirmMs: 30,
  rssiDefaultsVersion: 1,
};

type RssiDraft = Pick<typeof rssiDraftDefaults, "rssiEnterSpread" | "rssiExitSpread" | "rssiEnterConfirmMs" | "rssiConfirmMs"> & {
  rssiDefaultsVersion?: number;
};

/** Upgrade the old default tuple once. Later explicit edits, including 3,
 * retain their version marker and stay editable after another reload. */
export function migrateRssiDraftDefaults<T extends RssiDraft>(current: T, saved: unknown): T {
  if (saved && typeof saved === "object" && !Array.isArray(saved) &&
      !Object.prototype.hasOwnProperty.call(saved, "rssiDefaultsVersion") &&
      current.rssiEnterSpread === 8 && current.rssiExitSpread === 3 &&
      current.rssiEnterConfirmMs === 20 && current.rssiConfirmMs === 30) {
    return { ...current, rssiExitSpread: rssiDraftDefaults.rssiExitSpread };
  }
  return current;
}

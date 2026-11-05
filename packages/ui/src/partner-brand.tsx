import React from 'react';

/** Align the main marks; reserve a separate descender row for IPA and the subtitle. */
export function PartnerBrand({ subtitle }: { subtitle?: string }) {
  return <div className="partner-brand">
    <div className="partner-brand-marks" aria-label="Polytec × Fraunhofer IPA">
      <span className="partner-polytec"><img src="./brand/polytec.png" alt="Polytec" /></span>
      <span className="partner-brand-times" aria-hidden="true">×</span>
      <span className="partner-fraunhofer"><img src="./brand/fraunhofer-transparent.png" alt="Fraunhofer IPA" /></span>
    </div>
    {subtitle && <small>{subtitle}</small>}
  </div>;
}

export function AppSymbol() {
  return <img className="app-symbol" src="./brand/app-icon.png" alt="" />;
}

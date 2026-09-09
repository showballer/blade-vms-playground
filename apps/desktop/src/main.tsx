import React from "react";
import { createRoot } from "react-dom/client";
import { FieldDesktopApp } from "../../../packages/ui/src/field-desktop";
import "@blade/ui/styles.css";
import "../../../packages/ui/src/field-styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FieldDesktopApp />
  </React.StrictMode>,
);

import React from "react";
import { createRoot } from "react-dom/client";
import { BladeApp } from "@blade/ui";
import "@blade/ui/styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BladeApp platform="desktop" />
  </React.StrictMode>,
);

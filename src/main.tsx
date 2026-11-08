import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

if (import.meta.env.VITE_E2E === "true") {
  await import("@wdio/tauri-plugin");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import CameraPublisher from "./components/CameraPublisher";
import "./styles.css";
import "./focus-setup.css";
import "./profile.css";
import "./camera-publisher.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <CameraPublisher />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // PWA installation is optional; the demo remains usable without a service worker.
    });
  });
}

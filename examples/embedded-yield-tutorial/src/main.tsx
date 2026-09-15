import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/inter/index.css";
import "@/index.css";
import App from "@/App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

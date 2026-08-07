import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { createClient } from "./client.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("The page is missing its root element.");

createRoot(root).render(
  <StrictMode>
    <App
      client={createClient({
        authBaseUrl: import.meta.env.VITE_AUTH_BASE_URL,
        apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
      })}
    />
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import { createQueryClient } from "./queryClient";
import App from "./App";
import "./styles.css";

const queryClient = createQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ThemeProvider>
  </StrictMode>,
);

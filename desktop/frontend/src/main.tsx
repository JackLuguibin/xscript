import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ServicesContext, type AppServices } from "./app-context";
import { bootServices } from "./boot";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

bootServices()
  .then((services: AppServices) =>
    root.render(
      <StrictMode>
        <ServicesContext.Provider value={services}>
          <App />
        </ServicesContext.Provider>
      </StrictMode>,
    ),
  )
  .catch((e: unknown) => {
    root.render(<pre role="alert" style={{ padding: 16, color: "#b00020" }}>启动失败：{e instanceof Error ? e.message : String(e)}</pre>);
  });

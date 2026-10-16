import { useServices } from "./app-context";
import { DevicePage } from "./components/DevicePage";
import { t } from "./strings";

export function App() {
  const { inShell } = useServices();
  return (
    <>
      <header className="topbar">
        <h1>{t.appTitle}</h1>
        <nav aria-label="main">
          <span className="tab active">{t.devices}</span>
        </nav>
      </header>
      {!inShell && <div className="banner warn">{t.demoBanner}</div>}
      <main>
        <DevicePage />
      </main>
    </>
  );
}

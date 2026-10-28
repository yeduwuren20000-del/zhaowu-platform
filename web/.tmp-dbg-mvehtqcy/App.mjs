import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.mjs';
import { ToastProvider } from './hooks/useToast.mjs';
import { DashboardPage } from './pages/Dashboard.mjs';
import { LogsPage } from './pages/Logs.mjs';
import { PansPage } from './pages/Pans.mjs';
import { PortsPage } from './pages/Ports.mjs';
import { ProjectsPage } from './pages/Projects.mjs';
import { ServersPage } from './pages/Servers.mjs';
import { SettingsPage } from './pages/Settings.mjs';
import { TimelinePage } from './pages/Timeline.mjs';
import { VaultPage } from './pages/Vault.mjs';
import { WslPage } from './pages/Wsl.mjs';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export default function App() {
  return /*#__PURE__*/_jsx(ToastProvider, {
    children: /*#__PURE__*/_jsx(BrowserRouter, {
      children: /*#__PURE__*/_jsx(Routes, {
        children: /*#__PURE__*/_jsxs(Route, {
          element: /*#__PURE__*/_jsx(AppShell, {}),
          children: [/*#__PURE__*/_jsx(Route, {
            path: "/",
            element: /*#__PURE__*/_jsx(DashboardPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/projects",
            element: /*#__PURE__*/_jsx(ProjectsPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/servers",
            element: /*#__PURE__*/_jsx(ServersPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/ports",
            element: /*#__PURE__*/_jsx(PortsPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/pans",
            element: /*#__PURE__*/_jsx(PansPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/logs",
            element: /*#__PURE__*/_jsx(LogsPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/timeline",
            element: /*#__PURE__*/_jsx(TimelinePage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/settings",
            element: /*#__PURE__*/_jsx(SettingsPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/vault",
            element: /*#__PURE__*/_jsx(VaultPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "/wsl",
            element: /*#__PURE__*/_jsx(WslPage, {})
          }), /*#__PURE__*/_jsx(Route, {
            path: "*",
            element: /*#__PURE__*/_jsx(Navigate, {
              to: "/",
              replace: true
            })
          })]
        })
      })
    })
  });
}
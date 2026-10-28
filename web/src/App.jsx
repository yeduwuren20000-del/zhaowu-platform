import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell.jsx'
import { ToastProvider } from './hooks/useToast.jsx'
import { EmbedProvider } from './hooks/useEmbed.jsx'
import { DashboardPage } from './pages/Dashboard.jsx'
import DockerPage from './pages/Docker.jsx'
import { LogsPage } from './pages/Logs.jsx'
import { MediaPage } from './pages/Media.jsx'
import { PansPage } from './pages/Pans.jsx'
import { PortsPage } from './pages/Ports.jsx'
import { ProjectsPage } from './pages/Projects.jsx'
import { ServersPage } from './pages/Servers.jsx'
import { SettingsPage } from './pages/Settings.jsx'
import { TimelinePage } from './pages/Timeline.jsx'
import { VaultPage } from './pages/Vault.jsx'
import { WslPage } from './pages/Wsl.jsx'
import { ConverterPage } from './pages/Converter.jsx'
import { UptimePage } from './pages/Uptime.jsx'

export default function App() {
  return (
    <ToastProvider>
      <EmbedProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/servers" element={<ServersPage />} />
            <Route path="/ports" element={<PortsPage />} />
            <Route path="/docker" element={<DockerPage />} />
            <Route path="/pans" element={<PansPage />} />
            <Route path="/media" element={<MediaPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/timeline" element={<TimelinePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/vault" element={<VaultPage />} />
          <Route path="/wsl" element={<WslPage />} />
          <Route path="/converter" element={<ConverterPage />} />
          <Route path="/uptime" element={<UptimePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </EmbedProvider>
    </ToastProvider>
  )
}

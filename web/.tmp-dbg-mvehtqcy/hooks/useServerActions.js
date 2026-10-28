import { useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from './useToast.mjs';

/**
 * 服务器操作统一入口：SSH 只读采集 / TCP 探测 / 应用端口探测 / 批量刷新。
 * 首页和服务器页共用，保证提示口径一致。
 */
export function useServerActions(onChanged) {
  const toast = useToast();
  const [busy, setBusy] = useState({});
  async function exec(key, fn, onResult) {
    setBusy(prev => ({
      ...prev,
      [key]: true
    }));
    try {
      const data = await fn();
      onResult?.(data, toast);
      await onChanged?.();
      return data;
    } catch (error) {
      toast.error('操作失败', error.message);
      return null;
    } finally {
      setBusy(prev => {
        const next = {
          ...prev
        };
        delete next[key];
        return next;
      });
    }
  }
  return {
    busy,
    isBusy: key => Boolean(busy[key]),
    /** SSH 只读采集：资源 + 真实监听端口 + 端口核对 */
    sshProbe: server => exec(`ssh:${server.id}`, () => api.sshProbeServer(server.id, true), (data, t) => {
      if (data?.error) {
        t.error(`${server.name}：SSH 采集失败`, `${data.error.message}${data.error.code ? `（${data.error.code}）` : ''}`);
        return;
      }
      const audit = data?.audit?.summary;
      const resources = data?.metrics;
      t.success(`${server.name}：SSH 采集成功`, `${resources?.hostname || server.host} · 延迟 ${data?.server?.monitor?.latencyMs ?? '—'}ms · ` + `监听端口 ${audit?.totalListening ?? 0} 个（未登记 ${audit?.listeningNotRecorded ?? 0}、未监听 ${audit?.recordedNotListening ?? 0}）`);
    }),
    tcpProbe: server => exec(`tcp:${server.id}`, () => api.probeServer(server.id), (data, t) => {
      t[data?.online ? 'success' : 'warn'](`${server.name} ${data?.online ? 'TCP 可达' : 'TCP 不可达'}`, data?.online ? `SSH 端口 ${server.sshPort || 22} 可连接（${data.latencyMs}ms）` : '目标端口未开放或网络不通');
    }),
    probeAll: () => exec('all:tcp', () => api.probeAllServers(true), (data, t) => {
      t.info('TCP 批量探测完成', `已探测 ${data?.probed ?? 0} 台`);
    }),
    sshProbeAll: () => exec('all:ssh', () => api.sshProbeAll(true), (data, t) => {
      if (!data) return;
      if (data.probed === 0) {
        t.info('SSH 采集已跳过', data.skipped > 0 ? '所有服务器最近都采集过，可稍后再试' : '没有启用 SSH 监控的服务器');
        return;
      }
      const level = data.failed > 0 ? 'warn' : 'success';
      t[level](`SSH 采集完成：成功 ${data.probed - data.failed}/${data.probed}`, `并发上限 ${data.concurrency}${data.failed ? ` · 失败 ${data.failed} 台（详见日志中心）` : ''}`);
    }),
    probeApp: (server, app) => exec(`app:${server.id}:${app.id}`, () => api.probeServerApp(server.id, app.id), (data, t) => {
      t[data?.online ? 'success' : 'warn'](`${app.name} @ ${server.name}`, data?.online ? `端口 ${app.port} 可达（${data.latencyMs}ms）` : `端口 ${app.port} 不可达：${data?.error || '无响应'}`);
    })
  };
}
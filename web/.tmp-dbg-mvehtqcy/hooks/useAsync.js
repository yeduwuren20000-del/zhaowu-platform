import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 极简数据请求 hook：loading / error / data + reload。
 * 组件卸载后不再 setState，避免 React 警告。
 */
export function useAsync(fn, {
  immediate = true,
  deps = []
} = {}) {
  const [state, setState] = useState({
    data: null,
    loading: Boolean(immediate),
    error: null
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async (...args) => {
    setState(prev => ({
      ...prev,
      loading: true,
      error: null
    }));
    try {
      const data = await run(...args);
      if (alive.current) setState({
        data,
        loading: false,
        error: null
      });
      return data;
    } catch (error) {
      if (alive.current) setState(prev => ({
        data: prev.data,
        loading: false,
        error
      }));
      throw error;
    }
  }, [run]);
  useEffect(() => {
    if (!immediate) return;
    reload().catch(() => {});
  }, [immediate, reload]);
  return {
    ...state,
    reload,
    setData: data => setState(prev => ({
      ...prev,
      data
    }))
  };
}

/** 定时轮询：interval 为 0 时关闭（用于"自动刷新"开关） */
export function usePolling(callback, intervalMs = 0, enabled = true) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;
    const timer = setInterval(() => {
      saved.current?.();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
}
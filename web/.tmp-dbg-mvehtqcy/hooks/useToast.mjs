import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const ToastContext = createContext({
  push: () => {}
});
export function ToastProvider({
  children
}) {
  const [toasts, setToasts] = useState([]);
  const remove = useCallback(id => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);
  const push = useCallback(toast => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
    const entry = {
      id,
      type: toast.type || 'info',
      title: toast.title || '',
      message: toast.message || '',
      ttl: toast.ttl ?? 4200
    };
    setToasts(prev => [...prev, entry]);
    if (entry.ttl > 0) setTimeout(() => remove(id), entry.ttl);
    return id;
  }, [remove]);
  const value = useMemo(() => ({
    push,
    success: (title, message) => push({
      type: 'success',
      title,
      message
    }),
    error: (title, message) => push({
      type: 'error',
      title,
      message,
      ttl: 7000
    }),
    warn: (title, message) => push({
      type: 'warn',
      title,
      message,
      ttl: 6000
    }),
    info: (title, message) => push({
      type: 'info',
      title,
      message
    })
  }), [push]);
  return /*#__PURE__*/_jsxs(ToastContext.Provider, {
    value: value,
    children: [children, /*#__PURE__*/_jsx("div", {
      className: "toast-wrap",
      children: toasts.map(toast => /*#__PURE__*/_jsx("div", {
        className: `toast toast--${toast.type}`,
        onClick: () => remove(toast.id),
        role: "status",
        children: /*#__PURE__*/_jsxs("div", {
          children: [toast.title ? /*#__PURE__*/_jsx("div", {
            className: "toast__title",
            children: toast.title
          }) : null, toast.message ? /*#__PURE__*/_jsx("div", {
            className: "toast__msg",
            children: toast.message
          }) : null]
        })
      }, toast.id))
    })]
  });
}
export function useToast() {
  return useContext(ToastContext);
}
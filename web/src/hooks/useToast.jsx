import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const ToastContext = createContext({ push: () => {} })

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const remove = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (toast) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 7)}`
      const entry = { id, type: toast.type || 'info', title: toast.title || '', message: toast.message || '', ttl: toast.ttl ?? 4200 }
      setToasts((prev) => [...prev, entry])
      if (entry.ttl > 0) setTimeout(() => remove(id), entry.ttl)
      return id
    },
    [remove],
  )

  const value = useMemo(
    () => ({
      push,
      success: (title, message) => push({ type: 'success', title, message }),
      error: (title, message) => push({ type: 'error', title, message, ttl: 7000 }),
      warn: (title, message) => push({ type: 'warn', title, message, ttl: 6000 }),
      info: (title, message) => push({ type: 'info', title, message }),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-wrap">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.type}`} onClick={() => remove(toast.id)} role="status">
            <div>
              {toast.title ? <div className="toast__title">{toast.title}</div> : null}
              {toast.message ? <div className="toast__msg">{toast.message}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

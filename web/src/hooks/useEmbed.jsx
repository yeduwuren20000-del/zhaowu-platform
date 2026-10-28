import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { EmbedDrawer } from '../components/EmbedDrawer.jsx'

/**
 * 全站唯一的"内嵌打开"入口。
 *
 * 页面里只要 `const { openEmbed } = useEmbed()` 就能把应用开在工作台内部，
 * 不再是新窗口 → 不再有窗口建立期的白色画布 → 不会闪白。
 * 放 Context 的原因：抽屉只能有一个实例，散在各页面会叠出好几个遮罩。
 */
const EmbedContext = createContext({ openEmbed: () => {}, closeEmbed: () => {} })

export function EmbedProvider({ children }) {
  const [target, setTarget] = useState(null)

  const openEmbed = useCallback((next) => {
    if (!next?.url) return false
    // key 让"重复点同一个应用"也能重新加载，而不是点了没反应
    setTarget({ ...next, key: `${next.url}#${Date.now()}` })
    return true
  }, [])

  const closeEmbed = useCallback(() => setTarget(null), [])

  const value = useMemo(() => ({ openEmbed, closeEmbed }), [openEmbed, closeEmbed])

  return (
    <EmbedContext.Provider value={value}>
      {children}
      <EmbedDrawer target={target} onClose={closeEmbed} />
    </EmbedContext.Provider>
  )
}

export function useEmbed() {
  return useContext(EmbedContext)
}

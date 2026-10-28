/**
 * 复制到剪贴板：优先 Clipboard API，失败退回 execCommand。
 * 桌面端（Electron / WebView）里 Clipboard API 偶尔被拒，留一条退路比报错好。
 * 返回值表示是否成功，调用方据此决定 toast 文案。
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  const fallback = () => {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  };
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 落到 fallback */
  }
  return fallback();
}
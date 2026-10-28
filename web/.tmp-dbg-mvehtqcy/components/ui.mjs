import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.mjs';
import { statusMeta } from '../utils/format.js';
import { friendlyError } from '../utils/errors.js';
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function Button({
  children,
  variant = 'default',
  size = 'md',
  icon,
  loading = false,
  className = '',
  ...rest
}) {
  const classes = ['btn', variant !== 'default' ? `btn--${variant}` : '', size === 'sm' ? 'btn--sm' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/_jsxs("button", {
    type: "button",
    className: classes,
    disabled: loading || rest.disabled,
    ...rest,
    children: [loading ? /*#__PURE__*/_jsx("span", {
      className: "spinner"
    }) : icon ? /*#__PURE__*/_jsx(Icon, {
      name: icon,
      size: size === 'sm' ? 13 : 14
    }) : null, children]
  });
}
export function IconButton({
  icon,
  title,
  onClick,
  disabled
}) {
  return /*#__PURE__*/_jsx("button", {
    type: "button",
    className: "icon-button",
    title: title,
    onClick: onClick,
    disabled: disabled,
    children: /*#__PURE__*/_jsx(Icon, {
      name: icon,
      size: 15
    })
  });
}
export function StatusDot({
  status
}) {
  return /*#__PURE__*/_jsx("span", {
    className: `status-dot status-dot--${status || 'unknown'}`
  });
}
export function statusLabel(status) {
  return statusMeta(status).text;
}
export function Card({
  title,
  subtitle,
  icon,
  actions,
  children,
  flush = false,
  className = ''
}) {
  return /*#__PURE__*/_jsxs("section", {
    className: `card ${className}`,
    children: [title || actions ? /*#__PURE__*/_jsxs("header", {
      className: "card__header",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "card__title",
        children: [icon ? /*#__PURE__*/_jsx(Icon, {
          name: icon,
          size: 15
        }) : null, title, subtitle ? /*#__PURE__*/_jsx("span", {
          className: "card__title-sub",
          children: subtitle
        }) : null]
      }), actions ? /*#__PURE__*/_jsx("div", {
        className: "card__actions",
        children: actions
      }) : null]
    }) : null, /*#__PURE__*/_jsx("div", {
      className: `card__body ${flush ? 'card__body--flush' : ''}`,
      children: children
    })]
  });
}
export function EmptyState({
  title = '暂无数据',
  hint,
  action
}) {
  return /*#__PURE__*/_jsxs("div", {
    className: "empty",
    children: [/*#__PURE__*/_jsx("div", {
      className: "empty__title",
      children: title
    }), hint ? /*#__PURE__*/_jsx("div", {
      children: hint
    }) : null, action ? /*#__PURE__*/_jsx("div", {
      style: {
        marginTop: 12
      },
      children: action
    }) : null]
  });
}
export function Loading({
  text = '加载中…'
}) {
  return /*#__PURE__*/_jsxs("div", {
    className: "loading-row",
    children: [/*#__PURE__*/_jsx("span", {
      className: "spinner"
    }), text]
  });
}

/**
 * 骨架屏：首屏加载时用占位块描出内容的形状，而不是干等一个转圈。
 * 形状贴合各自的列表（标题行 + 细节行），数据到位后整体替换——
 * 页面不会先空一下再跳出来，观感上"一直在加载"。
 */
export function Skeleton({
  width = '100%',
  height = 12
}) {
  return /*#__PURE__*/_jsx("span", {
    className: "skel",
    style: {
      width,
      height
    }
  });
}

/** 列表骨架：贴合「项目行 / 服务器行」的形状（名称 + 两行细节） */
export function SkeletonList({
  rows = 4
}) {
  return /*#__PURE__*/_jsx("div", {
    className: "skel-list",
    children: Array.from({
      length: rows
    }).map((_, index) => /*#__PURE__*/_jsxs("div", {
      className: "skel-list__row",
      children: [/*#__PURE__*/_jsx(Skeleton, {
        width: "32%",
        height: 14
      }), /*#__PURE__*/_jsx(Skeleton, {
        width: "58%",
        height: 10
      }), /*#__PURE__*/_jsx(Skeleton, {
        width: "44%",
        height: 10
      })]
    }, index))
  });
}

/** 日志骨架：左窄右宽的一行行占位，贴合日志面板 */
export function SkeletonLines({
  rows = 8
}) {
  return /*#__PURE__*/_jsx("div", {
    className: "skel-list",
    children: Array.from({
      length: rows
    }).map((_, index) => /*#__PURE__*/_jsx("div", {
      className: "skel-list__row",
      children: /*#__PURE__*/_jsx(Skeleton, {
        width: `${55 + index * 13 % 40}%`,
        height: 10
      })
    }, index))
  });
}
export function Notice({
  tone = 'info',
  icon = 'alert',
  children
}) {
  return /*#__PURE__*/_jsxs("div", {
    className: `notice notice--${tone}`,
    children: [/*#__PURE__*/_jsx(Icon, {
      name: icon,
      size: 14,
      style: {
        marginTop: 2,
        flex: '0 0 auto'
      }
    }), /*#__PURE__*/_jsx("div", {
      children: children
    })]
  });
}

/**
 * 统一的数据错误展示：把技术错误翻译成新手能行动的话（见 friendlyError），
 * 带「重试」按钮和折叠的技术详情。
 * 取代过去散落各页的「读取XX失败：{error.message}」——那种文案对新手等于没写，
 * 而且没有重试，用户唯一的出路是刷新整个页面。
 */
export function ErrorNotice({
  error,
  onRetry,
  retryLoading = false,
  retryLabel = '重试'
}) {
  const friendly = friendlyError(error);
  return /*#__PURE__*/_jsx(Notice, {
    tone: "error",
    icon: "alert",
    children: /*#__PURE__*/_jsxs("div", {
      className: "err",
      children: [/*#__PURE__*/_jsx("div", {
        className: "err__title",
        children: friendly.title
      }), /*#__PURE__*/_jsx("div", {
        className: "err__hint",
        children: friendly.hint
      }), /*#__PURE__*/_jsx("div", {
        className: "err__actions",
        children: onRetry ? /*#__PURE__*/_jsx(Button, {
          size: "sm",
          variant: "primary",
          icon: "refresh",
          loading: retryLoading,
          onClick: onRetry,
          children: retryLabel
        }) : null
      }), friendly.detail ? /*#__PURE__*/_jsxs("details", {
        className: "err__detail",
        children: [/*#__PURE__*/_jsx("summary", {
          children: "\u6280\u672F\u8BE6\u60C5"
        }), /*#__PURE__*/_jsx("code", {
          children: friendly.detail
        })]
      }) : null]
    })
  });
}
export function Modal({
  open,
  title,
  icon,
  onClose,
  children,
  footer,
  size = 'md'
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = event => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return /*#__PURE__*/_jsx("div", {
    className: "modal-overlay",
    onMouseDown: event => event.target === event.currentTarget && onClose?.(),
    children: /*#__PURE__*/_jsxs("div", {
      className: `modal ${size === 'sm' ? 'modal--sm' : ''}`,
      children: [/*#__PURE__*/_jsxs("header", {
        className: "modal__header",
        children: [icon ? /*#__PURE__*/_jsx(Icon, {
          name: icon,
          size: 15
        }) : null, /*#__PURE__*/_jsx("div", {
          className: "modal__title",
          children: title
        }), /*#__PURE__*/_jsx("div", {
          className: "spacer"
        }), /*#__PURE__*/_jsx(IconButton, {
          icon: "x",
          title: "\u5173\u95ED",
          onClick: onClose
        })]
      }), /*#__PURE__*/_jsx("div", {
        className: "modal__body",
        children: children
      }), footer ? /*#__PURE__*/_jsx("footer", {
        className: "modal__footer",
        children: footer
      }) : null]
    })
  });
}
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认删除',
  onConfirm,
  onClose,
  loading,
  secondary = null
}) {
  return /*#__PURE__*/_jsx(Modal, {
    open: open,
    title: title,
    icon: "alert",
    size: "sm",
    onClose: onClose,
    footer: /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsx(Button, {
        onClick: onClose,
        children: "\u53D6\u6D88"
      }), secondary ? /*#__PURE__*/_jsx(Button, {
        icon: "stop",
        loading: secondary.loading,
        onClick: secondary.onClick,
        children: secondary.label
      }) : null, /*#__PURE__*/_jsx(Button, {
        variant: "danger",
        icon: "trash",
        loading: loading,
        onClick: onConfirm,
        children: confirmText
      })]
    }),
    children: /*#__PURE__*/_jsx("div", {
      style: {
        color: 'var(--text-soft)',
        fontSize: 13
      },
      children: message
    })
  });
}
export function Switch({
  checked,
  onChange,
  label
}) {
  return /*#__PURE__*/_jsxs("span", {
    className: `switch ${checked ? 'is-on' : ''}`,
    onClick: () => onChange(!checked),
    children: [/*#__PURE__*/_jsx("span", {
      className: "switch__track"
    }), label]
  });
}
export function Tabs({
  value,
  onChange,
  options
}) {
  return /*#__PURE__*/_jsx("div", {
    className: "tabs",
    children: options.map(option => {
      // 「全部」这类不筛选项用 is-all 区分：视觉更轻，避免和具体筛选条件抢注意力
      const isAll = option.value === 'all';
      return /*#__PURE__*/_jsxs("button", {
        type: "button",
        className: `tab ${isAll ? 'tab--all' : ''} ${option.value === value ? 'is-active' : ''}`,
        onClick: () => onChange(option.value),
        children: [option.label, option.count !== undefined ? ` ${option.count}` : '']
      }, option.value);
    })
  });
}
export function SearchBox({
  value,
  onChange,
  placeholder = '搜索…',
  width
}) {
  return /*#__PURE__*/_jsxs("span", {
    className: "search-inline",
    style: width ? {
      minWidth: width
    } : undefined,
    children: [/*#__PURE__*/_jsx(Icon, {
      name: "search",
      size: 14,
      style: {
        color: 'var(--muted)'
      }
    }), /*#__PURE__*/_jsx("input", {
      value: value,
      placeholder: placeholder,
      onChange: event => onChange(event.target.value)
    }), value ? /*#__PURE__*/_jsx("button", {
      type: "button",
      className: "link",
      onClick: () => onChange(''),
      children: "\u6E05\u9664"
    }) : null]
  });
}
export function Field({
  label,
  hint,
  full = false,
  children
}) {
  return /*#__PURE__*/_jsxs("label", {
    className: `field ${full ? 'field--full' : ''}`,
    children: [/*#__PURE__*/_jsx("span", {
      className: "field__label",
      children: label
    }), children, hint ? /*#__PURE__*/_jsx("span", {
      className: "field__hint",
      children: hint
    }) : null]
  });
}
const TONE_COLOR = {
  green: 'var(--green)',
  blue: 'var(--blue)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  purple: 'var(--purple)',
  cyan: 'var(--cyan)',
  gray: 'var(--muted-2)'
};

/** 资源占用条：默认中性，只有真的偏高才变色 */
export function Meter({
  label,
  percent,
  value,
  hint,
  tone = 'gray',
  width
}) {
  const safePercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null;
  return /*#__PURE__*/_jsxs("div", {
    className: "meter",
    style: width ? {
      width
    } : undefined,
    children: [/*#__PURE__*/_jsxs("div", {
      className: "meter__head",
      children: [/*#__PURE__*/_jsx("span", {
        className: "meter__label",
        children: label
      }), /*#__PURE__*/_jsx("span", {
        className: "meter__value",
        style: tone !== 'gray' ? {
          color: TONE_COLOR[tone]
        } : undefined,
        children: value ?? (safePercent === null ? '—' : `${safePercent.toFixed(0)}%`)
      })]
    }), /*#__PURE__*/_jsx("div", {
      className: "meter__track",
      children: /*#__PURE__*/_jsx("div", {
        className: "meter__fill",
        style: {
          width: `${safePercent ?? 0}%`,
          background: tone === 'gray' ? undefined : TONE_COLOR[tone]
        }
      })
    }), hint ? /*#__PURE__*/_jsx("div", {
      className: "meter__hint",
      children: hint
    }) : null]
  });
}

/** 服务器资源/端口/日志区块用的小标签组 */
export function Fact({
  icon,
  label,
  value,
  tone
}) {
  return /*#__PURE__*/_jsxs("span", {
    className: "fact",
    title: label,
    children: [icon ? /*#__PURE__*/_jsx(Icon, {
      name: icon,
      size: 12
    }) : null, /*#__PURE__*/_jsx("span", {
      className: "fact__label",
      children: label
    }), /*#__PURE__*/_jsx("b", {
      style: tone ? {
        color: TONE_COLOR[tone]
      } : undefined,
      children: value
    })]
  });
}

/**
 * 通用下拉菜单：把低频操作收进「⋯」，让一行只留主操作。
 * 自动处理「点击外部关闭」与「Esc 关闭」，避免各处重复实现。
 *
 * items: [{ key, label, icon, hint, danger?, disabled?, onClick }]
 */
export function Menu({
  trigger,
  items,
  align = 'right',
  width = 200,
  label = '更多操作'
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = event => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const onKey = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return /*#__PURE__*/_jsxs("div", {
    className: "menu-wrap",
    ref: ref,
    children: [trigger({
      open,
      toggle: () => setOpen(prev => !prev),
      ariaLabel: label
    }), open ? /*#__PURE__*/_jsx("div", {
      className: `menu menu--${align}`,
      style: {
        minWidth: width
      },
      children: items.map(item => /*#__PURE__*/_jsxs("button", {
        type: "button",
        className: `menu__item ${item.danger ? 'menu__item--danger' : ''}`,
        disabled: item.disabled,
        onClick: () => {
          setOpen(false);
          item.onClick?.();
        },
        children: [item.icon ? /*#__PURE__*/_jsx(Icon, {
          name: item.icon,
          size: 14
        }) : /*#__PURE__*/_jsx("span", {
          className: "menu__spacer"
        }), /*#__PURE__*/_jsx("span", {
          className: "menu__label",
          children: item.label
        }), item.hint ? /*#__PURE__*/_jsx("span", {
          className: "menu__hint",
          children: item.hint
        }) : null]
      }, item.key))
    }) : null]
  });
}
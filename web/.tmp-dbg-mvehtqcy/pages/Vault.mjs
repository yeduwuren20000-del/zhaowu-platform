import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from '../components/Icons.mjs';
import { Button, Card, EmptyState, Field, Modal, Notice, SkeletonList } from '../components/ui.mjs';
import { PageHint } from '../components/PageHint.mjs';
import { useToast } from '../hooks/useToast.mjs';

/**
 * 内容默认打码，点一下才显示 —— 避免旁观者一眼看到完整私钥。
 * 多行内容（私钥/证书）用「显示 N 行」，单行内容直接显示原值。
 */
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
function ContentCell({
  content
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  if (!content) return /*#__PURE__*/_jsx("span", {
    className: "muted",
    children: "\uFF08\u7A7A\uFF09"
  });
  const isBlock = content.includes('\n');
  if (!isBlock) {
    return /*#__PURE__*/_jsxs("span", {
      className: "secret-inline",
      children: [/*#__PURE__*/_jsx("code", {
        className: "secret-inline__value",
        children: open ? content : '••••••••'
      }), /*#__PURE__*/_jsx("button", {
        type: "button",
        className: "secret-inline__toggle",
        onClick: () => setOpen(p => !p),
        title: open ? '隐藏' : '显示',
        children: /*#__PURE__*/_jsx(Icon, {
          name: open ? 'eye-off' : 'eye',
          size: 13
        })
      }), /*#__PURE__*/_jsx("button", {
        type: "button",
        className: "secret-inline__toggle",
        title: "\u590D\u5236",
        onClick: () => {
          navigator.clipboard?.writeText(content).then(() => toast.success('已复制'), () => toast.error('复制失败，请手动选择'));
        },
        children: /*#__PURE__*/_jsx(Icon, {
          name: "copy",
          size: 13
        })
      })]
    });
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "secret-block",
    children: [/*#__PURE__*/_jsx(Button, {
      size: "sm",
      icon: open ? 'eye-off' : 'eye',
      onClick: () => setOpen(p => !p),
      children: open ? '隐藏' : `显示 ${content.split('\n').length} 行`
    }), open ? /*#__PURE__*/_jsx("pre", {
      className: "secret-block__pre",
      children: content
    }) : null]
  });
}

/** 编辑框：只有标题 + 内容两个字段 */
function EntryForm({
  initial,
  onSubmit,
  onClose,
  submitting
}) {
  const [title, setTitle] = useState(initial?.title || '');
  const [content, setContent] = useState(initial?.content || '');
  return /*#__PURE__*/_jsx(Modal, {
    open: true,
    title: initial?.id ? '编辑' : '新增',
    onClose: onClose,
    footer: /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsx(Button, {
        onClick: onClose,
        children: "\u53D6\u6D88"
      }), /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "check",
        loading: submitting,
        disabled: !title.trim() || !content,
        onClick: () => onSubmit({
          id: initial?.id,
          title,
          content
        }),
        children: "\u4FDD\u5B58"
      })]
    }),
    children: /*#__PURE__*/_jsxs("div", {
      className: "form-grid",
      children: [/*#__PURE__*/_jsx(Field, {
        label: "\u6807\u9898 *",
        full: true,
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: title,
          placeholder: "\u751F\u4EA7\u673A root \u79C1\u94A5",
          onChange: e => setTitle(e.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u5185\u5BB9 *",
        full: true,
        hint: "\u79C1\u94A5\u3001\u5BC6\u7801\u3001Token\u3001\u8BC1\u4E66\u6216\u4EFB\u4F55\u60F3\u8BB0\u4F4F\u7684\u4E1C\u897F\uFF0C\u539F\u6837\u8D34\u8FDB\u6765\u5C31\u884C",
        children: /*#__PURE__*/_jsx("textarea", {
          className: "textarea",
          rows: 9,
          value: content,
          placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----',
          onChange: e => setContent(e.target.value)
        })
      })]
    })
  });
}

/**
 * 凭据库：只有「标题 + 内容」两个概念。
 * 锁着时只有一个主密码输入框；解锁后列出全部条目。
 */
export function VaultPage() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('recoverable');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState('');
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({
    open: false,
    initial: null
  });
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const s = await api.vaultStatus();
      setStatus(s);
      setEntries(s.unlocked ? (await api.vaultEntries()).entries || [] : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  async function unlock() {
    if (!password) return;
    setUnlocking(true);
    setError('');
    try {
      await api.vaultUnlock(password, mode);
      setPassword('');
      await refresh();
      toast.success('已解锁');
    } catch (err) {
      setError(err.message);
    } finally {
      setUnlocking(false);
    }
  }
  async function toggleRecovery(enable) {
    if (!enable && !window.confirm('关闭后如果忘记主密码，凭据将永久无法恢复。确定关闭吗？')) return;
    const input = password || window.prompt('请输入当前主密码以确认身份');
    if (!input) return;
    try {
      await api.vaultSetRecoveryMode(enable, input);
      setPassword('');
      await refresh();
      toast.success(enable ? '已开启本机找回' : '已关闭本机找回');
    } catch (err) {
      toast.error(err.message);
    }
  }
  async function saveEntry(payload) {
    setSaving(true);
    try {
      await api.vaultSaveEntry(payload);
      setForm({
        open: false,
        initial: null
      });
      await refresh();
      toast.success('已保存');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function removeEntry() {
    try {
      await api.vaultDeleteEntry(pendingDelete.id);
      setPendingDelete(null);
      await refresh();
      toast.success('已删除');
    } catch (err) {
      toast.error(err.message);
    }
  }
  const filtered = query ? entries.filter(e => `${e.title} ${e.content}`.toLowerCase().includes(query.toLowerCase())) : entries;

  // 首屏：骨架屏描出列表形状，避免裸转圈
  if (loading) {
    return /*#__PURE__*/_jsxs("div", {
      className: "page",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__header",
        children: /*#__PURE__*/_jsx("div", {
          className: "page__title",
          children: "\u51ED\u636E\u5E93"
        })
      }), /*#__PURE__*/_jsx("div", {
        className: "card",
        children: /*#__PURE__*/_jsx(SkeletonList, {
          rows: 3
        })
      })]
    });
  }

  // ---- 锁态 ----
  if (!status?.unlocked) {
    const isFirstTime = !status?.exists;
    return /*#__PURE__*/_jsxs("div", {
      className: "page",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__header",
        children: /*#__PURE__*/_jsx("div", {
          className: "page__title",
          children: "\u51ED\u636E\u5E93"
        })
      }), /*#__PURE__*/_jsx(Card, {
        children: /*#__PURE__*/_jsxs("div", {
          className: "vault-lock",
          children: [/*#__PURE__*/_jsx(Icon, {
            name: "shield",
            size: 22
          }), /*#__PURE__*/_jsx("div", {
            className: "vault-lock__title",
            children: isFirstTime ? '设置主密码' : '输入主密码解锁'
          }), /*#__PURE__*/_jsx("div", {
            className: "vault-lock__hint",
            children: isFirstTime ? '主密码不会保存。第一次用，可以选是否额外生成一把本机恢复密钥。' : `${status.entryCount} 条凭据以密文保存在磁盘上，解锁后才能查看`
          }), isFirstTime ? /*#__PURE__*/_jsxs("div", {
            className: "vault-modes",
            children: [/*#__PURE__*/_jsxs("label", {
              className: `vault-mode ${mode === 'offline' ? 'is-picked' : ''}`,
              children: [/*#__PURE__*/_jsx("input", {
                type: "radio",
                name: "recovery",
                checked: mode === 'offline',
                onChange: () => setMode('offline')
              }), /*#__PURE__*/_jsxs("div", {
                className: "vault-mode__body",
                children: [/*#__PURE__*/_jsx("div", {
                  className: "vault-mode__title",
                  children: "\u4E0D\u5B58\u4EFB\u4F55\u5BC6\u7801"
                }), /*#__PURE__*/_jsxs("div", {
                  className: "vault-mode__desc",
                  children: ["\u53EA\u5B58\u5728\u4F60\u8111\u5B50\u91CC\u3002\u5BC6\u7801\u5FD8\u4E86 = ", /*#__PURE__*/_jsx("strong", {
                    children: "\u6570\u636E\u6C38\u4E45\u65E0\u6CD5\u6062\u590D"
                  }), "\u3002"]
                })]
              })]
            }), /*#__PURE__*/_jsxs("label", {
              className: `vault-mode ${mode === 'recoverable' ? 'is-picked' : ''}`,
              children: [/*#__PURE__*/_jsx("input", {
                type: "radio",
                name: "recovery",
                checked: mode === 'recoverable',
                onChange: () => setMode('recoverable')
              }), /*#__PURE__*/_jsxs("div", {
                className: "vault-mode__body",
                children: [/*#__PURE__*/_jsx("div", {
                  className: "vault-mode__title",
                  children: "\u672C\u673A\u53EF\u627E\u56DE\uFF08\u63A8\u8350\uFF09"
                }), /*#__PURE__*/_jsxs("div", {
                  className: "vault-mode__desc",
                  children: ["\u989D\u5916\u751F\u6210\u4E00\u628A\u7528 Windows \u52A0\u5BC6\u7684\u6062\u590D\u5BC6\u94A5\uFF0C", /*#__PURE__*/_jsx("strong", {
                    children: "\u540C\u4E00\u53F0\u7535\u8111\u3001\u540C\u4E00\u8D26\u6237"
                  }), "\u53EF\u4EE5\u627E\u56DE\u3002"]
                })]
              })]
            }), /*#__PURE__*/_jsxs("p", {
              className: "vault-mode__note",
              children: ["\u6062\u590D\u5BC6\u94A5", /*#__PURE__*/_jsx("strong", {
                children: "\u6062\u590D\u4E0D\u4E86\u4E3B\u5BC6\u7801\u672C\u8EAB"
              }), "\uFF1B\u5B83\u9632\u7684\u662F\u51ED\u636E\u6587\u4EF6\u88AB\u62F7\u8D70\u540E\u88AB\u89E3\u5F00\u3002"]
            })]
          }) : null, /*#__PURE__*/_jsxs("div", {
            className: "vault-lock__form",
            children: [/*#__PURE__*/_jsx("input", {
              className: "input",
              type: "password",
              value: password,
              placeholder: "\u4E3B\u5BC6\u7801",
              autoFocus: true,
              onChange: e => setPassword(e.target.value),
              onKeyDown: e => e.key === 'Enter' && unlock()
            }), /*#__PURE__*/_jsx(Button, {
              variant: "primary",
              icon: "check",
              loading: unlocking,
              disabled: !password,
              onClick: unlock,
              children: isFirstTime ? '创建' : '解锁'
            })]
          }), error ? /*#__PURE__*/_jsx("p", {
            className: "vault-lock__error",
            children: error
          }) : null, status?.header ? /*#__PURE__*/_jsxs("p", {
            className: "vault-lock__meta",
            children: [status.header.cipher.toUpperCase(), " \xB7 PBKDF2 ", status.header.iterations.toLocaleString(), " \u6B21"]
          }) : null]
        })
      })]
    });
  }

  // ---- 解锁态 ----
  return /*#__PURE__*/_jsxs("div", {
    className: "page",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "page__header",
      children: [/*#__PURE__*/_jsx("div", {
        className: "page__title",
        children: "\u51ED\u636E\u5E93"
      }), /*#__PURE__*/_jsxs("div", {
        className: "page__actions",
        children: [/*#__PURE__*/_jsx("input", {
          className: "input vault-search",
          value: query,
          placeholder: "\u641C\u7D22\u6807\u9898\u6216\u5185\u5BB9",
          onChange: e => setQuery(e.target.value)
        }), /*#__PURE__*/_jsx(Button, {
          icon: "lock",
          onClick: async () => {
            await api.vaultLock().catch(() => {});
            setEntries([]);
            setQuery('');
            await refresh();
            toast.info('已锁定');
          },
          children: "\u9501\u5B9A"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "plus",
          onClick: () => setForm({
            open: true,
            initial: null
          }),
          children: "\u65B0\u589E"
        })]
      })]
    }), /*#__PURE__*/_jsx(PageHint, {
      id: "vault",
      icon: "shield",
      children: "\u5BC6\u7801 / \u79C1\u94A5 / Token \u90FD\u5B58\u8FD9\uFF1A\u78C1\u76D8\u4E0A\u53EA\u6709\u5BC6\u6587\uFF0C\u4E3B\u5BC6\u7801\u53EA\u5728\u5185\u5B58\u91CC\uFF0C\u5185\u5BB9\u9ED8\u8BA4\u6253\u7801\u3001\u70B9\u5F00\u624D\u663E\u793A\u3002\u79BB\u5F00\u65F6\u70B9\u300C\u9501\u5B9A\u300D\u5373\u6E05\u9664\u5185\u5B58\u3002"
    }), /*#__PURE__*/_jsxs(Notice, {
      tone: status?.recovery?.canRecover ? 'info' : 'warn',
      icon: "shield",
      children: ["\u78C1\u76D8\u4E0A\u53EA\u6709\u5BC6\u6587\uFF0C\u4E3B\u5BC6\u7801\u53EA\u5728\u5185\u5B58\u91CC\uFF0C\u70B9\u300C\u9501\u5B9A\u300D\u7ACB\u5373\u6E05\u9664\u3002", status?.recovery?.canRecover ? ' 当前可在本机找回。' : ' 当前无法找回。', ' ', /*#__PURE__*/_jsx("button", {
        type: "button",
        className: "vault-linkbtn",
        onClick: () => toggleRecovery(!status?.recovery?.canRecover),
        children: status?.recovery?.canRecover ? '关闭本机找回' : '开启本机找回'
      })]
    }), entries.length === 0 ? /*#__PURE__*/_jsx(Card, {
      children: /*#__PURE__*/_jsx(EmptyState, {
        title: "\u8FD8\u6CA1\u6709\u5185\u5BB9",
        hint: "\u6807\u9898\u52A0\u4E00\u6BB5\u5185\u5BB9\u5C31\u591F\u4E86\uFF1A\u79C1\u94A5\u3001\u5BC6\u7801\u3001Token\u3001\u8BC1\u4E66\u90FD\u80FD\u8D34\u3002",
        action: /*#__PURE__*/_jsx(Button, {
          variant: "primary",
          icon: "plus",
          onClick: () => setForm({
            open: true,
            initial: null
          }),
          children: "\u65B0\u589E\u7B2C\u4E00\u6761"
        })
      })
    }) : filtered.length === 0 ? /*#__PURE__*/_jsx(Card, {
      children: /*#__PURE__*/_jsx(EmptyState, {
        title: `没有匹配「${query}」的内容`
      })
    }) : /*#__PURE__*/_jsx("div", {
      className: "vault-list",
      children: filtered.map(entry => /*#__PURE__*/_jsxs("div", {
        className: "vault-item",
        children: [/*#__PURE__*/_jsxs("div", {
          className: "vault-item__head",
          children: [/*#__PURE__*/_jsx("span", {
            className: "vault-item__title",
            children: entry.title
          }), /*#__PURE__*/_jsx("span", {
            className: "spacer"
          }), /*#__PURE__*/_jsx(Button, {
            size: "sm",
            icon: "edit",
            onClick: () => setForm({
              open: true,
              initial: entry
            }),
            children: "\u7F16\u8F91"
          }), /*#__PURE__*/_jsx(Button, {
            size: "sm",
            icon: "trash",
            onClick: () => setPendingDelete(entry),
            children: "\u5220\u9664"
          })]
        }), /*#__PURE__*/_jsx(ContentCell, {
          content: entry.content
        })]
      }, entry.id))
    }), form.open ? /*#__PURE__*/_jsx(EntryForm, {
      initial: form.initial,
      submitting: saving,
      onClose: () => setForm({
        open: false,
        initial: null
      }),
      onSubmit: saveEntry
    }) : null, /*#__PURE__*/_jsx(Modal, {
      open: Boolean(pendingDelete),
      title: "\u5220\u9664",
      onClose: () => setPendingDelete(null),
      footer: /*#__PURE__*/_jsxs(_Fragment, {
        children: [/*#__PURE__*/_jsx(Button, {
          onClick: () => setPendingDelete(null),
          children: "\u53D6\u6D88"
        }), /*#__PURE__*/_jsx(Button, {
          variant: "danger",
          icon: "trash",
          onClick: removeEntry,
          children: "\u786E\u8BA4\u5220\u9664"
        })]
      }),
      children: /*#__PURE__*/_jsxs("p", {
        children: ["\u786E\u8BA4\u5220\u9664\u300C", pendingDelete?.title, "\u300D\uFF1F\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002"]
      })
    })]
  });
}
export default VaultPage;
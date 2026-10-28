import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Modal, Button, Field } from './ui.mjs';
import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
function useFormState(initial) {
  const [values, setValues] = useState(initial || {});
  useEffect(() => {
    setValues(initial || {});
  }, [initial]);
  const set = (key, value) => setValues(prev => ({
    ...prev,
    [key]: value
  }));
  return {
    values,
    set,
    setValues
  };
}

/** 项目表单字段的中文名（识别结果里要说清"填了哪个空"） */
const PROJECT_FIELD_LABELS = {
  name: '项目名称',
  type: '项目类型',
  dir: '项目目录',
  startCommand: '启动命令',
  stopCommand: '停止方式',
  port: '端口',
  url: '访问地址'
};

/** 新增 / 编辑本地项目 */
export function ProjectFormModal({
  open,
  initial,
  onClose,
  onSubmit,
  submitting
}) {
  const {
    values,
    set
  } = useFormState(initial);
  const [detect, setDetect] = useState({
    busy: false,
    error: '',
    result: null
  });
  /**
   * 识别自动填过的字段名。用途：换候选命令时，端口/地址是"跟着命令派生"的，
   * 只要用户没手动改过，就该跟着新命令一起换；手动改过的（人的意图）不碰。
   */
  const autoFilled = useRef(new Set());

  // 弹窗换个项目打开时，清掉上一个项目的自动填写记录
  useEffect(() => {
    autoFilled.current.clear();
  }, [initial]);
  const submit = () => {
    const payload = {
      name: (values.name || '').trim(),
      type: (values.type || '').trim(),
      dir: (values.dir || '').trim(),
      startCommand: (values.startCommand || '').trim(),
      stopCommand: (values.stopCommand || '').trim(),
      port: values.port === '' || values.port === undefined ? null : Number(values.port),
      url: (values.url || '').trim() || (values.port ? `http://localhost:${values.port}` : ''),
      remark: (values.remark || '').trim()
    };
    onSubmit(payload);
  };

  /**
   * 用户手动改字段：一旦手动改过，这个字段就不再是"识别自动填的"，
   * 之后换候选命令时不覆盖它（人的意图优先于机器的猜测）。
   * 端口手动改时，如果地址还是自动生成的 localhost 地址，跟着换端口号，
   * 避免存下一个对不上端口的访问地址。
   */
  const manual = key => event => {
    autoFilled.current.delete(key);
    set(key, event.target.value);
    if (key === 'port' && autoFilled.current.has('url')) {
      const next = String(event.target.value).replace(/\D/g, '');
      const current = values.url || '';
      if (/^http:\/\/localhost:\d+$/.test(current)) set('url', next ? `http://localhost:${next}` : '');
    }
  };

  /**
   * 识别目录：只填**空白**字段，已填的一律跳过（与「服务器快速填入」同一口径）。
   * 新手最常见的卡点就是"启动命令不知道填什么"——读一遍 package.json 就能省掉这一步。
   */
  async function runDetect() {
    const dir = (values.dir || '').trim();
    if (!dir) {
      setDetect({
        busy: false,
        error: '先填写项目目录，再点「识别目录」',
        result: null
      });
      return;
    }
    setDetect({
      busy: true,
      error: '',
      result: null
    });
    try {
      const data = await api.detectProject(dir);
      if (data?.ok === false) throw new Error(data.error || '识别失败');
      const filled = [];
      const skipped = [];
      for (const [key, value] of Object.entries(data?.fields || {})) {
        if (value === undefined || value === null || value === '') continue;
        const current = values[key];
        const empty = current === undefined || current === null || current === '';
        if (empty) {
          set(key, value);
          autoFilled.current.add(key);
          filled.push(PROJECT_FIELD_LABELS[key] || key);
        } else {
          skipped.push(PROJECT_FIELD_LABELS[key] || key);
        }
      }
      setDetect({
        busy: false,
        error: '',
        result: {
          ...data,
          filled,
          skipped
        }
      });
    } catch (err) {
      setDetect({
        busy: false,
        error: err.message || '识别失败',
        result: null
      });
    }
  }
  return /*#__PURE__*/_jsxs(Modal, {
    open: open,
    title: initial?.id ? `编辑项目 · ${initial.name}` : '新增本地项目',
    onClose: onClose,
    footer: /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsx(Button, {
        onClick: onClose,
        children: "\u53D6\u6D88"
      }), /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "check",
        loading: submitting,
        onClick: submit,
        children: "\u4FDD\u5B58"
      })]
    }),
    children: [/*#__PURE__*/_jsxs("div", {
      className: "form-grid",
      children: [/*#__PURE__*/_jsx(Field, {
        label: "\u9879\u76EE\u540D\u79F0 *",
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: values.name || '',
          placeholder: "\u4F8B\u5982 Family Album",
          onChange: event => set('name', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u9879\u76EE\u7C7B\u578B",
        hint: "Vue3 / React / FastAPI / Docker / \u6570\u636E\u5E93 \u2026",
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: values.type || '',
          placeholder: "Vue3",
          onChange: event => set('type', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u9879\u76EE\u76EE\u5F55",
        full: true,
        hint: "Windows \u8DEF\u5F84\uFF0C\u4F8B\u5982 D:\\projects\\family-album",
        children: /*#__PURE__*/_jsxs("div", {
          className: "pdet",
          children: [/*#__PURE__*/_jsx("input", {
            className: "input input--tech",
            value: values.dir || '',
            placeholder: "D:\\projects\\my-app",
            onChange: event => set('dir', event.target.value)
          }), /*#__PURE__*/_jsx(Button, {
            size: "sm",
            icon: "search",
            loading: detect.busy,
            onClick: runDetect,
            children: "\u8BC6\u522B\u76EE\u5F55"
          })]
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u542F\u52A8\u547D\u4EE4",
        full: true,
        hint: "\u5728\u9879\u76EE\u76EE\u5F55\u4E0B\u6267\u884C\uFF0C\u4F8B\u5982 npm run dev / python -m uvicorn main:app --port 8000",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.startCommand || '',
          placeholder: "npm run dev",
          onChange: manual('startCommand')
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u505C\u6B62\u65B9\u5F0F",
        full: true,
        hint: "\u7559\u7A7A = \u7ED3\u675F\u8BE5\u9879\u76EE\u8FDB\u7A0B\u6811\uFF08\u63A8\u8350\uFF09\uFF1B\u4E5F\u53EF\u586B docker compose down \u4E4B\u7C7B\u7684\u547D\u4EE4",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.stopCommand || '',
          placeholder: "\u7559\u7A7A\u5373\u53EF",
          onChange: event => set('stopCommand', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u7AEF\u53E3",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.port ?? '',
          placeholder: "5173",
          onChange: manual('port')
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u8BBF\u95EE\u5730\u5740",
        hint: "\u7559\u7A7A\u4F1A\u6309\u7AEF\u53E3\u81EA\u52A8\u751F\u6210 http://localhost:\u7AEF\u53E3",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.url || '',
          placeholder: "http://localhost:5173",
          onChange: manual('url')
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u5907\u6CE8",
        full: true,
        children: /*#__PURE__*/_jsx("textarea", {
          className: "textarea",
          value: values.remark || '',
          placeholder: "\u8FD9\u4E2A\u9879\u76EE\u662F\u505A\u4EC0\u4E48\u7684\u3001\u6CE8\u610F\u4E8B\u9879\u2026",
          onChange: event => set('remark', event.target.value)
        })
      })]
    }), detect.error ? /*#__PURE__*/_jsx("p", {
      className: "pdet__msg pdet__msg--warn pdet__error",
      children: detect.error
    }) : null, detect.result ? /*#__PURE__*/_jsxs("div", {
      className: "pdet__result",
      children: [detect.result.filled.length > 0 ? /*#__PURE__*/_jsxs("p", {
        className: "pdet__msg pdet__msg--ok",
        children: ["\u5DF2\u586B\u5165\uFF1A", detect.result.filled.join('、')]
      }) : null, detect.result.skipped.length > 0 ? /*#__PURE__*/_jsxs("p", {
        className: "pdet__msg",
        children: ["\u5DF2\u8DF3\u8FC7\uFF08\u8FD9\u4E9B\u5B57\u6BB5\u4F60\u586B\u8FC7\u4E86\uFF09\uFF1A", detect.result.skipped.join('、')]
      }) : null, detect.result.matched?.length > 0 ? /*#__PURE__*/_jsxs("p", {
        className: "pdet__msg",
        children: ["\u8BFB\u5230\u7684\u9879\u76EE\u6587\u4EF6\uFF1A", detect.result.matched.join('、')]
      }) : null, (detect.result.notes || []).map(note => /*#__PURE__*/_jsx("p", {
        className: "pdet__msg pdet__msg--warn",
        children: note
      }, note)), (detect.result.candidates?.startCommand || []).length > 1 ? /*#__PURE__*/_jsxs("div", {
        className: "pdet__chips",
        children: [/*#__PURE__*/_jsx("span", {
          className: "pdet__chips-label",
          children: "\u6362\u6761\u542F\u52A8\u547D\u4EE4\uFF1A"
        }), detect.result.candidates.startCommand.map(item => /*#__PURE__*/_jsx("button", {
          type: "button",
          className: "pdet__chip",
          title: item.why,
          onClick: () => {
            set('startCommand', item.command);
            if (!item.port) return;
            // 端口与命令是派生关系：空着、或还是识别自动填的，就跟着新命令换；
            // 用户手动填过的端口是明确意图，不碰。
            const portIsAuto = !values.port || autoFilled.current.has('port');
            if (!portIsAuto) return;
            set('port', item.port);
            autoFilled.current.add('port');
            if (!values.url || autoFilled.current.has('url')) {
              set('url', `http://localhost:${item.port}`);
              autoFilled.current.add('url');
            }
          },
          children: item.command
        }, item.command))]
      }) : null]
    }) : null]
  });
}

/**
 * 服务器「快速填入」：粘贴一段文本，自动拆成表单字段。
 * 口径与后端一致——只填空字段、不覆盖用户已填的内容、解析不出就如实说明。
 */
export function ServerQuickFill({
  values,
  set
}) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function apply() {
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.serverQuickFill(value);
      const fields = data?.fields || {};
      // 只填空字段：已经手工填过的一律保留
      const filled = [];
      const skipped = [];
      for (const [key, fieldValue] of Object.entries(fields)) {
        const current = values[key];
        const empty = current === undefined || current === null || current === '';
        if (empty) {
          set(key, fieldValue);
          filled.push(FIELD_LABELS[key] || key);
        } else {
          skipped.push(FIELD_LABELS[key] || key);
        }
      }
      setResult({
        matched: data?.matched || [],
        notes: data?.notes || [],
        filled,
        skipped
      });
    } catch (err) {
      setError(err.message || '识别失败');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }
  return /*#__PURE__*/_jsxs("div", {
    className: "quickfill",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "quickfill__head",
      children: [/*#__PURE__*/_jsx("span", {
        className: "quickfill__title",
        children: "\u5FEB\u901F\u586B\u5165"
      }), /*#__PURE__*/_jsx("span", {
        className: "quickfill__sub",
        children: "\u7C98\u8D34\u4E0B\u9762\u4EFB\u610F\u4E00\u79CD\uFF0C\u8BC6\u522B\u5230\u7684\u7A7A\u5B57\u6BB5\u4F1A\u81EA\u52A8\u586B\u597D"
      })]
    }), /*#__PURE__*/_jsx("textarea", {
      className: "textarea quickfill__input",
      value: text,
      placeholder: 'ssh -p 2222 -i ~/.ssh/id_ed25519 root@203.0.113.10\n或：deploy@203.0.113.10:2022\n或 .ssh/config 片段 / 云控制台复制的「IP 地址、用户名、端口」',
      onChange: event => {
        setText(event.target.value);
        setResult(null);
        setError('');
      }
    }), /*#__PURE__*/_jsx("div", {
      className: "quickfill__actions",
      children: /*#__PURE__*/_jsx(Button, {
        icon: "refresh",
        loading: busy,
        disabled: !text.trim(),
        onClick: apply,
        children: "\u8BC6\u522B\u5E76\u586B\u5165"
      })
    }), error ? /*#__PURE__*/_jsx("p", {
      className: "quickfill__msg quickfill__msg--warn",
      children: error
    }) : null, result ? /*#__PURE__*/_jsxs("div", {
      className: "quickfill__result",
      children: [result.filled.length > 0 ? /*#__PURE__*/_jsxs("p", {
        className: "quickfill__msg quickfill__msg--ok",
        children: ["\u5DF2\u586B\u5165\uFF1A", result.filled.join('、')]
      }) : null, result.skipped.length > 0 ? /*#__PURE__*/_jsxs("p", {
        className: "quickfill__msg",
        children: ["\u5DF2\u8DF3\u8FC7\uFF08\u8FD9\u4E9B\u5B57\u6BB5\u4F60\u586B\u8FC7\u4E86\uFF09\uFF1A", result.skipped.join('、')]
      }) : null, result.matched.length > 0 ? /*#__PURE__*/_jsxs("p", {
        className: "quickfill__msg",
        children: ["\u8BC6\u522B\u4E3A\uFF1A", result.matched.join(' + ')]
      }) : null, result.notes.map(note => /*#__PURE__*/_jsx("p", {
        className: "quickfill__msg quickfill__msg--warn",
        children: note
      }, note)), !result.filled.length && !result.skipped.length && !result.notes.length ? /*#__PURE__*/_jsx("p", {
        className: "quickfill__msg quickfill__msg--warn",
        children: "\u6CA1\u8BC6\u522B\u51FA\u53EF\u7528\u4FE1\u606F\uFF0C\u53EF\u76F4\u63A5\u624B\u5DE5\u586B\u5199"
      }) : null]
    }) : null]
  });
}
const FIELD_LABELS = {
  name: '名称',
  host: 'IP/域名',
  os: '操作系统',
  sshPort: 'SSH 端口',
  username: '登录用户',
  authType: '认证方式',
  keyPath: '私钥路径',
  passwordEnv: '密码来源',
  remark: '备注'
};

/** 新增 / 编辑服务器（含第二阶段 SSH 只读监控连接配置） */
export function ServerFormModal({
  open,
  initial,
  onClose,
  onSubmit,
  submitting
}) {
  const {
    values,
    set
  } = useFormState(initial);
  const authType = values.authType || 'key';
  const submit = () => {
    onSubmit({
      name: (values.name || '').trim(),
      host: (values.host || '').trim(),
      os: (values.os || '').trim(),
      sshPort: values.sshPort === '' || values.sshPort === undefined ? 22 : Number(values.sshPort),
      user: (values.username || values.user || '').trim(),
      username: (values.username || values.user || '').trim(),
      authType,
      keyPath: (values.keyPath || '').trim(),
      passwordEnv: (values.passwordEnv || '').trim(),
      passphraseEnv: (values.passphraseEnv || '').trim(),
      connectTimeout: values.connectTimeout === '' || values.connectTimeout === undefined ? 8000 : Number(values.connectTimeout),
      monitorEnabled: values.monitorEnabled === undefined ? true : Boolean(values.monitorEnabled),
      logPaths: String(values.logPathsText || '').split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean),
      remark: (values.remark || '').trim()
    });
  };
  return /*#__PURE__*/_jsx(Modal, {
    open: open,
    title: initial?.id ? `编辑服务器 · ${initial.name}` : '新增服务器',
    onClose: onClose,
    footer: /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsx(Button, {
        onClick: onClose,
        children: "\u53D6\u6D88"
      }), /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "check",
        loading: submitting,
        onClick: submit,
        children: "\u4FDD\u5B58"
      })]
    }),
    children: /*#__PURE__*/_jsxs("div", {
      className: "form-grid",
      children: [initial?.id ? null : /*#__PURE__*/_jsx(ServerQuickFill, {
        values: values,
        set: set
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u670D\u52A1\u5668\u540D\u79F0 *",
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: values.name || '',
          placeholder: "\u4E3B\u670D\u52A1\u5668",
          onChange: event => set('name', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "IP / \u57DF\u540D *",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.host || '',
          placeholder: "203.0.113.10 \u6216 server.example.com",
          onChange: event => set('host', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u64CD\u4F5C\u7CFB\u7EDF",
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: values.os || '',
          placeholder: "Ubuntu 22.04",
          onChange: event => set('os', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "SSH \u7AEF\u53E3",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.sshPort ?? '',
          placeholder: "22",
          onChange: event => set('sshPort', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u767B\u5F55\u7528\u6237",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.username || values.user || '',
          placeholder: "root",
          onChange: event => set('username', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u8BA4\u8BC1\u65B9\u5F0F",
        children: /*#__PURE__*/_jsxs("select", {
          className: "select",
          value: authType,
          onChange: event => set('authType', event.target.value),
          children: [/*#__PURE__*/_jsx("option", {
            value: "key",
            children: "\u5BC6\u94A5\u6587\u4EF6\uFF08\u63A8\u8350\uFF09"
          }), /*#__PURE__*/_jsx("option", {
            value: "agent",
            children: "\u672C\u673A SSH Agent"
          }), /*#__PURE__*/_jsx("option", {
            value: "password",
            children: "\u5BC6\u7801\uFF08\u4ECE\u73AF\u5883\u53D8\u91CF/\u51ED\u636E\u6587\u4EF6\u8BFB\u53D6\uFF09"
          })]
        })
      }), authType === 'key' ? /*#__PURE__*/_jsxs(_Fragment, {
        children: [/*#__PURE__*/_jsx(Field, {
          label: "\u79C1\u94A5\u8DEF\u5F84",
          full: true,
          hint: "\u53EA\u4FDD\u5B58\u8DEF\u5F84\uFF0C\u4E0D\u4FDD\u5B58\u79C1\u94A5\u6B63\u6587\uFF1B\u652F\u6301 ~ \u5F00\u5934\u7684\u8DEF\u5F84",
          children: /*#__PURE__*/_jsx("input", {
            className: "input input--tech",
            value: values.keyPath || '',
            placeholder: "C:\\Users\\you\\.ssh\\id_ed25519 \u6216 ~/.ssh/id_ed25519",
            onChange: event => set('keyPath', event.target.value)
          })
        }), /*#__PURE__*/_jsx(Field, {
          label: "\u79C1\u94A5\u53E3\u4EE4\u73AF\u5883\u53D8\u91CF\u540D",
          hint: "\u79C1\u94A5\u6709\u53E3\u4EE4\u65F6\u586B\u5199\u53D8\u91CF\u540D\uFF0C\u53E3\u4EE4\u672C\u8EAB\u4E0D\u4F1A\u5199\u5165\u914D\u7F6E",
          children: /*#__PURE__*/_jsx("input", {
            className: "input input--tech",
            value: values.passphraseEnv || '',
            placeholder: "DSM_SSH_PASSPHRASE_XXX",
            onChange: event => set('passphraseEnv', event.target.value)
          })
        })]
      }) : null, authType === 'password' ? /*#__PURE__*/_jsx(Field, {
        label: "\u5BC6\u7801\u73AF\u5883\u53D8\u91CF\u540D",
        full: true,
        hint: "\u5B89\u5168\u7EA6\u5B9A\uFF1A\u914D\u7F6E\u6587\u4EF6\u91CC\u6C38\u4E0D\u4FDD\u5B58\u5BC6\u7801\u3002\u8BF7\u628A\u5BC6\u7801\u653E\u5230\u73AF\u5883\u53D8\u91CF\uFF08\u9ED8\u8BA4 DSM_SSH_PASSWORD_<\u670D\u52A1\u5668ID>\uFF09\u6216\u9879\u76EE\u5185 data/secrets.json",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.passwordEnv || '',
          placeholder: "\u7559\u7A7A\u5219\u4F7F\u7528 DSM_SSH_PASSWORD_<\u670D\u52A1\u5668ID>",
          onChange: event => set('passwordEnv', event.target.value)
        })
      }) : null, /*#__PURE__*/_jsx(Field, {
        label: "\u8FDE\u63A5\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09",
        hint: "2000 - 60000\uFF0C\u9ED8\u8BA4 8000",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.connectTimeout ?? '',
          placeholder: "8000",
          onChange: event => set('connectTimeout', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "SSH \u76D1\u63A7",
        children: /*#__PURE__*/_jsxs("select", {
          className: "select",
          value: values.monitorEnabled === false ? 'off' : 'on',
          onChange: event => set('monitorEnabled', event.target.value === 'on'),
          children: [/*#__PURE__*/_jsx("option", {
            value: "on",
            children: "\u5F00\u542F\uFF08\u91C7\u96C6\u8D44\u6E90\u4E0E\u771F\u5B9E\u7AEF\u53E3\uFF09"
          }), /*#__PURE__*/_jsx("option", {
            value: "off",
            children: "\u5173\u95ED\uFF08\u53EA\u505A TCP \u63A2\u6D4B\uFF09"
          })]
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u53EF\u8BFB\u65E5\u5FD7\u8DEF\u5F84",
        full: true,
        hint: "\u6BCF\u884C\u4E00\u4E2A\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u53EA\u5141\u8BB8\u8BFB\u53D6\u8FD9\u4E9B\u6587\u4EF6\uFF1B\u65E5\u5FD7\u67E5\u770B\u9875\u6CA1\u6709\u547D\u4EE4\u8F93\u5165\u6846",
        children: /*#__PURE__*/_jsx("textarea", {
          className: "textarea",
          value: values.logPathsText ?? (values.logPaths || []).join('\n'),
          placeholder: '/var/log/nginx/error.log\n/var/log/syslog',
          onChange: event => set('logPathsText', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u5907\u6CE8",
        full: true,
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: values.remark || '',
          placeholder: "\u7528\u9014\u8BF4\u660E",
          onChange: event => set('remark', event.target.value)
        })
      })]
    })
  });
}

/** 新增 / 编辑服务器下的 APP 记录 */
export function AppFormModal({
  open,
  initial,
  serverName,
  onClose,
  onSubmit,
  submitting
}) {
  const {
    values,
    set
  } = useFormState(initial);
  const submit = () => {
    onSubmit({
      name: (values.name || '').trim(),
      port: values.port === '' || values.port === undefined ? null : Number(values.port),
      deployPath: (values.deployPath || '').trim(),
      url: (values.url || '').trim(),
      status: values.status || 'unknown',
      remark: (values.remark || '').trim()
    });
  };
  return /*#__PURE__*/_jsx(Modal, {
    open: open,
    title: initial?.id ? `编辑应用 · ${initial.name}` : `新增应用 / 服务${serverName ? ` · ${serverName}` : ''}`,
    size: "md",
    onClose: onClose,
    footer: /*#__PURE__*/_jsxs(_Fragment, {
      children: [/*#__PURE__*/_jsx(Button, {
        onClick: onClose,
        children: "\u53D6\u6D88"
      }), /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "check",
        loading: submitting,
        onClick: submit,
        children: "\u4FDD\u5B58"
      })]
    }),
    children: /*#__PURE__*/_jsxs("div", {
      className: "form-grid",
      children: [/*#__PURE__*/_jsx(Field, {
        label: "APP / \u670D\u52A1\u540D\u79F0 *",
        hint: "\u4F8B\u5982 Nginx\u3001Dify Web\u3001Ollama API",
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: values.name || '',
          placeholder: "Dify Web",
          onChange: event => set('name', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u7AEF\u53E3",
        children: /*#__PURE__*/_jsx("input", {
          className: "input",
          value: values.port ?? '',
          placeholder: "8080",
          onChange: event => set('port', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u90E8\u7F72\u8DEF\u5F84",
        full: true,
        hint: "\u670D\u52A1\u5668\u4E0A\u7684\u5B9E\u9645\u8DEF\u5F84\uFF0C\u4F8B\u5982 /opt/dify",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.deployPath || '',
          placeholder: "/opt/dify",
          onChange: event => set('deployPath', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u8BBF\u95EE\u5730\u5740",
        children: /*#__PURE__*/_jsx("input", {
          className: "input input--tech",
          value: values.url || '',
          placeholder: "http://203.0.113.10:8080",
          onChange: event => set('url', event.target.value)
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u72B6\u6001",
        children: /*#__PURE__*/_jsxs("select", {
          className: "select",
          value: values.status || 'unknown',
          onChange: event => set('status', event.target.value),
          children: [/*#__PURE__*/_jsx("option", {
            value: "running",
            children: "\u8FD0\u884C\u4E2D"
          }), /*#__PURE__*/_jsx("option", {
            value: "stopped",
            children: "\u5DF2\u505C\u6B62"
          }), /*#__PURE__*/_jsx("option", {
            value: "unknown",
            children: "\u672A\u77E5"
          })]
        })
      }), /*#__PURE__*/_jsx(Field, {
        label: "\u5907\u6CE8",
        full: true,
        children: /*#__PURE__*/_jsx("textarea", {
          className: "textarea",
          value: values.remark || '',
          onChange: event => set('remark', event.target.value)
        })
      })]
    })
  });
}
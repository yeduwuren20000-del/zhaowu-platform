import { useState } from 'react';
import { Button, EmptyState, Notice } from './ui.mjs';
import { formatBytes, formatDateTime, formatPercent, formatUptime, timeAgo } from '../utils/format.js';

/** docker ps 的 State -> 中文短词（键仍是 docker 原词，只翻显示）；颜色只留给需要多看一眼的异常 */
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const STATE_META = {
  running: {
    text: '运行中',
    tone: ''
  },
  exited: {
    text: '已退出',
    tone: 'muted'
  },
  created: {
    text: '已创建',
    tone: 'muted'
  },
  paused: {
    text: '已暂停',
    tone: 'is-warn'
  },
  restarting: {
    text: '重启中',
    tone: 'is-warn'
  },
  dead: {
    text: '已失效',
    tone: 'is-error'
  },
  removing: {
    text: '删除中',
    tone: 'is-warn'
  }
};
const HEALTH_META = {
  healthy: {
    text: '健康',
    tone: 'muted'
  },
  unhealthy: {
    text: '健康检查异常',
    tone: 'is-error'
  },
  starting: {
    text: '启动中',
    tone: 'is-warn'
  }
};
const AUDIT_META = {
  ok: {
    text: '一致',
    tone: 'muted'
  },
  recordedStopped: {
    text: '记录未运行',
    tone: 'is-warn'
  },
  containerNotRecorded: {
    text: '未登记',
    tone: 'is-error'
  }
};
function MiniMeter({
  percent
}) {
  const value = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null;
  const high = value !== null && value >= 90 ? 'var(--red)' : value !== null && value >= 75 ? 'var(--amber)' : undefined;
  return /*#__PURE__*/_jsxs("span", {
    className: "row",
    style: {
      gap: 6
    },
    children: [/*#__PURE__*/_jsx("span", {
      className: "meter__track",
      style: {
        width: 40
      },
      children: /*#__PURE__*/_jsx("span", {
        className: "meter__fill",
        style: {
          width: `${value ?? 0}%`,
          background: high
        }
      })
    }), /*#__PURE__*/_jsx("span", {
      className: "mono",
      style: {
        fontSize: 11.5,
        width: 42,
        color: 'var(--text-soft)'
      },
      children: value === null ? '—' : `${value.toFixed(1)}%`
    })]
  });
}

/** 端口映射展示：8080→3000/tcp */
function PortList({
  ports
}) {
  if (!ports?.length) return /*#__PURE__*/_jsx("span", {
    style: {
      color: 'var(--muted-2)'
    },
    children: "\u2014"
  });
  return /*#__PURE__*/_jsx("span", {
    className: "port-cell",
    children: ports.map(port => /*#__PURE__*/_jsx("span", {
      className: port.published ? '' : 'muted',
      title: port.published ? `${port.hostIp}:${port.hostPort} → 容器 ${port.containerPort}/${port.proto}` : `仅容器内暴露 ${port.containerPort}/${port.proto}`,
      children: port.published ? `${port.hostPort}→${port.containerPort}/${port.proto}` : `${port.containerPort}/${port.proto}`
    }, `${port.hostIp}-${port.hostPort}-${port.containerPort}-${port.proto}`))
  });
}

/**
 * Docker 容器只读面板：
 * 容器列表 / 镜像 / 状态与健康 / 运行时长 / CPU 与内存 / 端口映射 / 与 APP 的三类核对。
 * 第一版严格只读 —— 页面上没有任何 start / stop / restart / exec / rm 入口。
 */
export function DockerPanel({
  server,
  onProbe,
  probing,
  onRegisterPort
}) {
  const [showImages, setShowImages] = useState(false);
  const docker = server.docker || null;
  const summary = docker?.summary || null;
  const auditItems = docker?.audit?.items || [];
  const auditByContainer = new Map();
  for (const item of auditItems) {
    if (item.container?.id) auditByContainer.set(item.container.id, item);
  }
  const auditSummary = docker?.audit?.summary || null;
  const containers = docker?.containers || [];
  const images = docker?.images || [];
  if (!server.ssh?.at) {
    return /*#__PURE__*/_jsx(EmptyState, {
      title: "\u8FD8\u6CA1\u6709\u505A\u8FC7 SSH \u91C7\u96C6",
      hint: "Docker \u4FE1\u606F\u968F SSH \u53EA\u8BFB\u91C7\u96C6\u4E00\u8D77\u83B7\u53D6\uFF08docker ps / images / inspect / stats --no-stream\uFF09\u3002",
      action: /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "wifi",
        loading: probing,
        onClick: () => onProbe?.(server),
        children: "SSH \u68C0\u6D4B"
      })
    });
  }
  if (!server.ssh.ok) {
    return /*#__PURE__*/_jsxs("div", {
      children: [/*#__PURE__*/_jsxs(Notice, {
        tone: "error",
        icon: "alert",
        children: ["SSH \u91C7\u96C6\u5931\u8D25\uFF08", formatDateTime(server.ssh.at), "\uFF09\uFF1A", server.ssh.error]
      }), /*#__PURE__*/_jsx("div", {
        style: {
          marginTop: 10
        },
        children: /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: probing,
          onClick: () => onProbe?.(server),
          children: "\u91CD\u65B0\u68C0\u6D4B"
        })
      })]
    });
  }
  if (!docker) {
    return /*#__PURE__*/_jsx(EmptyState, {
      title: "\u8FD9\u6B21\u91C7\u96C6\u6CA1\u6709 Docker \u6570\u636E",
      hint: "\u53EF\u80FD\u662F\u5728\u300C\u7F16\u8F91\u670D\u52A1\u5668\u300D\u91CC\u5173\u95ED\u4E86 Docker \u91C7\u96C6\uFF0C\u6216\u91C7\u96C6\u5C1A\u672A\u6267\u884C\u3002",
      action: /*#__PURE__*/_jsx(Button, {
        variant: "primary",
        icon: "refresh",
        loading: probing,
        onClick: () => onProbe?.(server),
        children: "\u91CD\u65B0\u91C7\u96C6"
      })
    });
  }
  if (!docker.installed) {
    return /*#__PURE__*/_jsxs(Notice, {
      tone: "info",
      icon: "box",
      children: ["\u8FD9\u53F0\u670D\u52A1\u5668\u6CA1\u6709\u5B89\u88C5 Docker\uFF08", docker.error || '未检测到 docker 命令', "\uFF09\u3002\u5982\u679C\u786E\u5B9E\u6709\u5BB9\u5668\u5728\u8DD1\uFF0C\u8BF7\u68C0\u67E5\u767B\u5F55\u7528\u6237\u7684 PATH \u4E0E\u6743\u9650\u3002"]
    });
  }
  if (!docker.daemonOk) {
    return /*#__PURE__*/_jsxs("div", {
      children: [/*#__PURE__*/_jsxs(Notice, {
        tone: "error",
        icon: "alert",
        children: ["Docker \u5DF2\u5B89\u88C5\u4F46\u4E0D\u53EF\u7528\uFF1A", docker.error]
      }), /*#__PURE__*/_jsx("div", {
        style: {
          marginTop: 10
        },
        children: /*#__PURE__*/_jsx(Button, {
          icon: "refresh",
          loading: probing,
          onClick: () => onProbe?.(server),
          children: "\u91CD\u65B0\u68C0\u6D4B"
        })
      })]
    });
  }
  return /*#__PURE__*/_jsxs("div", {
    children: [/*#__PURE__*/_jsxs("div", {
      className: "row row--wrap",
      style: {
        gap: 10,
        marginBottom: 10
      },
      children: [/*#__PURE__*/_jsxs("span", {
        className: "docker-version",
        children: ["Docker ", docker.version || '—']
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: [summary.total, " \u4E2A\u5BB9\u5668 \xB7 \u8FD0\u884C ", /*#__PURE__*/_jsx("b", {
          children: summary.running
        }), " \xB7 \u505C\u6B62 ", /*#__PURE__*/_jsx("b", {
          children: summary.exited + summary.paused
        }), summary.restarting > 0 ? /*#__PURE__*/_jsxs("span", {
          className: "status-word is-warn",
          children: [" \xB7 \u91CD\u542F\u4E2D ", summary.restarting]
        }) : null, summary.unhealthy > 0 ? /*#__PURE__*/_jsxs("span", {
          className: "status-word is-error",
          children: [" \xB7 \u5065\u5EB7\u68C0\u67E5\u5F02\u5E38 ", summary.unhealthy]
        }) : null, ' ', "\xB7 \u955C\u50CF ", /*#__PURE__*/_jsx("b", {
          children: images.length
        })]
      }), /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["CPU \u5408\u8BA1 ", formatPercent(summary.cpuPercentTotal, 1), " \xB7 \u5185\u5B58\u5408\u8BA1 ", formatBytes(summary.memoryUsedBytes), " \xB7 \u91C7\u96C6\u4E8E ", timeAgo(docker.at)]
      }), /*#__PURE__*/_jsx("div", {
        className: "spacer"
      }), /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "refresh",
        loading: probing,
        onClick: () => onProbe?.(server),
        children: "\u91CD\u65B0\u91C7\u96C6"
      })]
    }), auditSummary ? /*#__PURE__*/_jsxs("div", {
      className: "footnote",
      style: {
        marginBottom: 10
      },
      children: ["\u4E0E APP \u8BB0\u5F55\u6838\u5BF9\uFF1A\u4E00\u81F4 ", /*#__PURE__*/_jsx("b", {
        children: auditSummary.ok
      }), auditSummary.recordedStopped > 0 ? /*#__PURE__*/_jsxs("span", {
        className: "status-word is-warn",
        children: [" \xB7 \u8BB0\u5F55\u672A\u8FD0\u884C ", auditSummary.recordedStopped]
      }) : null, auditSummary.containerNotRecorded > 0 ? /*#__PURE__*/_jsxs("span", {
        className: "status-word is-error",
        children: [" \xB7 \u672A\u767B\u8BB0 ", auditSummary.containerNotRecorded]
      }) : null]
    }) : null, containers.length === 0 ? /*#__PURE__*/_jsx(EmptyState, {
      title: "\u6CA1\u6709\u5BB9\u5668",
      hint: "\u8FD9\u53F0\u673A\u5668\u4E0A docker ps -a \u6CA1\u6709\u4EFB\u4F55\u5BB9\u5668\u3002"
    }) : /*#__PURE__*/_jsx("div", {
      style: {
        overflowX: 'auto'
      },
      children: /*#__PURE__*/_jsxs("table", {
        className: "table",
        children: [/*#__PURE__*/_jsx("thead", {
          children: /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsx("th", {
              children: "\u5BB9\u5668"
            }), /*#__PURE__*/_jsx("th", {
              children: "\u955C\u50CF"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 150
              },
              children: "\u72B6\u6001"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 96
              },
              children: "\u8FD0\u884C\u65F6\u957F"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 108
              },
              children: "CPU"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 168
              },
              children: "\u5185\u5B58"
            }), /*#__PURE__*/_jsx("th", {
              children: "\u7AEF\u53E3\u6620\u5C04"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 132
              },
              children: "\u4E0E APP \u6838\u5BF9"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 118,
                textAlign: 'right'
              },
              children: "\u64CD\u4F5C"
            })]
          })
        }), /*#__PURE__*/_jsx("tbody", {
          children: containers.map(container => {
            const stateMeta = STATE_META[container.state] || {
              text: container.state,
              tone: 'muted'
            };
            const healthMeta = HEALTH_META[container.health] || null;
            const audit = auditByContainer.get(container.id) || null;
            const auditMeta = audit ? AUDIT_META[audit.state] : null;
            const published = container.ports.filter(port => port.published);
            return /*#__PURE__*/_jsxs("tr", {
              children: [/*#__PURE__*/_jsxs("td", {
                children: [/*#__PURE__*/_jsx("span", {
                  className: "docker-name",
                  children: container.name
                }), /*#__PURE__*/_jsxs("div", {
                  className: "mono",
                  style: {
                    fontSize: 11,
                    color: 'var(--muted-2)'
                  },
                  children: [container.shortId, container.composeProject ? ` · ${container.composeProject}/${container.composeService}` : '']
                })]
              }), /*#__PURE__*/_jsx("td", {
                children: /*#__PURE__*/_jsx("span", {
                  className: "mono",
                  style: {
                    fontSize: 11.5,
                    color: 'var(--text-soft)'
                  },
                  children: container.image
                })
              }), /*#__PURE__*/_jsx("td", {
                children: /*#__PURE__*/_jsxs("span", {
                  className: "row row--wrap",
                  style: {
                    gap: 7
                  },
                  children: [/*#__PURE__*/_jsx("span", {
                    className: `status-word ${stateMeta.tone}`,
                    children: stateMeta.text
                  }), healthMeta ? /*#__PURE__*/_jsx("span", {
                    className: `status-word ${healthMeta.tone}`,
                    children: healthMeta.text
                  }) : null, container.restartCount > 0 ? /*#__PURE__*/_jsxs("span", {
                    className: "status-word is-warn",
                    children: ["\u91CD\u542F ", container.restartCount]
                  }) : null]
                })
              }), /*#__PURE__*/_jsx("td", {
                style: {
                  fontSize: 11.5
                },
                children: container.state === 'running' ? formatUptime(container.uptimeSec) : container.runningFor || '—'
              }), /*#__PURE__*/_jsx("td", {
                children: container.state === 'running' ? /*#__PURE__*/_jsx(MiniMeter, {
                  percent: container.cpuPercent
                }) : /*#__PURE__*/_jsx("span", {
                  style: {
                    color: 'var(--muted-2)'
                  },
                  children: "\u2014"
                })
              }), /*#__PURE__*/_jsx("td", {
                children: container.state === 'running' ? /*#__PURE__*/_jsxs("div", {
                  children: [/*#__PURE__*/_jsx(MiniMeter, {
                    percent: container.memoryPercent
                  }), /*#__PURE__*/_jsxs("div", {
                    className: "mono",
                    style: {
                      fontSize: 11,
                      color: 'var(--muted-2)'
                    },
                    children: [formatBytes(container.memoryUsedBytes), container.memoryLimitBytes ? ` / ${formatBytes(container.memoryLimitBytes)}` : '']
                  })]
                }) : /*#__PURE__*/_jsx("span", {
                  style: {
                    color: 'var(--muted-2)'
                  },
                  children: "\u2014"
                })
              }), /*#__PURE__*/_jsx("td", {
                children: /*#__PURE__*/_jsx(PortList, {
                  ports: container.ports
                })
              }), /*#__PURE__*/_jsx("td", {
                children: auditMeta ? /*#__PURE__*/_jsx("span", {
                  className: `status-word ${auditMeta.tone}`,
                  children: auditMeta.text
                }) : /*#__PURE__*/_jsx("span", {
                  style: {
                    color: 'var(--muted-2)'
                  },
                  children: "\u2014"
                })
              }), /*#__PURE__*/_jsx("td", {
                children: /*#__PURE__*/_jsx("div", {
                  className: "table__actions",
                  children: audit?.state === 'containerNotRecorded' && published.length > 0 ? /*#__PURE__*/_jsx(Button, {
                    size: "sm",
                    variant: "primary",
                    icon: "plus",
                    onClick: () => onRegisterPort?.(server, {
                      name: container.name,
                      port: published[0].hostPort,
                      deployPath: '',
                      status: container.state === 'running' ? 'running' : 'stopped',
                      remark: `由 Docker 容器核对登记（镜像 ${container.image}）`
                    }),
                    children: "\u767B\u8BB0\u4E3A APP"
                  }) : /*#__PURE__*/_jsx("span", {
                    className: "row-actions",
                    children: /*#__PURE__*/_jsx(Button, {
                      size: "sm",
                      icon: "copy",
                      onClick: () => navigator.clipboard?.writeText(container.name).catch(() => {}),
                      title: "\u590D\u5236\u5BB9\u5668\u540D\uFF08\u5DE5\u4F5C\u53F0\u4E0D\u63D0\u4F9B\u4EFB\u4F55\u5199\u64CD\u4F5C\uFF09",
                      children: "\u590D\u5236\u540D\u79F0"
                    })
                  })
                })
              })]
            }, container.id);
          })
        })]
      })
    }), /*#__PURE__*/_jsxs("div", {
      className: "row",
      style: {
        marginTop: 12,
        gap: 8
      },
      children: [/*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: showImages ? 'chevronDown' : 'chevronRight',
        onClick: () => setShowImages(prev => !prev),
        children: showImages ? '收起镜像列表' : `展开镜像列表（${images.length}）`
      }), /*#__PURE__*/_jsx("span", {
        style: {
          fontSize: 11.5,
          color: 'var(--muted-2)'
        },
        children: "\u53EA\u8BFB\u91C7\u96C6\uFF1Adocker ps / images / inspect / stats --no-stream / info / version\uFF0C\u4E0D\u63D0\u4F9B exec\u3001restart\u3001stop\u3001rm \u7B49\u5199\u64CD\u4F5C"
      })]
    }), showImages ? /*#__PURE__*/_jsx("div", {
      style: {
        overflowX: 'auto',
        marginTop: 10
      },
      children: /*#__PURE__*/_jsxs("table", {
        className: "table",
        children: [/*#__PURE__*/_jsx("thead", {
          children: /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsx("th", {
              children: "\u955C\u50CF"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 130
              },
              children: "\u955C\u50CF ID"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 96
              },
              children: "\u5927\u5C0F"
            }), /*#__PURE__*/_jsx("th", {
              style: {
                width: 130
              },
              children: "\u521B\u5EFA\u65F6\u95F4"
            })]
          })
        }), /*#__PURE__*/_jsx("tbody", {
          children: images.map(image => /*#__PURE__*/_jsxs("tr", {
            children: [/*#__PURE__*/_jsxs("td", {
              className: "mono",
              children: [image.repository, ":", image.tag]
            }), /*#__PURE__*/_jsx("td", {
              className: "mono",
              style: {
                color: 'var(--muted)',
                fontSize: 11.5
              },
              children: image.shortId
            }), /*#__PURE__*/_jsx("td", {
              children: image.sizeText || formatBytes(image.sizeBytes)
            }), /*#__PURE__*/_jsx("td", {
              style: {
                color: 'var(--muted)'
              },
              children: image.createdSince
            })]
          }, `${image.repository}:${image.tag}`))
        })]
      })
    }) : null]
  });
}
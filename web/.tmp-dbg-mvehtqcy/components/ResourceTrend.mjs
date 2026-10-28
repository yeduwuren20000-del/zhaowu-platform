import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Icon } from './Icons.mjs';
import { Button } from './ui.mjs';
import { Sparkline, SparkStat } from './Sparkline.mjs';
import { timeAgo } from '../utils/format.js';
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
const WINDOWS = [{
  value: '1h',
  label: '1 小时'
}, {
  value: '6h',
  label: '6 小时'
}, {
  value: '24h',
  label: '24 小时'
}, {
  value: '7d',
  label: '7 天'
}];

/**
 * 资源历史趋势（第七阶段·第三轮）。
 *
 * 只展示真实采样：点数不足时明说"数据还太少"，不画假趋势；
 * 采集断档如实标出；最后一个点太旧会提示"数据不新鲜"（多半是自动采集没开）。
 */
export function ResourceTrend({
  server,
  onOpenAutoMonitor
}) {
  // 注意：不要把这个状态叫 window —— 它会遮蔽全局 window，是个踩过的坑
  const [range, setRange] = useState('24h');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(async win => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.serverHistory(server.id, win));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [server.id]);
  useEffect(() => {
    load(range);
  }, [load, range]);
  const series = data?.series || null;
  const spikes = data?.spikes || [];
  const hasData = series && series.count >= 2;
  const thresholds = data?.limits || {};
  return /*#__PURE__*/_jsxs("div", {
    className: "trend",
    children: [/*#__PURE__*/_jsxs("div", {
      className: "trend__head",
      children: [/*#__PURE__*/_jsxs("span", {
        className: "trend__title",
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "activity",
          size: 14,
          style: {
            color: 'var(--cyan)'
          }
        }), "\u5386\u53F2\u8D8B\u52BF", series?.count ? /*#__PURE__*/_jsxs("span", {
          className: "footnote",
          children: ["\uFF08", series.count, " \u4E2A\u91C7\u6837\u70B9\uFF09"]
        }) : null]
      }), /*#__PURE__*/_jsxs("div", {
        className: "row",
        style: {
          gap: 6
        },
        children: [WINDOWS.map(item => /*#__PURE__*/_jsx("button", {
          type: "button",
          className: `tab-chip ${range === item.value ? 'is-active' : ''}`,
          onClick: () => setRange(item.value),
          children: item.label
        }, item.value)), /*#__PURE__*/_jsx("button", {
          type: "button",
          className: "icon-button icon-button--sm",
          title: "\u91CD\u65B0\u8BFB\u53D6\u5386\u53F2",
          onClick: () => load(range),
          children: /*#__PURE__*/_jsx(Icon, {
            name: "refresh",
            size: 13
          })
        })]
      })]
    }), error ? /*#__PURE__*/_jsxs("div", {
      className: "footnote",
      style: {
        color: 'var(--red)'
      },
      children: ["\u8BFB\u53D6\u5386\u53F2\u5931\u8D25\uFF1A", error]
    }) : loading && !data ? /*#__PURE__*/_jsx("div", {
      className: "footnote",
      children: "\u8BFB\u53D6\u5386\u53F2\u2026"
    }) : !hasData ? /*#__PURE__*/_jsxs("div", {
      className: "trend__empty",
      children: [/*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: ["\u771F\u5B9E\u91C7\u6837\u70B9\u4E0D\u8DB3\uFF08\u5F53\u524D ", series?.count ?? 0, " \u4E2A\uFF0C\u81F3\u5C11\u9700\u8981 2 \u4E2A\u624D\u753B\u8D8B\u52BF\uFF09\u3002 \u5F00\u542F\u300C\u540E\u53F0\u81EA\u52A8\u91C7\u96C6\u300D\u540E\u4F1A\u6309\u95F4\u9694\u6301\u7EED\u79EF\u7D2F\u6570\u636E\u3002"]
      }), onOpenAutoMonitor ? /*#__PURE__*/_jsx(Button, {
        size: "sm",
        icon: "clock",
        onClick: onOpenAutoMonitor,
        children: "\u53BB\u5F00\u542F\u81EA\u52A8\u91C7\u96C6"
      }) : null]
    }) : /*#__PURE__*/_jsxs(_Fragment, {
      children: [series.stale ? /*#__PURE__*/_jsxs("div", {
        className: "trend__stale",
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "alert",
          size: 12
        }), "\u6570\u636E\u4E0D\u65B0\u9C9C\uFF1A\u6700\u540E\u4E00\u6B21\u91C7\u6837\u662F ", timeAgo(series.to), "\uFF0C\u81EA\u52A8\u91C7\u96C6\u53EF\u80FD\u5DF2\u505C\u6B62"]
      }) : null, series.gaps?.length ? /*#__PURE__*/_jsxs("div", {
        className: "trend__gaps",
        children: [/*#__PURE__*/_jsx(Icon, {
          name: "alert",
          size: 12
        }), "\u6709 ", series.gaps.length, " \u5904\u91C7\u96C6\u65AD\u6863\uFF08\u6700\u957F ", Math.round(Math.max(...series.gaps.map(g => g.ms)) / 60000), " \u5206\u949F\uFF09\uFF0C\u56FE\u4E2D\u4EE5\u865A\u7EBF\u6807\u51FA\uFF0C\u672A\u63D2\u503C\u8865\u70B9"]
      }) : null, /*#__PURE__*/_jsxs("div", {
        className: "trend__grid",
        children: [/*#__PURE__*/_jsx(TrendCell, {
          label: "CPU \u4F7F\u7528\u7387",
          metric: "cpuPercent",
          unit: "%",
          series: series,
          samples: data.samples,
          threshold: thresholds.spikeCpuPercent
        }), /*#__PURE__*/_jsx(TrendCell, {
          label: "\u5185\u5B58\u4F7F\u7528\u7387",
          metric: "memoryUsedPercent",
          unit: "%",
          series: series,
          samples: data.samples,
          threshold: thresholds.spikeMemoryPercent
        }), /*#__PURE__*/_jsx(TrendCell, {
          label: "\u8D1F\u8F7D (1m)",
          metric: "load1",
          unit: "",
          series: series,
          samples: data.samples
        }), /*#__PURE__*/_jsx(TrendCell, {
          label: "\u6839\u78C1\u76D8\u4F7F\u7528\u7387",
          metric: "diskUsedPercent",
          unit: "%",
          series: series,
          samples: data.samples
        }), /*#__PURE__*/_jsx(TrendCell, {
          label: "\u5BB9\u5668 CPU \u5408\u8BA1",
          metric: "containerCpuPercent",
          unit: "%",
          series: series,
          samples: data.samples
        }), /*#__PURE__*/_jsx(TrendCell, {
          label: "\u5BB9\u5668\u5185\u5B58",
          metric: "containerMemoryBytes",
          unit: "",
          bytes: true,
          series: series,
          samples: data.samples
        })]
      })]
    }), spikes.length > 0 ? /*#__PURE__*/_jsxs("div", {
      className: "trend__spikes",
      children: [/*#__PURE__*/_jsxs("div", {
        className: "footnote",
        style: {
          marginBottom: 4
        },
        children: ["\u5C16\u5CF0\u8BB0\u5F55\uFF08\u540C\u4E00\u6307\u6807 ", Math.round((thresholds.spikeCooldownMs || 0) / 60000), " \u5206\u949F\u5185\u53EA\u8BB0\u4E00\u6B21\uFF09"]
      }), spikes.slice(0, 6).map((spike, index) => /*#__PURE__*/_jsxs("div", {
        className: "trend__spike",
        children: [/*#__PURE__*/_jsx("span", {
          className: "tech",
          children: timeAgo(spike.at)
        }), /*#__PURE__*/_jsx("span", {
          className: `status-word ${spike.metric === 'cpu' ? 'is-warn' : 'is-error'}`,
          children: spike.metric === 'cpu' ? 'CPU' : spike.metric === 'memory' ? '内存' : spike.metric
        }), /*#__PURE__*/_jsx("span", {
          className: "footnote",
          children: spike.message
        })]
      }, `${spike.at}-${spike.metric}-${index}`))]
    }) : null]
  });
}
function TrendCell({
  label,
  metric,
  unit,
  series,
  samples,
  threshold = null,
  bytes = false
}) {
  const stats = series?.stats?.[metric];
  return /*#__PURE__*/_jsxs("div", {
    className: "trend__cell",
    children: [/*#__PURE__*/_jsx(SparkStat, {
      label: label,
      stats: stats,
      unit: unit,
      threshold: threshold,
      bytes: bytes
    }), /*#__PURE__*/_jsx(Sparkline, {
      samples: samples,
      gaps: series?.gaps,
      metric: metric,
      threshold: threshold,
      unit: unit,
      label: label
    })]
  });
}
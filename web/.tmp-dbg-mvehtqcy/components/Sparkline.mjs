import { useMemo } from 'react';
import { formatBytes } from '../utils/format.js';

/**
 * 迷你趋势线（第七阶段·第三轮）。
 *
 * 三条硬性约束：
 *  1. **只画真实采样点**：不足 2 个点就不画线，改说"数据还太少"，绝不画一条假直线装成有趋势；
 *  2. **断档如实断开**：两次采样之间空档过大时把线切断（后端 series.gaps 给出空档位置），
 *     不用插值把断档连起来；
 *  3. 纯 SVG 单色描边，**不使用渐变 / 面积填充动画 / 毛玻璃**（与本项目"去 AI 味"口径一致）。
 */
import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
export function Sparkline({
  samples = [],
  gaps = [],
  metric,
  height = 42,
  threshold = null,
  unit = '%',
  label = ''
}) {
  const model = useMemo(() => buildModel(samples, gaps, metric), [samples, gaps, metric]);
  if (!model || model.segments.length === 0) {
    return /*#__PURE__*/_jsx("div", {
      className: "trendline-empty",
      title: `${label}：真实采样点不足`,
      children: /*#__PURE__*/_jsxs("span", {
        className: "footnote",
        children: [label ? `${label}：` : '', "\u91C7\u6837\u70B9\u4E0D\u8DB3\uFF0C\u6682\u4E0D\u7ED8\u5236\u8D8B\u52BF"]
      })
    });
  }
  const {
    points,
    segments,
    min,
    max,
    span,
    width,
    slots
  } = model;
  const H = height;
  const PAD = 3;
  const scaleY = value => {
    if (span <= 0) return H / 2;
    return PAD + (1 - (value - min) / span) * (H - PAD * 2);
  };
  // 按原始采样槽位定位：时间轴是等间隔采样，槽位差 = 时间差
  const scaleX = slot => slots <= 0 ? width / 2 : slot / slots * width;

  // 阈值线：只有传了阈值才画，不虚构参考线
  const thresholdY = threshold !== null && threshold !== undefined && threshold >= min && threshold <= max ? scaleY(threshold) : null;
  return /*#__PURE__*/_jsxs("svg", {
    className: "trendline",
    viewBox: `0 0 ${width} ${H}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `${label} 趋势，${points.length} 个采样点，最低 ${fmt(min, unit)}，最高 ${fmt(max, unit)}`,
    children: [/*#__PURE__*/_jsx("line", {
      x1: "0",
      y1: H - PAD,
      x2: width,
      y2: H - PAD,
      className: "trendline__axis",
      strokeWidth: "1",
      vectorEffect: "non-scaling-stroke"
    }), thresholdY !== null ? /*#__PURE__*/_jsx("line", {
      x1: "0",
      y1: thresholdY,
      x2: width,
      y2: thresholdY,
      className: "trendline__threshold",
      strokeWidth: "1",
      strokeDasharray: "3 3",
      vectorEffect: "non-scaling-stroke"
    }) : null, segments.map((segment, index) => {
      if (segment.length < 2) return null;
      const d = segment.map((point, i) => `${i === 0 ? 'M' : 'L'}${scaleX(point.slot).toFixed(2)},${scaleY(point.value).toFixed(2)}`).join(' ');
      return /*#__PURE__*/_jsx("path", {
        d: d,
        className: "trendline__line",
        fill: "none",
        strokeWidth: "1.6",
        vectorEffect: "non-scaling-stroke"
      }, index);
    }), segments.map(segment => segment.length === 1 ? /*#__PURE__*/_jsx("circle", {
      cx: scaleX(segment[0].slot),
      cy: scaleY(segment[0].value),
      r: "1.8",
      className: "trendline__dot"
    }, `iso-${segment[0].slot}`) : null), model.gapMarks.map(mark => /*#__PURE__*/_jsx("line", {
      x1: scaleX(mark.slot),
      y1: PAD,
      x2: scaleX(mark.slot),
      y2: H - PAD,
      className: "trendline__gap",
      strokeWidth: "1",
      strokeDasharray: "2 3",
      vectorEffect: "non-scaling-stroke"
    }, `gap-${mark.slot}`)), /*#__PURE__*/_jsx("circle", {
      cx: scaleX(points[points.length - 1].slot),
      cy: scaleY(points[points.length - 1].value),
      r: "2.2",
      className: "trendline__last"
    })]
  });
}
function fmt(value, unit) {
  if (value === null || value === undefined) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

/**
 * 把采样点整理成可画的模型。
 *
 * x 轴按**原始采样序号**定位（不是"该指标第几个有效点"）：
 * 某项指标在中间几个采样里缺失时，如果用过滤后的下标，等于假装时间轴是均匀的，
 * 会把空洞画成连续线。这里按原始槽位定位，并在空洞处切断。
 */
function buildModel(samples, gaps, metric) {
  const list = samples || [];
  const gapFroms = new Set((gaps || []).map(gap => gap.from));
  const points = [];
  for (let slot = 0; slot < list.length; slot += 1) {
    const value = list[slot]?.[metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue; // 这一项没采到：跳过，绝不当成 0
    points.push({
      at: list[slot].at,
      slot,
      value
    });
  }
  if (points.length < 2) return null;
  const values = points.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const segments = [];
  let current = [points[0]];
  const gapMarks = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    // 后端标出的采集断档，或该指标自身在中间缺采样 -> 都要切断
    const broken = gapFroms.has(prev.at) || cur.slot - prev.slot > 1;
    if (broken) {
      segments.push(current);
      current = [cur];
      gapMarks.push({
        slot: (prev.slot + cur.slot) / 2
      });
    } else {
      current.push(cur);
    }
  }
  segments.push(current);
  return {
    points,
    segments,
    min,
    max,
    span: max - min,
    width: 120,
    slots: Math.max(1, list.length - 1),
    gapMarks
  };
}

/** 一行统计摘要（与趋势线配套，避免出现"只有图没有数"） */
export function SparkStat({
  label,
  stats,
  unit = '%',
  threshold = null,
  bytes = false
}) {
  const show = value => bytes ? formatBytes(value) : fmt(value, unit);
  if (!stats) {
    return /*#__PURE__*/_jsxs("div", {
      className: "trendline-stat",
      children: [/*#__PURE__*/_jsx("span", {
        className: "trendline-stat__label",
        children: label
      }), /*#__PURE__*/_jsx("span", {
        className: "footnote",
        children: "\u672A\u91C7\u96C6"
      })]
    });
  }
  const tone = threshold !== null && stats.max >= threshold ? 'is-warn' : '';
  return /*#__PURE__*/_jsxs("div", {
    className: `trendline-stat ${tone}`,
    children: [/*#__PURE__*/_jsxs("div", {
      className: "trendline-stat__head",
      children: [/*#__PURE__*/_jsx("span", {
        className: "trendline-stat__label",
        children: label
      }), /*#__PURE__*/_jsxs("span", {
        className: "trendline-stat__last",
        children: ["\u5F53\u524D ", /*#__PURE__*/_jsx("b", {
          children: show(stats.last)
        })]
      })]
    }), /*#__PURE__*/_jsxs("div", {
      className: "trendline-stat__nums",
      children: [/*#__PURE__*/_jsxs("span", {
        children: ["\u6700\u4F4E ", /*#__PURE__*/_jsx("b", {
          children: show(stats.min)
        })]
      }), /*#__PURE__*/_jsxs("span", {
        children: ["\u6700\u9AD8 ", /*#__PURE__*/_jsx("b", {
          children: show(stats.max)
        })]
      }), /*#__PURE__*/_jsxs("span", {
        children: ["\u5747\u503C ", /*#__PURE__*/_jsx("b", {
          children: show(stats.avg)
        })]
      }), /*#__PURE__*/_jsxs("span", {
        className: "muted",
        children: [stats.samples, " \u70B9"]
      })]
    })]
  });
}
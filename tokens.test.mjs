/**
 * 校验 design-tokens.css 里的每一个允许的「前景 / 背景」组合是否达到 WCAG AA。
 *
 *   node tokens.test.mjs
 *
 * 这个脚本解析 CSS 文件本身，而不是一份手抄的副本——
 * 所以改了令牌忘了复验时，它会直接失败。
 */

import { readFile } from "node:fs/promises";

const AA_TEXT = 4.5; // 正文与小字
const AA_UI = 3.0; // 图标、边框等非文字信息

/* ---------- 对比度 ---------- */

const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex) => {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
};

/* ---------- 解析 design-tokens.css ---------- */

/** 抽出一个选择器块里的令牌。深色块取第一个 [data-theme="dark"]。 */
function extractBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`找不到选择器：${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const tokens = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    tokens[name] = value.toUpperCase();
  }
  return tokens;
}

/* ---------- 允许的组合 ----------
   每一条都对应色板注释里写明的使用规则。
   如果某个组合不在这张表里，就是不允许出现在界面上的。 */

const TEXT_ON = {
  text: ["bg", "surface", "surface-sunken", "insight-tint"],
  "text-soft": ["bg", "surface", "surface-sunken"],
  "text-faint": ["bg", "surface", "surface-sunken"],
  // 只用于品牌色填充块。深色导航区【不用】这个令牌——见 --chrome-text。
  "text-on-fill": ["brand", "brand-hover"],
  brand: ["bg", "surface", "surface-sunken", "brand-tint"],
  "insight-text": ["bg", "surface", "insight-tint"],
  verified: ["bg", "surface", "verified-tint"],
  risk: ["bg", "surface", "risk-tint"],
  "chrome-text": ["chrome", "chrome-hover"],
  "chrome-text-dim": ["chrome", "chrome-hover"],
};

/** 非文字：图标与有信息含义的边框。--insight 允许做图标，但不允许做文字。 */
const UI_ON = {
  insight: ["bg", "surface"],
};

/* ---------- 执行 ---------- */

const css = await readFile(new URL("./design-tokens.css", import.meta.url), "utf8");
const modes = {
  浅色: extractBlock(css, ":root {"),
  深色: extractBlock(css, ':root[data-theme="dark"]'),
};

const failures = [];
let checked = 0;

for (const [modeName, tokens] of Object.entries(modes)) {
  console.log(`\n===== ${modeName} =====`);

  for (const [table, threshold] of [
    [TEXT_ON, AA_TEXT],
    [UI_ON, AA_UI],
  ]) {
    for (const [fg, backgrounds] of Object.entries(table)) {
      for (const bg of backgrounds) {
        if (!tokens[fg]) throw new Error(`${modeName} 缺少令牌 --${fg}`);
        if (!tokens[bg]) throw new Error(`${modeName} 缺少令牌 --${bg}`);
        const ratio = contrast(tokens[fg], tokens[bg]);
        const pass = ratio >= threshold;
        checked += 1;
        if (!pass) failures.push({ modeName, fg, bg, ratio, threshold });
        console.log(
          `  ${pass ? "ok  " : "FAIL"} --${fg.padEnd(16)} on --${bg.padEnd(15)} ` +
            `${ratio.toFixed(2).padStart(6)}  (需 ${threshold})`,
        );
      }
    }
  }

  // 深色与浅色必须定义完全相同的令牌集合，否则切主题会掉色。
  const light = Object.keys(modes["浅色"]).sort().join(",");
  const dark = Object.keys(modes["深色"]).sort().join(",");
  if (light !== dark) failures.push({ modeName: "两套主题", fg: "令牌集合", bg: "不一致", ratio: 0, threshold: 0 });
}

/* ---------- 样式表引用的令牌必须真实存在 ----------
   CSS 引用一个未定义的变量不会报错，只会静默继承父级值。
   `.invite-error` 曾经写成 var(--danger)（色板里只有 --risk），
   于是邀请码报错一直是普通灰字，没人发现。 */

const styles = await readFile(new URL("./src/styles.css", import.meta.url), "utf8");
// styles.css 自己的 :root 里还有 --shadow / --sans 这类非颜色令牌
const defined = new Set([
  ...Object.keys(modes["浅色"]),
  ...[...styles.matchAll(/^\s*--([\w-]+)\s*:/gm)].map(([, name]) => name),
]);
const referenced = new Set([...styles.matchAll(/var\(\s*--([\w-]+)/g)].map(([, name]) => name));
const missing = [...referenced].filter((name) => !defined.has(name));

console.log(`\n样式表引用了 ${referenced.size} 个令牌，其中未定义 ${missing.length} 个。`);

console.log(`\n共校验 ${checked} 组组合。`);

if (failures.length > 0) {
  console.error(`\n${failures.length} 组未达标：`);
  for (const f of failures) {
    console.error(`  ${f.modeName}  --${f.fg} on --${f.bg}: ${f.ratio.toFixed(2)} < ${f.threshold}`);
  }
}

if (missing.length > 0) {
  console.error(`\n样式表引用了未定义的令牌：${missing.map((n) => `--${n}`).join("、")}`);
}

if (failures.length > 0 || missing.length > 0) process.exit(1);

console.log("全部达到 WCAG AA，两套主题令牌集合一致，且样式表没有引用未定义的令牌。");
